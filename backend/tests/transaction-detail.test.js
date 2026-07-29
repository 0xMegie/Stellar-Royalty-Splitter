import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIMPLE_TX_HASH = "1111111111111111111111111111111111111111111111111111111111111111";
const COMPLEX_TX_HASH = "2222222222222222222222222222222222222222222222222222222222222222";
const NON_EXISTENT_HASH = "9999999999999999999999999999999999999999999999999999999999999999";

const sampleTransactions = {
  [SIMPLE_TX_HASH]: {
    id: 1,
    txHash: SIMPLE_TX_HASH,
    contractId: CONTRACT_ID,
    type: "distribute",
    initiatorAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
    requestedAmount: "1000",
    tokenId: "XLM",
    timestamp: "2026-07-24T12:00:00.000Z",
    blockTime: "2026-07-24T12:00:05.000Z",
    status: "confirmed",
    errorMessage: null,
    payouts: [
      { collaboratorAddress: "GAAAAA...", amountReceived: "1000" },
    ],
  },
  [COMPLEX_TX_HASH]: {
    id: 2,
    txHash: COMPLEX_TX_HASH,
    contractId: CONTRACT_ID,
    type: "distribute",
    initiatorAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
    requestedAmount: "10000",
    tokenId: "XLM",
    timestamp: "2026-07-24T13:00:00.000Z",
    blockTime: "2026-07-24T13:00:05.000Z",
    status: "confirmed",
    errorMessage: null,
    payouts: [
      { collaboratorAddress: "GAAAAA...", amountReceived: "5000" },
      { collaboratorAddress: "GBBBBB...", amountReceived: "2500" },
      { collaboratorAddress: "GCCCCC...", amountReceived: "1500" },
      { collaboratorAddress: "GDDDDD...", amountReceived: "1000" },
    ],
  },
};

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getTransactionDetails: jest.fn((txHash) => {
    const base = sampleTransactions[txHash];
    if (!base) return null;

    const totalPayoutNum = base.payouts.reduce(
      (acc, p) => acc + parseFloat(p.amountReceived),
      0
    );

    const payoutsWithShares = base.payouts.map((p) => {
      const amt = parseFloat(p.amountReceived);
      const sharePercentage =
        totalPayoutNum > 0 ? parseFloat(((amt / totalPayoutNum) * 100).toFixed(2)) : 0;
      return { ...p, sharePercentage };
    });

    return {
      ...base,
      payouts: payoutsWithShares,
      totalPayout: totalPayoutNum.toString(),
      auditHistory: [
        {
          id: 101,
          contractId: base.contractId,
          action: "distribute_executed",
          user: base.initiatorAddress,
          details: { amount: base.requestedAmount, recipients: base.payouts.length },
          timestamp: base.timestamp,
        },
      ],
      contractEvents: [
        {
          id: `evt-${base.id}-invoked`,
          type: "contract_invocation",
          contractId: base.contractId,
          topics: ["contract_call", base.type, base.contractId],
          data: {
            function: base.type,
            initiator: base.initiatorAddress,
            tokenId: base.tokenId,
            status: base.status,
          },
          timestamp: base.timestamp,
        },
      ],
    };
  }),
  getTransactionHistory: jest.fn(() => []),
  getTransactionCount: jest.fn(() => 0),
  getTransactionById: jest.fn(),
  getAuditLog: jest.fn(() => []),
  addAuditLog: jest.fn(),
  updateTransactionStatus: jest.fn(),
  updateTransactionHash: jest.fn(),
  archiveContractEvents: jest.fn(),
  getArchivePolicy: jest.fn(() => ({ enabled: true, retentionDays: 90 })),
  getArchivedEventCount: jest.fn(() => 0),
  getArchivedEvents: jest.fn(() => []),
  updateArchivePolicy: jest.fn(),
}));

const historyRouter = (await import("../src/routes/history.js")).default;

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

describe("Transaction Detail View API (#577)", () => {
  test("GET /api/v1/transaction/:txHash returns simple distribution details", async () => {
    const res = await request(app).get(`/api/v1/transaction/${SIMPLE_TX_HASH}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.txHash).toBe(SIMPLE_TX_HASH);
    expect(res.body.data.payouts).toHaveLength(1);
    expect(res.body.data.payouts[0].sharePercentage).toBe(100);
    expect(res.body.data.auditHistory).toHaveLength(1);
    expect(res.body.data.contractEvents).toHaveLength(1);
  });

  test("GET /api/v1/transaction/:txHash returns complex multi-recipient distribution details", async () => {
    const res = await request(app).get(`/api/v1/transaction/${COMPLEX_TX_HASH}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.txHash).toBe(COMPLEX_TX_HASH);
    expect(res.body.data.payouts).toHaveLength(4);

    const shares = res.body.data.payouts.map((p) => p.sharePercentage);
    expect(shares).toEqual([50, 25, 15, 10]);

    const totalShareSum = shares.reduce((a, b) => a + b, 0);
    expect(totalShareSum).toBe(100);

    expect(res.body.data.auditHistory[0].action).toBe("distribute_executed");
    expect(res.body.data.contractEvents[0].topics).toContain("distribute");
  });

  test("GET /api/v1/transaction/:txHash returns 404 for non-existent transaction hash", async () => {
    const res = await request(app).get(`/api/v1/transaction/${NON_EXISTENT_HASH}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Transaction not found");
  });
});
