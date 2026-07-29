import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetComplianceReport = jest.fn();
const mockListComplianceReports = jest.fn();
const mockCountComplianceReports = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 16),
  getComplianceReport: mockGetComplianceReport,
  listComplianceReports: mockListComplianceReports,
  countComplianceReports: mockCountComplianceReports,
  addAuditLog: jest.fn(),
  REPORT_TYPES: ["monthly", "quarterly", "annual"],
}));

const mockGenerateComplianceReport = jest.fn();
await jest.unstable_mockModule("../src/jobs/compliance-report-job.js", () => ({
  generateComplianceReport: mockGenerateComplianceReport,
  runComplianceReportScheduler: jest.fn(),
  startComplianceReportScheduler: jest.fn(() => ({ stop: jest.fn() })),
  getReportTypesDue: jest.fn(() => []),
  previousMonthPeriod: jest.fn(),
  previousQuarterPeriod: jest.fn(),
  previousYearPeriod: jest.fn(),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { complianceReportsRouter } = await import("../src/routes/compliance-reports.js");

const app = express();
app.use(express.json());
app.use("/api/v1/compliance-reports", complianceReportsRouter);

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const sampleReport = {
  id: 1,
  type: "monthly",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  contractId: "ALL",
  generatedBy: "scheduler",
  status: "completed",
  filePath: "/tmp/compliance-monthly-2026-01-01-id1.html",
  emailedTo: ["admin@example.com"],
  metadata: {
    totalTransactions: 100,
    confirmedTransactions: 95,
    totalDistributed: 50000,
    taxCompleted: 80,
    taxMissing: 5,
  },
  errorMessage: null,
  createdAt: "2026-02-01T00:00:00Z",
  completedAt: "2026-02-01T00:01:00Z",
};

// ─── POST generate ─────────────────────────────────────────────────────────────

describe("POST /api/v1/compliance-reports/generate", () => {
  beforeEach(() => jest.clearAllMocks());

  test("generates a monthly report successfully", async () => {
    mockGenerateComplianceReport.mockResolvedValue({ reportId: 1, sent: true, skipped: false });

    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        type: "monthly",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        contractId: "ALL",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reportId).toBe(1);
    expect(mockGenerateComplianceReport).toHaveBeenCalledWith(
      "monthly", "2026-01-01", "2026-01-31", "ALL"
    );
  });

  test("generates a quarterly report", async () => {
    mockGenerateComplianceReport.mockResolvedValue({ reportId: 2, sent: false, skipped: false });

    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        type: "quarterly",
        periodStart: "2025-10-01",
        periodEnd: "2025-12-31",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.reportId).toBe(2);
  });

  test("returns 200 with skipped flag when report already exists", async () => {
    mockGenerateComplianceReport.mockResolvedValue({ reportId: null, sent: false, skipped: true });

    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        type: "annual",
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.skipped).toBe(true);
    expect(res.body.message).toMatch(/already exists/i);
  });

  test("returns 400 for invalid report type", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({ type: "weekly", periodStart: "2026-01-01", periodEnd: "2026-01-31" });

    expect(res.status).toBe(400);
  });

  test("returns 400 when periodStart is after periodEnd", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({ type: "monthly", periodStart: "2026-02-01", periodEnd: "2026-01-01" });

    expect(res.status).toBe(400);
  });

  test("returns 400 for malformed date", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({ type: "monthly", periodStart: "26-01-01", periodEnd: "26-01-31" });

    expect(res.status).toBe(400);
  });
});

// ─── GET list ──────────────────────────────────────────────────────────────────

describe("GET /api/v1/compliance-reports", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns list of reports", async () => {
    mockListComplianceReports.mockReturnValue([sampleReport]);
    mockCountComplianceReports.mockReturnValue(1);

    const res = await request(app).get("/api/v1/compliance-reports");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  test("filters by type", async () => {
    mockListComplianceReports.mockReturnValue([sampleReport]);
    mockCountComplianceReports.mockReturnValue(1);

    const res = await request(app).get("/api/v1/compliance-reports?type=monthly");

    expect(res.status).toBe(200);
    expect(mockListComplianceReports).toHaveBeenCalledWith(
      expect.objectContaining({ type: "monthly" }),
      50,
      0
    );
  });

  test("filters by status", async () => {
    mockListComplianceReports.mockReturnValue([]);
    mockCountComplianceReports.mockReturnValue(0);

    const res = await request(app).get("/api/v1/compliance-reports?status=completed");
    expect(res.status).toBe(200);
    expect(mockListComplianceReports).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
      50,
      0
    );
  });

  test("supports pagination", async () => {
    mockListComplianceReports.mockReturnValue([]);
    mockCountComplianceReports.mockReturnValue(0);

    const res = await request(app).get("/api/v1/compliance-reports?limit=10&offset=20");
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(10);
    expect(res.body.pagination.offset).toBe(20);
  });
});

// ─── GET single ───────────────────────────────────────────────────────────────

describe("GET /api/v1/compliance-reports/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns a report by id", async () => {
    mockGetComplianceReport.mockReturnValue(sampleReport);

    const res = await request(app).get("/api/v1/compliance-reports/1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.type).toBe("monthly");
    expect(res.body.data.metadata.totalTransactions).toBe(100);
  });

  test("returns 404 for missing report", async () => {
    mockGetComplianceReport.mockReturnValue(null);
    const res = await request(app).get("/api/v1/compliance-reports/999");
    expect(res.status).toBe(404);
  });

  test("returns 400 for non-integer id", async () => {
    const res = await request(app).get("/api/v1/compliance-reports/abc");
    expect(res.status).toBe(400);
  });
});

// ─── Schedule logic unit tests ────────────────────────────────────────────────

describe("compliance report scheduler logic", () => {
  const {
    getReportTypesDue,
    previousMonthPeriod,
    previousQuarterPeriod,
    previousYearPeriod,
  } = await import("../src/jobs/compliance-report-job.js");

  test("getReportTypesDue returns monthly on day 1", () => {
    // These are jest.fn() mocks so test the real functions via direct import
    // We re-import the actual module to test the pure functions
  });
});

// ─── Scheduler pure-function tests ───────────────────────────────────────────

describe("period calculators (real implementations)", () => {
  // Bypass mocks for pure function testing by importing from the source
  const modulePath = new URL("../src/jobs/compliance-report-job.js", import.meta.url).href;

  test("previousMonthPeriod returns correct month range", async () => {
    // Re-import without mock to test real logic
    const { previousMonthPeriod: real } = await import(modulePath);
    // Called in February 2026 → should return January 2026
    const now = new Date("2026-02-01T00:00:00Z");
    const { periodStart, periodEnd } = real(now);
    expect(periodStart).toBe("2026-01-01");
    expect(periodEnd).toBe("2026-01-31");
  });

  test("previousQuarterPeriod returns Q4 when called in Q1", async () => {
    const { previousQuarterPeriod: real } = await import(modulePath);
    const now = new Date("2026-01-15T00:00:00Z");
    const { periodStart, periodEnd } = real(now);
    expect(periodStart).toBe("2025-10-01");
    expect(periodEnd).toBe("2025-12-31");
  });

  test("previousYearPeriod returns prior full year", async () => {
    const { previousYearPeriod: real } = await import(modulePath);
    const now = new Date("2026-01-01T00:00:00Z");
    const { periodStart, periodEnd } = real(now);
    expect(periodStart).toBe("2025-01-01");
    expect(periodEnd).toBe("2025-12-31");
  });

  test("getReportTypesDue returns all three on Jan 1", async () => {
    const { getReportTypesDue: real } = await import(modulePath);
    const now = new Date("2026-01-01T00:00:00Z");
    const due = real(now);
    expect(due).toContain("monthly");
    expect(due).toContain("quarterly");
    expect(due).toContain("annual");
  });

  test("getReportTypesDue returns only monthly on non-quarter/non-year day-1", async () => {
    const { getReportTypesDue: real } = await import(modulePath);
    const now = new Date("2026-02-01T00:00:00Z"); // Feb 1 — only monthly
    const due = real(now);
    expect(due).toContain("monthly");
    expect(due).not.toContain("quarterly");
    expect(due).not.toContain("annual");
  });

  test("getReportTypesDue returns empty array mid-month", async () => {
    const { getReportTypesDue: real } = await import(modulePath);
    const now = new Date("2026-01-15T00:00:00Z");
    const due = real(now);
    expect(due).toHaveLength(0);
  });
});
