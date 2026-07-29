import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  initializeDatabase,
  closeDatabase,
  recordTransaction,
  updateTransactionHash,
  updateTransactionStatus,
  addDistributionPayout,
} from "../src/database/index.js";
import historyRouter from "../src/routes/history.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_CONTRACT_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const app = express();
app.use(express.json());
app.use("/api/v1", historyRouter);

describe("Distribution history persistence and pagination", () => {
  const testDbPath = path.join(__dirname, "test-history.db");

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    process.env.DATABASE_PATH = testDbPath;
    initializeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  describe("persistence", () => {
    it("records a primary distribution and exposes its metadata via the history API", async () => {
      const transactionId = recordTransaction(CONTRACT_ID, "distribute", "GALICE", {
        requestedAmount: "1000",
        tokenId: "token-1",
      });
      const txHash = "a".repeat(64);
      updateTransactionHash(transactionId, txHash);
      updateTransactionStatus(txHash, "confirmed", "2026-07-01T00:00:00.000Z");
      addDistributionPayout(transactionId, CONTRACT_ID, "GCOLLAB1", "600");
      addDistributionPayout(transactionId, CONTRACT_ID, "GCOLLAB2", "400");

      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      const record = res.body.data[0];
      expect(record.type).toBe("distribute");
      expect(record.txHash).toBe(txHash);
      expect(record.status).toBe("confirmed");
      expect(record.timestamp).toBeTruthy();
      expect(record.payoutCount).toBe(2);
    });

    it("distinguishes primary distribute transactions from secondary royalty transactions", async () => {
      recordTransaction(CONTRACT_ID, "distribute", "GALICE", {
        requestedAmount: "1000",
        tokenId: "token-1",
      });
      recordTransaction(CONTRACT_ID, "secondary_royalty", "GBOB", {
        requestedAmount: "50",
        tokenId: "token-1",
      });
      recordTransaction(CONTRACT_ID, "secondary_distribute", "GBOB", {
        requestedAmount: "50",
        tokenId: "token-1",
      });

      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}`);

      const types = res.body.data.map((tx) => tx.type).sort();
      expect(types).toEqual(["distribute", "secondary_distribute", "secondary_royalty"]);
    });

    it("only returns history scoped to the requested contract", async () => {
      recordTransaction(CONTRACT_ID, "distribute", "GALICE", { requestedAmount: "1000", tokenId: null });
      recordTransaction(OTHER_CONTRACT_ID, "distribute", "GALICE", { requestedAmount: "500", tokenId: null });

      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}`);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].contractId).toBe(CONTRACT_ID);
    });

    it("returns an empty list for a contract with no distribution history", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it("rejects a malformed contract id", async () => {
      const res = await request(app).get("/api/v1/history/not-a-contract");

      expect(res.status).toBe(400);
    });
  });

  describe("pagination", () => {
    beforeEach(() => {
      for (let i = 0; i < 25; i++) {
        recordTransaction(CONTRACT_ID, "distribute", "GALICE", {
          requestedAmount: String(i),
          tokenId: null,
        });
      }
    });

    it("defaults to a limit of 50 and offset of 0", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}`);

      expect(res.body.data).toHaveLength(25);
      expect(res.body.pagination).toEqual({ limit: 50, offset: 0, total: 25 });
    });

    it("honors limit and offset query params", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}?limit=10&offset=10`);

      expect(res.body.data).toHaveLength(10);
      expect(res.body.pagination).toEqual({ limit: 10, offset: 10, total: 25 });
    });

    it("returns the remainder on the last page", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}?limit=10&offset=20`);

      expect(res.body.data).toHaveLength(5);
      expect(res.body.pagination.total).toBe(25);
    });

    it("orders results newest first", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}?limit=25&offset=0`);

      const ids = res.body.data.map((tx) => tx.id);
      const sortedDesc = [...ids].sort((a, b) => b - a);
      expect(ids).toEqual(sortedDesc);
    });

    it("caps limit at the configured maximum", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}?limit=1000&offset=0`);

      expect(res.body.pagination.limit).toBe(100);
    });

    it("rejects a non-numeric limit", async () => {
      const res = await request(app).get(`/api/v1/history/${CONTRACT_ID}?limit=abc`);

      expect(res.status).toBe(400);
    });
  });
});
