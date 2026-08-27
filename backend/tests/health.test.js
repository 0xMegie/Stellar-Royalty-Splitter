import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const checkHorizonConnectivity = jest.fn();
const checkContractDeploymentStatus = jest.fn();
const getConfiguredContractId = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");

await jest.unstable_mockModule("../src/stellar.js", () => ({
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  getConfiguredContractId,
  getNetworkLabel,
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordHealthSnapshot = jest.fn();
const pruneHealthHistory = jest.fn();
const getHealthHistory = jest.fn(() => []);
const getSLAStats = jest.fn(() => ({
  periodDays: 30,
  totalSnapshots: 0,
  healthySnapshots: 0,
  uptimePercent: 100.0,
  avgLatencyMs: null,
  minLatencyMs: null,
  maxLatencyMs: null,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 4),
  recordHealthSnapshot,
  pruneHealthHistory,
  getHealthHistory,
  getSLAStats,
}));

const { clearHealthCache } = await import("../src/routes/health.js");

const express = (await import("express")).default;
const { healthRouter } = await import("../src/routes/health.js");

const app = express();
app.use("/api/v1/health", healthRouter);

describe("GET /api/v1/health", () => {
  beforeEach(() => {
    clearHealthCache();
    getConfiguredContractId.mockReturnValue(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    checkHorizonConnectivity.mockResolvedValue({
      connected: true,
      url: "https://horizon-testnet.stellar.org",
    });
    checkContractDeploymentStatus.mockResolvedValue({
      configured: true,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      deployed: true,
      initialized: true,
      status: "initialized",
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("returns network, horizon, contract, and db version", async () => {
    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      dbVersion: 4,
      dbOk: true,
      network: "Testnet",
      horizon: { connected: true, url: expect.any(String), latencyMs: expect.any(Number) },
      contract: {
        configured: true,
        deployed: true,
        initialized: true,
        status: "initialized",
      },
    });
  });

  test("returns components with color indicators", async () => {
    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body.components).toMatchObject({
      database: { status: "healthy", color: "green" },
      horizon: { status: "healthy", color: "green", latencyMs: expect.any(Number) },
      contract: { status: "healthy", color: "green" },
    });
  });

  test("returns dbOk field in response", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.body).toHaveProperty("dbOk", true);
  });

  test("returns horizon.latencyMs in response", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.body.horizon).toHaveProperty("latencyMs");
    expect(typeof res.body.horizon.latencyMs).toBe("number");
  });

  test("ok is false when Horizon is unreachable", async () => {
    checkHorizonConnectivity.mockResolvedValue({
      connected: false,
      url: "https://horizon-testnet.stellar.org",
    });

    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.horizon.connected).toBe(false);
    expect(res.body.components.horizon.status).toBe("down");
    expect(res.body.components.horizon.color).toBe("red");
  });

  test("reports not_configured when no contract ID is set", async () => {
    getConfiguredContractId.mockReturnValue(null);
    checkContractDeploymentStatus.mockResolvedValue({
      configured: false,
      contractId: null,
      deployed: false,
      initialized: false,
      status: "not_configured",
    });

    const res = await request(app).get("/api/v1/health");
    expect(res.body.contract.status).toBe("not_configured");
    expect(res.body.ok).toBe(true);
    expect(res.body.components.contract.status).toBe("not_configured");
    expect(res.body.components.contract.color).toBe("gray");
  });

  test("components.horizon.color is yellow when latency > 3000ms", async () => {
    // Override checkHorizonConnectivity to delay enough to push latencyMs over 3000
    // We mock Date.now to simulate high latency without actually waiting
    const realDateNow = Date.now;
    let callCount = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      callCount++;
      // First call = horizonStart, second call = after await = +3001ms
      return callCount === 1 ? 1000 : 4002;
    });

    clearHealthCache();

    const res = await request(app).get("/api/v1/health");
    expect(res.body.components.horizon.color).toBe("yellow");
    expect(res.body.components.horizon.status).toBe("degraded");

    Date.now.mockRestore();
    jest.spyOn(Date, "now").mockImplementation(realDateNow);
    Date.now.mockRestore();
  });

  test("caches responses within TTL", async () => {
    await request(app).get("/api/v1/health");
    await request(app).get("/api/v1/health");

    expect(checkHorizonConnectivity).toHaveBeenCalledTimes(1);
    expect(checkContractDeploymentStatus).toHaveBeenCalledTimes(1);
  });

  test("snapshot recording failure does not affect health response", async () => {
    recordHealthSnapshot.mockImplementation(() => {
      throw new Error("DB write failed");
    });

    // Force recording by setting lastRecordedAt to 0 (already the case after clearHealthCache)
    const res = await request(app).get("/api/v1/health");
    // Should still return 200 OK despite snapshot failure
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("returns timestamp in ISO format", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.body).toHaveProperty("timestamp");
    expect(() => new Date(res.body.timestamp)).not.toThrow();
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });
});

describe("GET /api/v1/health/history", () => {
  beforeEach(() => {
    clearHealthCache();
    getHealthHistory.mockReturnValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("returns empty history when no snapshots exist", async () => {
    const res = await request(app).get("/api/v1/health/history");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: [],
      count: 0,
      periodHours: 24,
    });
  });

  test("respects hours query parameter", async () => {
    const res = await request(app).get("/api/v1/health/history?hours=48");

    expect(res.status).toBe(200);
    expect(res.body.periodHours).toBe(48);
    expect(getHealthHistory).toHaveBeenCalledWith(48);
  });

  test("caps hours at 720 (30 days)", async () => {
    const res = await request(app).get("/api/v1/health/history?hours=9999");

    expect(res.status).toBe(200);
    expect(res.body.periodHours).toBe(720);
    expect(getHealthHistory).toHaveBeenCalledWith(720);
  });

  test("returns history entries when snapshots exist", async () => {
    const mockEntry = {
      id: 1,
      timestamp: "2024-01-15 10:00:00",
      overall_ok: 1,
      horizon_connected: 1,
      horizon_latency_ms: 120,
      contract_status: "initialized",
      db_ok: 1,
      details: null,
    };
    getHealthHistory.mockReturnValue([mockEntry]);

    const res = await request(app).get("/api/v1/health/history");

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject(mockEntry);
  });
});

describe("GET /api/v1/health/sla", () => {
  beforeEach(() => {
    clearHealthCache();
    getSLAStats.mockReturnValue({
      periodDays: 30,
      totalSnapshots: 0,
      healthySnapshots: 0,
      uptimePercent: 100.0,
      avgLatencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("returns SLA statistics", async () => {
    const res = await request(app).get("/api/v1/health/sla");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        periodDays: 30,
        totalSnapshots: 0,
        healthySnapshots: 0,
        uptimePercent: 100.0,
        avgLatencyMs: null,
        minLatencyMs: null,
        maxLatencyMs: null,
      },
    });
  });

  test("respects days query parameter", async () => {
    getSLAStats.mockReturnValue({
      periodDays: 7,
      totalSnapshots: 168,
      healthySnapshots: 165,
      uptimePercent: 98.214,
      avgLatencyMs: 145,
      minLatencyMs: 80,
      maxLatencyMs: 450,
    });

    const res = await request(app).get("/api/v1/health/sla?days=7");

    expect(res.status).toBe(200);
    expect(getSLAStats).toHaveBeenCalledWith(7);
    expect(res.body.data.uptimePercent).toBe(98.214);
    expect(res.body.data.avgLatencyMs).toBe(145);
  });

  test("caps days at 365", async () => {
    const res = await request(app).get("/api/v1/health/sla?days=9999");

    expect(res.status).toBe(200);
    expect(getSLAStats).toHaveBeenCalledWith(365);
  });
});
