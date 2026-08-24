import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockGetContributorTax = jest.fn();
const mockUpsertContributorTax = jest.fn();
const mockGetTaxComplianceReport = jest.fn();
const mockGetContributorsMissingTaxInfo = jest.fn();

await jest.unstable_mockModule("../src/database/contributor-tax.js", () => ({
  getContributorTax: mockGetContributorTax,
  upsertContributorTax: mockUpsertContributorTax,
  getTaxComplianceReport: mockGetTaxComplianceReport,
  getContributorsMissingTaxInfo: mockGetContributorsMissingTaxInfo,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (req, _res, next) => { req.role = "admin"; next(); },
  requireRole: () => (req, _res, next) => { req.role = "admin"; next(); },
}));

import express from "express";
const { contributorTaxRouter } = await import("../src/routes/contributor-tax.js");

const app = express();
app.use(express.json());
app.use("/api/v1/contributor-tax", contributorTaxRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Contributor Tax - CRUD", () => {
  test("GET /:walletAddress returns tax info", async () => {
    mockGetContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    const res = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tax_status).toBe("completed");
  });

  test("GET /:walletAddress returns null when not set", async () => {
    mockGetContributorTax.mockReturnValue(null);
    const res = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test("POST / saves tax info", async () => {
    mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "pending" });
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "pending" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST / rejects missing walletAddress", async () => {
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ tax_status: "pending" });
    expect(res.status).toBe(400);
  });

  test("POST / rejects invalid tax_status", async () => {
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "invalid" });
    expect(res.status).toBe(400);
  });

  test("POST / saves with tax_id", async () => {
    mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    expect(res.status).toBe(200);
    expect(mockUpsertContributorTax).toHaveBeenCalledWith(
      expect.objectContaining({ tax_id: "12-3456789" })
    );
  });
});

describe("Contributor Tax - Reports", () => {
  test("GET /report/compliance returns compliance report", async () => {
    mockGetTaxComplianceReport.mockReturnValue([
      { walletAddress: WALLET, tax_status: "completed", compliance_status: "compliant" }
    ]);
    const res = await request(app).get("/api/v1/contributor-tax/report/compliance");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.summary).toBeDefined();
  });

  test("GET /report/missing returns contributors missing tax info", async () => {
    mockGetContributorsMissingTaxInfo.mockReturnValue([{ walletAddress: WALLET, tax_status: null }]);
    const res = await request(app).get("/api/v1/contributor-tax/report/missing");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe("Contributor Tax - Data Validation", () => {
  test("valid tax_status values are accepted", async () => {
    const statuses = ["not_collected", "pending", "completed", "exempt"];
    for (const status of statuses) {
      mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: status });
      const res = await request(app)
        .post("/api/v1/contributor-tax")
        .send({ walletAddress: WALLET, tax_status: status });
      expect(res.status).toBe(200);
    }
  });

  test("data persists correctly across save and fetch", async () => {
    const savedData = { id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" };
    mockUpsertContributorTax.mockReturnValue(savedData);
    mockGetContributorTax.mockReturnValue(savedData);

    const saveRes = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    expect(saveRes.body.data.tax_status).toBe("completed");

    const getRes = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(getRes.body.data.tax_id).toBe("12-3456789");
  });
});
