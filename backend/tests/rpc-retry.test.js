/**
 * Tests for centralized RPC retry handler.
 * Covers transient/permanent error detection, backoff calculation, and retry behavior.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock logger before importing rpc-retry
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: mockLogger,
}));

// Now import rpc-retry after logger is mocked
const {
  isTransientError,
  getBackoffDelay,
  logRetryAttempt,
  logRetryExhausted,
  logRetrySuccess,
  withRetry,
  retryConfig,
  retryMetrics,
} = await import("../src/rpc-retry.js");

describe("RPC Retry Handler", () => {
  beforeEach(() => {
    retryMetrics.reset();
  });

  // ─── isTransientError Tests ────────────────────────────────────────────────

  describe("isTransientError", () => {
    describe("HTTP status codes", () => {
      test("identifies 429 (rate limit) as transient", () => {
        const result = isTransientError({ status: 429 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("rate_limit");
        expect(result.retryable).toBe(true);
      });

      test("identifies 503 (service unavailable) as transient", () => {
        const result = isTransientError({ status: 503 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("service_unavailable");
      });

      test("identifies 504 (gateway timeout) as transient", () => {
        const result = isTransientError({ status: 504 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("gateway_timeout");
      });

      test("identifies 408 (request timeout) as transient", () => {
        const result = isTransientError({ status: 408 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("request_timeout");
      });

      test("identifies 400 (bad request) as permanent", () => {
        const result = isTransientError({ status: 400 });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("permanent_client_error");
        expect(result.retryable).toBe(false);
      });

      test("identifies 401 (unauthorized) as permanent", () => {
        const result = isTransientError({ status: 401 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });

      test("identifies 403 (forbidden) as permanent", () => {
        const result = isTransientError({ status: 403 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });

      test("identifies 404 (not found) as permanent", () => {
        const result = isTransientError({ status: 404 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });
    });

    describe("Network errors", () => {
      test("identifies ENOTFOUND as transient", () => {
        const result = isTransientError({ code: "ENOTFOUND" });
        expect(result.isTransient).toBe(true);
        expect(result.category).toBe("network_ENOTFOUND");
      });

      test("identifies ECONNREFUSED as transient", () => {
        const result = isTransientError({ code: "ECONNREFUSED" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies ETIMEDOUT as transient", () => {
        const result = isTransientError({ code: "ETIMEDOUT" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies EHOSTUNREACH as transient", () => {
        const result = isTransientError({ code: "EHOSTUNREACH" });
        expect(result.isTransient).toBe(true);
      });
    });

    describe("Message patterns", () => {
      test("identifies timeout message as transient", () => {
        const result = isTransientError({ message: "Request timed out after 5000ms" });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("network_error_from_message");
      });

      test("identifies network message as transient", () => {
        const result = isTransientError({ message: "Network error occurred" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies simulation error as permanent", () => {
        const result = isTransientError({ message: "Simulation failed: contract error" });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("simulation_error");
      });

      test("identifies contract error as permanent", () => {
        const result = isTransientError({
          message: "Contract invocation failed",
        });
        expect(result.isTransient).toBe(false);
      });

      test("identifies account not found as permanent", () => {
        const result = isTransientError({
          message: "Account not found on Stellar network",
        });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("account_not_found");
      });
    });

    describe("Structured error formats", () => {
      test("handles response.status format", () => {
        const result = isTransientError({
          response: { status: 429 },
        });
        expect(result.isTransient).toBe(true);
      });

      test("handles code field", () => {
        const result = isTransientError({
          response: { status: 503 },
          code: "SERVICE_UNAVAILABLE",
        });
        expect(result.isTransient).toBe(true);
      });
    });

    describe("Edge cases", () => {
      test("returns false for null error", () => {
        const result = isTransientError(null);
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("unknown_error");
      });

      test("returns false for empty object", () => {
        const result = isTransientError({});
        expect(result.isTransient).toBe(false);
      });

      test("includes operationType in analysis", () => {
        const result = isTransientError({ message: "error" }, "submitTransaction");
        expect(result.isTransient).toBe(false);
      });
    });
  });

  // ─── getBackoffDelay Tests ──────────────────────────────────────────────

  describe("getBackoffDelay", () => {
    test("returns base backoff for first retry", () => {
      const delay = getBackoffDelay(1);
      expect(delay).toBeGreaterThanOrEqual(retryConfig.baseBackoffMs * 0.9);
      expect(delay).toBeLessThanOrEqual(retryConfig.baseBackoffMs * 1.1);
    });

    test("exponentially increases delay", () => {
      const delay1 = getBackoffDelay(1);
      const delay2 = getBackoffDelay(2);
      const delay3 = getBackoffDelay(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });

    test("respects max backoff cap", () => {
      const delay = getBackoffDelay(10);
      expect(delay).toBeLessThanOrEqual(retryConfig.maxBackoffMs);
    });

    test("applies jitter consistently", () => {
      // Multiple calls should have slight variations due to jitter
      const delays = [getBackoffDelay(1), getBackoffDelay(1), getBackoffDelay(1)];

      const allSame = delays.every((d) => d === delays[0]);
      expect(allSame).toBe(false); // Very unlikely with jitter
    });

    test("respects custom config", () => {
      const customConfig = {
        baseBackoffMs: 500,
        maxBackoffMs: 5000,
      };
      const delay = getBackoffDelay(1, customConfig);
      expect(delay).toBeGreaterThanOrEqual(450);
      expect(delay).toBeLessThanOrEqual(550);
    });
  });

  // ─── Logging Functions Tests ────────────────────────────────────────────

  describe("Logging functions", () => {
    test("logRetryAttempt logs safe information", () => {
      mockLogger.warn.mockClear();
      logRetryAttempt({
        attemptNumber: 1,
        totalAttempts: 3,
        operationType: "getAccount",
        error: { status: 503 },
        delayMs: 1000,
        details: { walletAddress: "G..." },
      });

      expect(mockLogger.warn).toHaveBeenCalled();
      const output = mockLogger.warn.mock.calls[0][1];
      expect(output.event).toBe("rpc_retry_attempt");
      expect(output.attemptNumber).toBe(1);
      expect(output.errorReason).toBe("service_unavailable");
    });

    test("logRetryExhausted logs exhaustion event", () => {
      mockLogger.error.mockClear();
      logRetryExhausted({
        operationType: "getAccount",
        totalAttempts: 3,
        lastError: { status: 503 },
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });

    test("logRetrySuccess logs recovery", () => {
      mockLogger.info.mockClear();
      logRetrySuccess({
        operationType: "getAccount",
        attemptNumber: 2,
      });

      expect(mockLogger.info).toHaveBeenCalled();
      const output = mockLogger.info.mock.calls[0][1];
      expect(output.event).toBe("rpc_retry_success");
      expect(output.successfulAttempt).toBe(2);
    });
  });

  // ─── withRetry Tests ────────────────────────────────────────────────────

  describe("withRetry", () => {
    describe("Success cases", () => {
      test("returns result on first attempt success", async () => {
        const operation = jest.fn().mockResolvedValue({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("returns result after transient error and retry", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(2);
      });

      test("retries multiple times until success", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockRejectedValueOnce({ status: 429 })
          .mockResolvedValueOnce({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(3);
      });
    });

    describe("Failure cases", () => {
      test("throws on permanent error without retrying", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 400 });

        await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
          status: 400,
        });

        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("throws after exhausting max retries", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
          status: 503,
        });

        expect(operation).toHaveBeenCalledTimes(3);
      });

      test("respects maxRetries option", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(
          withRetry(operation, { operationType: "getAccount", maxRetries: 2 })
        ).rejects.toEqual({ status: 503 });

        expect(operation).toHaveBeenCalledTimes(2);
      });
    });

    describe("Special cases", () => {
      test("never retries submitTransaction operations", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "submitTransaction" })).rejects.toEqual({
          status: 503,
        });

        // Should reject immediately without retries
        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("never retries submit operations", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "submit" })).rejects.toEqual({
          status: 503,
        });

        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("allows custom retry predicate", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 400 })
          .mockResolvedValueOnce({ data: "success" });

        const customShouldRetry = (error) => error?.status === 400;

        const result = await withRetry(operation, {
          operationType: "customOp",
          shouldRetry: customShouldRetry,
        });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(2);
      });

      test("custom predicate can override retry logic", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        const customShouldRetry = () => false;

        await expect(
          withRetry(operation, {
            operationType: "customOp",
            shouldRetry: customShouldRetry,
          })
        ).rejects.toEqual({ status: 503 });

        expect(operation).toHaveBeenCalledTimes(1);
      });
    });

    describe("Details parameter", () => {
      test("passes details to logging", async () => {
        mockLogger.warn.mockClear();
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const details = { walletAddress: "G..." };
        await withRetry(operation, {
          operationType: "getAccount",
          details,
        });

        expect(mockLogger.warn).toHaveBeenCalled();
        const output = mockLogger.warn.mock.calls[0][1];
        expect(output.walletAddress).toBe("G...");
      });
    });

    describe("Timing", () => {
      test("applies backoff between retries", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const startTime = Date.now();
        await withRetry(operation, {
          operationType: "getAccount",
          baseBackoffMs: 100, // Short delay for testing
        });
        const elapsed = Date.now() - startTime;

        // Should have at least 100ms delay (with jitter ±10%)
        expect(elapsed).toBeGreaterThanOrEqual(90);
      });
    });
  });

  // ─── Metrics Tests ─────────────────────────────────────────────────────

  describe("retryMetrics", () => {
    test("tracks retry attempts", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordAttempt();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(2);
    });

    test("tracks successful retries", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.successfulRetries).toBe(1);
    });

    test("tracks exhausted retries", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordExhausted();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.exhaustedRetries).toBe(1);
    });

    test("calculates success rate", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();

      const metrics = retryMetrics.getMetrics();
      expect(parseFloat(metrics.successRate)).toBe(50.0);
    });

    test("handles zero attempts gracefully", () => {
      const metrics = retryMetrics.getMetrics();
      expect(metrics.successRate).toBe(0);
    });

    test("resets metrics", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();
      retryMetrics.reset();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(0);
      expect(metrics.successfulRetries).toBe(0);
    });
  });

  // ─── Integration Tests ──────────────────────────────────────────────────

  describe("Integration scenarios", () => {
    test("recovers from rate limit with backoff", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValueOnce({ data: "success" });

      const result = await withRetry(operation, {
        operationType: "getAccount",
        baseBackoffMs: 50,
      });

      expect(result).toEqual({ data: "success" });
      expect(operation).toHaveBeenCalledTimes(3);
    });

    test("stops retrying on bad request regardless of prior failures", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockRejectedValueOnce({ status: 400 });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
        status: 400,
      });

      // First attempt was 503 (retried), second was 400 (not retried)
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test("handles network error recovery", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ code: "ECONNREFUSED" })
        .mockResolvedValueOnce({ data: "success" });

      const result = await withRetry(operation, { operationType: "getAccount" });

      expect(result).toEqual({ data: "success" });
    });

    test("rejects account not found without retry", async () => {
      const operation = jest.fn().mockRejectedValue({
        status: 400,
        message: "Account not found on Stellar network",
      });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toMatchObject({
        message: expect.stringContaining("Account not found"),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});
