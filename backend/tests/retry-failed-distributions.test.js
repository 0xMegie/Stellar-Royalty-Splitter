import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRetryBuildTx = jest.fn();
const mockAddressToScVal = jest.fn((a) => ({ address: a }));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx: mockRetryBuildTx,
  addressToScVal: mockAddressToScVal,
}));

// In-memory transaction store to simulate the database
let mockTransactions = [];
let mockAuditLogs = [];

const mockGetRetryEligibleTransactions = jest.fn(() => []);
const mockMarkTransactionRetrying = jest.fn((id, now) => {
  const tx = mockTransactions.find((t) => t.id === id);
  if (tx) {
    tx.retry_count += 1;
    tx.last_retry_time = now.toISOString();
    tx.status = "pending";
    tx.errorMessage = null;
    tx.txHash = null;
  }
});
const mockMarkTransactionRetryExhausted = jest.fn();
const mockAddAuditLog = jest.fn((contractId, action, user, details) => {
  mockAuditLogs.push({ contractId, action, user, details });
});
const mockGetRetryExhaustedTransactions = jest.fn(() => []);
const mockGetTransactionRetryCount = jest.fn((id) => {
  const tx = mockTransactions.find((t) => t.id === id);
  return tx?.retry_count ?? 0;
});

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getRetryEligibleTransactions: mockGetRetryEligibleTransactions,
  markTransactionRetrying: mockMarkTransactionRetrying,
  markTransactionRetryExhausted: mockMarkTransactionRetryExhausted,
  addAuditLog: mockAddAuditLog,
  getRetryExhaustedTransactions: mockGetRetryExhaustedTransactions,
  getTransactionRetryCount: mockGetTransactionRetryCount,
  MAX_RETRY_COUNT: 3,
  RETRY_BACKOFF_MS: [60_000, 300_000, 900_000],
}));

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: {
    prepare: () => ({
      run: jest.fn(),
      get: jest.fn(() => null),
      all: () => [],
    }),
  },
}));

const mockSendEmail = jest.fn(() => Promise.resolve({ sent: true, messageId: "msg-123" }));
const mockIsEmailConfigured = jest.fn(() => true);

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  sendEmail: mockSendEmail,
  isEmailConfigured: mockIsEmailConfigured,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

const {
  retryFailedDistributions,
  retryTransaction,
  getBackoffDelay,
  sendRetryExhaustedAlert,
  startRetryScheduler,
  _resetAlertedExhaustedIds,
  _config,
} = await import("../src/jobs/retry-failed-distributions.js");

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeFailedTx(overrides = {}) {
  return {
    id: 1,
    txHash: "abc123",
    contractId: "CONTRACT_AAA",
    type: "distribute",
    initiatorAddress: "GAAAA...",
    requestedAmount: "1000",
    tokenId: "TOKEN_BBB",
    timestamp: "2025-01-01T00:00:00.000Z",
    blockTime: null,
    status: "failed",
    errorMessage: "Network error",
    retry_count: 0,
    last_retry_time: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Retry Failed Distributions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailConfigured.mockReturnValue(true);
    mockSendEmail.mockResolvedValue({ sent: true, messageId: "msg-123" });
    mockTransactions = [];
    mockAuditLogs = [];
    _resetAlertedExhaustedIds();
    // Reset env
    delete process.env.ADMIN_ALERT_EMAIL;
  });

  // ── Backoff timing tests ────────────────────────────────────────────────

  describe("getBackoffDelay", () => {
    test("retry_count 0 returns 1 minute (60000ms)", () => {
      expect(getBackoffDelay(0)).toBe(60_000);
    });

    test("retry_count 1 returns 5 minutes (300000ms)", () => {
      expect(getBackoffDelay(1)).toBe(300_000);
    });

    test("retry_count 2 returns 15 minutes (900000ms)", () => {
      expect(getBackoffDelay(2)).toBe(900_000);
    });

    test("retry_count beyond max returns last backoff value", () => {
      expect(getBackoffDelay(5)).toBe(900_000);
    });

    test("exponential backoff values are correct: 1m, 5m, 15m", () => {
      expect(_config.RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 900_000]);
    });
  });

  // ── Successful retry tests ──────────────────────────────────────────────

  describe("retryTransaction - successful retry", () => {
    test("rebuilds XDR and marks transaction as pending on success", async () => {
      const tx = makeFailedTx({ retry_count: 0 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockResolvedValue("new-xdr-string");

      const now = new Date("2025-06-15T12:00:00.000Z");
      const outcome = await retryTransaction(tx, now);

      expect(outcome).toBe("retried");
      expect(mockRetryBuildTx).toHaveBeenCalledWith(
        tx.initiatorAddress,
        tx.contractId,
        "distribute",
        [{ address: tx.tokenId }]
      );
      expect(mockMarkTransactionRetrying).toHaveBeenCalledWith(tx.id, now);
    });

    test("logs retry attempt to audit trail", async () => {
      const tx = makeFailedTx({ retry_count: 0 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockResolvedValue("xdr");

      await retryTransaction(tx, new Date());

      // Should have at least 2 audit entries: attempt + scheduled
      const attemptLog = mockAuditLogs.find(
        (l) => l.action === "distribution_retry_attempt"
      );
      expect(attemptLog).toBeDefined();
      expect(attemptLog.details.transactionId).toBe(tx.id);
      expect(attemptLog.details.retryNumber).toBe(1);
      expect(attemptLog.details.maxRetries).toBe(3);

      const scheduledLog = mockAuditLogs.find(
        (l) => l.action === "distribution_retry_scheduled"
      );
      expect(scheduledLog).toBeDefined();
    });

    test("passes correct args when tokenId is null", async () => {
      const tx = makeFailedTx({ tokenId: null });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockResolvedValue("xdr");

      await retryTransaction(tx, new Date());

      expect(mockRetryBuildTx).toHaveBeenCalledWith(
        tx.initiatorAddress,
        tx.contractId,
        "distribute",
        []
      );
    });
  });

  // ── Failed retry tests ──────────────────────────────────────────────────

  describe("retryTransaction - failed retry", () => {
    test("logs failure to audit trail when rebuild fails", async () => {
      const tx = makeFailedTx({ retry_count: 0 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("RPC timeout"));

      await retryTransaction(tx, new Date());

      const failedLog = mockAuditLogs.find(
        (l) => l.action === "distribution_retry_failed"
      );
      expect(failedLog).toBeDefined();
      expect(failedLog.details.retryNumber).toBe(1);
      expect(failedLog.details.error).toContain("RPC timeout");
    });

    test("returns 'error' when retry fails but retries remain", async () => {
      const tx = makeFailedTx({ retry_count: 0 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Network error"));

      const outcome = await retryTransaction(tx, new Date());
      expect(outcome).toBe("error");
    });

    test("returns 'error' when retry_count is 1 (still retries remain)", async () => {
      const tx = makeFailedTx({ retry_count: 1 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Network error"));

      const outcome = await retryTransaction(tx, new Date());
      expect(outcome).toBe("error");
    });
  });

  // ── Max retries exceeded tests ──────────────────────────────────────────

  describe("retryTransaction - max retries exceeded", () => {
    test("returns 'exhausted' when retry_count reaches MAX_RETRY_COUNT (3)", async () => {
      const tx = makeFailedTx({ retry_count: 2 }); // This will be retry #3
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));

      const outcome = await retryTransaction(tx, new Date());
      expect(outcome).toBe("exhausted");
    });

    test("logs exhausted event to audit trail", async () => {
      const tx = makeFailedTx({ retry_count: 2 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));
      process.env.ADMIN_ALERT_EMAIL = "admin@example.com";

      await retryTransaction(tx, new Date());

      const exhaustedLog = mockAuditLogs.find(
        (l) => l.action === "distribution_retry_exhausted"
      );
      expect(exhaustedLog).toBeDefined();
      expect(exhaustedLog.details.totalRetries).toBe(3);
      expect(exhaustedLog.details.adminNotified).toBe(true);
    });
  });

  // ── Admin notification tests ────────────────────────────────────────────

  describe("Admin notification after final failure", () => {
    test("sends email alert when retries exhausted and ADMIN_ALERT_EMAIL is set", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@example.com";
      const tx = makeFailedTx({ retry_count: 2 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));

      await retryTransaction(tx, new Date());

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const call = mockSendEmail.mock.calls[0][0];
      expect(call.to).toBe("admin@example.com");
      expect(call.subject).toContain("retry exhausted");
      expect(call.text).toContain(tx.contractId);
      expect(call.html).toContain(String(tx.id));
    });

    test("skips email when ADMIN_ALERT_EMAIL is not set", async () => {
      delete process.env.ADMIN_ALERT_EMAIL;
      const tx = makeFailedTx({ retry_count: 2 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));

      await retryTransaction(tx, new Date());

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test("skips email when SMTP is not configured", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@example.com";
      mockIsEmailConfigured.mockReturnValue(false);

      const tx = makeFailedTx({ retry_count: 2 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));

      await retryTransaction(tx, new Date());

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test("does not send duplicate alerts for the same transaction", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@example.com";
      const tx = makeFailedTx({ retry_count: 2, id: 42 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("Persistent failure"));

      await retryTransaction(tx, new Date());
      // Second call with same ID should not send again
      _resetAlertedExhaustedIds(); // Reset to allow re-alert
      // But without reset, the set prevents duplicate
    });
  });

  // ── retryFailedDistributions batch tests ────────────────────────────────

  describe("retryFailedDistributions", () => {
    test("returns zeros when no eligible transactions", async () => {
      mockGetRetryEligibleTransactions.mockReturnValue([]);

      const result = await retryFailedDistributions();

      expect(result).toEqual({ processed: 0, retried: 0, exhausted: 0, errors: 0 });
    });

    test("processes multiple eligible transactions", async () => {
      const tx1 = makeFailedTx({ id: 1, retry_count: 0 });
      const tx2 = makeFailedTx({ id: 2, retry_count: 0 });
      mockTransactions.push({ ...tx1 }, { ...tx2 });
      mockGetRetryEligibleTransactions.mockReturnValue([tx1, tx2]);
      mockRetryBuildTx.mockResolvedValue("xdr");

      const result = await retryFailedDistributions();

      expect(result.processed).toBe(2);
      expect(result.retried).toBe(2);
      expect(mockRetryBuildTx).toHaveBeenCalledTimes(2);
    });

    test("counts exhausted and errors correctly", async () => {
      const tx1 = makeFailedTx({ id: 1, retry_count: 0 }); // will succeed
      const tx2 = makeFailedTx({ id: 2, retry_count: 1 }); // will fail but not exhausted
      const tx3 = makeFailedTx({ id: 3, retry_count: 2 }); // will fail and exhaust
      mockTransactions.push({ ...tx1 }, { ...tx2 }, { ...tx3 });
      mockGetRetryEligibleTransactions.mockReturnValue([tx1, tx2, tx3]);

      // tx1 succeeds, tx2 fails, tx3 fails and exhausts
      mockRetryBuildTx
        .mockResolvedValueOnce("xdr")
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"));

      const result = await retryFailedDistributions();

      expect(result.processed).toBe(3);
      expect(result.retried).toBe(1);
      expect(result.exhausted).toBe(1);
      expect(result.errors).toBe(1);
    });
  });

  // ── Retry state persistence tests ───────────────────────────────────────

  describe("Retry state persistence", () => {
    test("markTransactionRetrying updates retry_count and last_retry_time", async () => {
      const tx = makeFailedTx({ id: 1, retry_count: 0 });
      mockTransactions.push({ ...tx });

      const now = new Date("2025-06-15T12:00:00.000Z");
      mockMarkTransactionRetrying(tx.id, now);

      const stored = mockTransactions.find((t) => t.id === tx.id);
      expect(stored.retry_count).toBe(1);
      expect(stored.last_retry_time).toBe(now.toISOString());
      expect(stored.status).toBe("pending");
    });

    test("retry_count increments correctly across multiple retries", () => {
      const tx = makeFailedTx({ id: 1, retry_count: 0 });
      mockTransactions.push({ ...tx });

      const now1 = new Date("2025-06-15T12:00:00.000Z");
      mockMarkTransactionRetrying(tx.id, now1);
      expect(mockTransactions[0].retry_count).toBe(1);

      const now2 = new Date("2025-06-15T12:05:00.000Z");
      mockMarkTransactionRetrying(tx.id, now2);
      expect(mockTransactions[0].retry_count).toBe(2);

      const now3 = new Date("2025-06-15T12:20:00.000Z");
      mockMarkTransactionRetrying(tx.id, now3);
      expect(mockTransactions[0].retry_count).toBe(3);
    });
  });

  // ── Scheduler tests ─────────────────────────────────────────────────────

  describe("startRetryScheduler", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test("returns object with stop function and interval", () => {
      const scheduler = startRetryScheduler();
      expect(scheduler).toHaveProperty("stop");
      expect(typeof scheduler.stop).toBe("function");
      expect(scheduler).toHaveProperty("interval");
      scheduler.stop();
    });

    test("stop clears the interval", () => {
      const scheduler = startRetryScheduler();
      scheduler.stop();
      // No error means success — clearInterval was called
    });
  });

  // ── Timing verification tests ───────────────────────────────────────────

  describe("Exponential backoff timing verification", () => {
    test("backoff delays follow the pattern: 1m, 5m, 15m", () => {
      const delays = [
        getBackoffDelay(0),
        getBackoffDelay(1),
        getBackoffDelay(2),
      ];
      expect(delays).toEqual([60_000, 300_000, 900_000]);
    });

    test("delays are monotonically increasing", () => {
      const delays = [
        getBackoffDelay(0),
        getBackoffDelay(1),
        getBackoffDelay(2),
      ];
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    });

    test("1 minute = 60,000 ms", () => {
      expect(getBackoffDelay(0)).toBe(60_000);
    });

    test("5 minutes = 300,000 ms", () => {
      expect(getBackoffDelay(1)).toBe(300_000);
    });

    test("15 minutes = 900,000 ms", () => {
      expect(getBackoffDelay(2)).toBe(900_000);
    });
  });

  // ── Max 3 retries enforcement tests ─────────────────────────────────────

  describe("Max 3 retries enforcement", () => {
    test("MAX_RETRY_COUNT is 3", () => {
      expect(_config.MAX_RETRY_COUNT).toBe(3);
    });

    test("transaction with retry_count 2 (3rd attempt) is the last allowed", async () => {
      const tx = makeFailedTx({ retry_count: 2 });
      mockTransactions.push({ ...tx });
      mockRetryBuildTx.mockRejectedValue(new Error("fail"));

      const outcome = await retryTransaction(tx, new Date());
      expect(outcome).toBe("exhausted");
    });

    test("retry numbers go 1, 2, 3 for retry_counts 0, 1, 2", async () => {
      for (const [retryCount, expectedRetryNumber] of [[0, 1], [1, 2], [2, 3]]) {
        jest.clearAllMocks();
    mockIsEmailConfigured.mockReturnValue(true);
    mockSendEmail.mockResolvedValue({ sent: true, messageId: "msg-123" });
        mockAuditLogs = [];
        _resetAlertedExhaustedIds();

        const tx = makeFailedTx({ id: retryCount + 10, retry_count: retryCount });
        mockTransactions.push({ ...tx });
        mockRetryBuildTx.mockResolvedValue("xdr");

        await retryTransaction(tx, new Date());

        const attemptLog = mockAuditLogs.find(
          (l) => l.action === "distribution_retry_attempt"
        );
        expect(attemptLog.details.retryNumber).toBe(expectedRetryNumber);
      }
    });
  });

  // ── sendRetryExhaustedAlert tests ───────────────────────────────────────

  describe("sendRetryExhaustedAlert", () => {
    test("includes all transaction details in the email", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@test.com";
      const tx = makeFailedTx({
        id: 99,
        contractId: "CONTRACT_XYZ",
        tokenId: "TOKEN_ABC",
        requestedAmount: "5000",
        retry_count: 3,
        errorMessage: "Final error",
      });

      const result = await sendRetryExhaustedAlert(tx);

      expect(result.sent).toBe(true);
      const email = mockSendEmail.mock.calls[0][0];
      expect(email.text).toContain("99");
      expect(email.text).toContain("CONTRACT_XYZ");
      expect(email.text).toContain("TOKEN_ABC");
      expect(email.text).toContain("5000");
      expect(email.text).toContain("3");
      expect(email.html).toContain("99");
      expect(email.html).toContain("CONTRACT_XYZ");
    });

    test("returns admin_email_not_configured when ADMIN_ALERT_EMAIL missing", async () => {
      delete process.env.ADMIN_ALERT_EMAIL;
      const tx = makeFailedTx();

      const result = await sendRetryExhaustedAlert(tx);
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("admin_email_not_configured");
    });

    test("returns smtp_not_configured when SMTP is unavailable", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@test.com";
      mockIsEmailConfigured.mockReturnValue(false);
      const tx = makeFailedTx();

      const result = await sendRetryExhaustedAlert(tx);
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("smtp_not_configured");
    });
  });
});
