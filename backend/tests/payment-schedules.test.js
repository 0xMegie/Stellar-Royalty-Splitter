import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreatePaymentSchedule = jest.fn();
const mockGetPaymentSchedule = jest.fn();
const mockListPaymentSchedules = jest.fn();
const mockCountPaymentSchedules = jest.fn();
const mockUpdatePaymentSchedule = jest.fn();
const mockDeletePaymentSchedule = jest.fn();
const mockGetUpcomingSchedules = jest.fn();
const mockSetNextRunAt = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 14),
  createPaymentSchedule: mockCreatePaymentSchedule,
  getPaymentSchedule: mockGetPaymentSchedule,
  listPaymentSchedules: mockListPaymentSchedules,
  countPaymentSchedules: mockCountPaymentSchedules,
  updatePaymentSchedule: mockUpdatePaymentSchedule,
  deletePaymentSchedule: mockDeletePaymentSchedule,
  getUpcomingSchedules: mockGetUpcomingSchedules,
  setNextRunAt: mockSetNextRunAt,
  addAuditLog: mockAddAuditLog,
  SCHEDULE_TYPES: ["monthly", "biweekly", "weekly", "custom"],
}));

await jest.unstable_mockModule("../src/schedule-calculator.js", () => ({
  computeNextRun: jest.fn(() => "2026-02-01T00:00:00.000Z"),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { paymentSchedulesRouter } = await import("../src/routes/payment-schedules.js");

const app = express();
app.use(express.json());
app.use("/api/v1/payment-schedules", paymentSchedulesRouter);

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VALID_WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const baseSchedule = {
  id: 1,
  name: "Monthly Payout",
  type: "monthly",
  contractId: VALID_CONTRACT,
  tokenId: VALID_TOKEN,
  walletAddress: VALID_WALLET,
  dayOfMonth: 1,
  hourOfDay: 9,
  timezone: "UTC",
  enabled: true,
  nextRunAt: "2026-02-01T09:00:00.000Z",
  lastRunAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// ─── POST create ──────────────────────────────────────────────────────────────

describe("POST /api/v1/payment-schedules", () => {
  beforeEach(() => jest.clearAllMocks());

  test("creates a monthly schedule successfully", async () => {
    mockCreatePaymentSchedule.mockReturnValue(baseSchedule);

    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Monthly Payout",
        type: "monthly",
        contractId: VALID_CONTRACT,
        tokenId: VALID_TOKEN,
        walletAddress: VALID_WALLET,
        dayOfMonth: 1,
        hourOfDay: 9,
        timezone: "UTC",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.type).toBe("monthly");
    expect(mockCreatePaymentSchedule).toHaveBeenCalled();
    expect(mockSetNextRunAt).toHaveBeenCalled();
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      VALID_CONTRACT, "payment_schedule_created", VALID_WALLET, expect.any(Object)
    );
  });

  test("returns 400 when dayOfMonth missing for monthly type", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Bad Monthly",
        type: "monthly",
        contractId: VALID_CONTRACT,
        tokenId: VALID_TOKEN,
        walletAddress: VALID_WALLET,
      });

    expect(res.status).toBe(400);
  });

  test("returns 400 for custom type missing intervalDays", async () => {
    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Custom",
        type: "custom",
        contractId: VALID_CONTRACT,
        tokenId: VALID_TOKEN,
        walletAddress: VALID_WALLET,
        anchorDate: "2026-01-01T00:00:00.000Z",
      });

    expect(res.status).toBe(400);
  });

  test("creates a weekly schedule", async () => {
    mockCreatePaymentSchedule.mockReturnValue({ ...baseSchedule, type: "weekly", dayOfWeek: 1 });

    const res = await request(app)
      .post("/api/v1/payment-schedules")
      .send({
        name: "Weekly Payout",
        type: "weekly",
        contractId: VALID_CONTRACT,
        tokenId: VALID_TOKEN,
        walletAddress: VALID_WALLET,
        dayOfWeek: 1,
        hourOfDay: 8,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("weekly");
  });
});

// ─── GET list ──────────────────────────────────────────────────────────────────

describe("GET /api/v1/payment-schedules", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns list of schedules", async () => {
    mockListPaymentSchedules.mockReturnValue([baseSchedule]);
    mockCountPaymentSchedules.mockReturnValue(1);

    const res = await request(app).get("/api/v1/payment-schedules");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  test("filters by contractId", async () => {
    mockListPaymentSchedules.mockReturnValue([baseSchedule]);
    mockCountPaymentSchedules.mockReturnValue(1);

    const res = await request(app)
      .get(`/api/v1/payment-schedules?contractId=${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(mockListPaymentSchedules).toHaveBeenCalledWith(
      VALID_CONTRACT,
      expect.objectContaining({ includeDisabled: false })
    );
  });
});

// ─── GET single ───────────────────────────────────────────────────────────────

describe("GET /api/v1/payment-schedules/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns a schedule by id", async () => {
    mockGetPaymentSchedule.mockReturnValue(baseSchedule);
    const res = await request(app).get("/api/v1/payment-schedules/1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
  });

  test("returns 404 for missing schedule", async () => {
    mockGetPaymentSchedule.mockReturnValue(null);
    const res = await request(app).get("/api/v1/payment-schedules/999");
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid id", async () => {
    const res = await request(app).get("/api/v1/payment-schedules/abc");
    expect(res.status).toBe(400);
  });
});

// ─── PATCH update ─────────────────────────────────────────────────────────────

describe("PATCH /api/v1/payment-schedules/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  test("updates a schedule", async () => {
    mockGetPaymentSchedule.mockReturnValue(baseSchedule);
    mockUpdatePaymentSchedule.mockReturnValue({ ...baseSchedule, hourOfDay: 10 });

    const res = await request(app)
      .patch("/api/v1/payment-schedules/1")
      .send({ hourOfDay: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.hourOfDay).toBe(10);
    expect(mockAddAuditLog).toHaveBeenCalled();
  });

  test("returns 404 when schedule not found", async () => {
    mockGetPaymentSchedule.mockReturnValue(null);
    const res = await request(app).patch("/api/v1/payment-schedules/999").send({ hourOfDay: 0 });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe("DELETE /api/v1/payment-schedules/:id", () => {
  beforeEach(() => jest.clearAllMocks());

  test("deletes a schedule", async () => {
    mockGetPaymentSchedule.mockReturnValue(baseSchedule);

    const res = await request(app).delete("/api/v1/payment-schedules/1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeletePaymentSchedule).toHaveBeenCalledWith(1);
    expect(mockAddAuditLog).toHaveBeenCalled();
  });

  test("returns 404 when schedule not found", async () => {
    mockGetPaymentSchedule.mockReturnValue(null);
    const res = await request(app).delete("/api/v1/payment-schedules/999");
    expect(res.status).toBe(404);
  });
});

// ─── GET upcoming ─────────────────────────────────────────────────────────────

describe("GET /api/v1/payment-schedules/upcoming", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns upcoming scheduled distributions", async () => {
    mockGetUpcomingSchedules.mockReturnValue([
      { id: 1, name: "Monthly Payout", nextRunAt: "2026-02-01T09:00:00Z", contractId: VALID_CONTRACT },
    ]);

    const res = await request(app).get("/api/v1/payment-schedules/upcoming");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

// ─── Schedule calculator ──────────────────────────────────────────────────────

describe("schedule-calculator", () => {
  const { nextMonthly, nextWeekly, nextInterval } = await import("../src/schedule-calculator.js");

  test("nextMonthly returns future date on day-1 of next month when past", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const result = nextMonthly(now, 1, 0);
    expect(new Date(result) > now).toBe(true);
    expect(new Date(result).getUTCDate()).toBe(1);
  });

  test("nextMonthly returns same month when day is in future", () => {
    const now = new Date("2026-01-10T10:00:00Z");
    const result = nextMonthly(now, 15, 0);
    expect(new Date(result).getUTCMonth()).toBe(0); // January
    expect(new Date(result).getUTCDate()).toBe(15);
  });

  test("nextWeekly returns next occurrence of day-of-week", () => {
    const now = new Date("2026-01-19T10:00:00Z"); // Monday
    const result = nextWeekly(now, 5, 0); // Friday
    const d = new Date(result);
    expect(d.getUTCDay()).toBe(5);
    expect(d > now).toBe(true);
  });

  test("nextInterval computes correct biweekly date", () => {
    const anchor = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-10T00:00:00Z");
    const result = nextInterval(now, anchor, 14, 0);
    const d = new Date(result);
    // Jan 1 + 14 days = Jan 15
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCMonth()).toBe(0);
  });
});
