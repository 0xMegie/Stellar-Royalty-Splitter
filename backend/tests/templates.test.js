import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeDatabase, closeDatabase } from "../src/database/index.js";
import { templatesRouter } from "../src/routes/templates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB_1 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const COLLAB_2 = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

const app = express();
app.use(express.json());
app.use("/api/v1/templates", templatesRouter);

describe("Royalty split templates", () => {
  const testDbPath = path.join(__dirname, "test-templates.db");

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    process.env.DATABASE_PATH = testDbPath;
    initializeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  describe("POST /api/v1/templates", () => {
    it("creates a template with valid allocations", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: WALLET,
          name: "Even split",
          allocations: [
            { address: COLLAB_1, percentage: 60 },
            { address: COLLAB_2, percentage: 40 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Even split");
      expect(res.body.data.allocations).toEqual([
        { address: COLLAB_1, percentage: 60 },
        { address: COLLAB_2, percentage: 40 },
      ]);
      expect(res.body.data.id).toBeDefined();
    });

    it("rejects allocations that don't sum to 100%", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: WALLET,
          name: "Broken split",
          allocations: [{ address: COLLAB_1, percentage: 60 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_allocations");
    });

    it("rejects duplicate collaborator addresses", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: WALLET,
          name: "Duplicate split",
          allocations: [
            { address: COLLAB_1, percentage: 50 },
            { address: COLLAB_1, percentage: 50 },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_allocations");
    });

    it("rejects a missing name", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: WALLET,
          name: "",
          allocations: [{ address: COLLAB_1, percentage: 100 }],
        });

      expect(res.status).toBe(400);
    });

    it("rejects an invalid collaborator address", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: WALLET,
          name: "Bad address",
          allocations: [{ address: "not-an-address", percentage: 100 }],
        });

      expect(res.status).toBe(400);
    });

    it("rejects an invalid walletAddress", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .send({
          walletAddress: "not-a-wallet",
          name: "Bad wallet",
          allocations: [{ address: COLLAB_1, percentage: 100 }],
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/templates", () => {
    it("lists only templates owned by the requesting wallet", async () => {
      await request(app).post("/api/v1/templates").send({
        walletAddress: WALLET,
        name: "Mine",
        allocations: [{ address: COLLAB_1, percentage: 100 }],
      });
      await request(app).post("/api/v1/templates").send({
        walletAddress: OTHER_WALLET,
        name: "Not mine",
        allocations: [{ address: COLLAB_2, percentage: 100 }],
      });

      const res = await request(app).get(`/api/v1/templates?walletAddress=${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("Mine");
    });

    it("returns an empty list for a wallet with no templates", async () => {
      const res = await request(app).get(`/api/v1/templates?walletAddress=${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("requires a walletAddress query parameter", async () => {
      const res = await request(app).get("/api/v1/templates");

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/v1/templates/:id", () => {
    it("deletes a template owned by the wallet", async () => {
      const created = await request(app).post("/api/v1/templates").send({
        walletAddress: WALLET,
        name: "Deletable",
        allocations: [{ address: COLLAB_1, percentage: 100 }],
      });
      const id = created.body.data.id;

      const del = await request(app).delete(`/api/v1/templates/${id}?walletAddress=${WALLET}`);
      expect(del.status).toBe(200);

      const list = await request(app).get(`/api/v1/templates?walletAddress=${WALLET}`);
      expect(list.body.data).toHaveLength(0);
    });

    it("does not allow deleting another wallet's template", async () => {
      const created = await request(app).post("/api/v1/templates").send({
        walletAddress: WALLET,
        name: "Protected",
        allocations: [{ address: COLLAB_1, percentage: 100 }],
      });
      const id = created.body.data.id;

      const del = await request(app).delete(
        `/api/v1/templates/${id}?walletAddress=${OTHER_WALLET}`,
      );
      expect(del.status).toBe(404);

      const list = await request(app).get(`/api/v1/templates?walletAddress=${WALLET}`);
      expect(list.body.data).toHaveLength(1);
    });

    it("returns 404 for a nonexistent template id", async () => {
      const res = await request(app).delete(`/api/v1/templates/999999?walletAddress=${WALLET}`);
      expect(res.status).toBe(404);
    });
  });
});
