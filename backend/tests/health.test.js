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
  checkSorobanConnectivity: jest.fn().mockResolvedValue({ connected: true, responseTimeMs: 10, status: "healthy", url: "https://soroban-testnet.stellar.org" }),
  getCacheStatus: jest.fn().mockReturnValue({ cached: true, ageMs: 1000, ttlMs: 30000 }),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 2),
  checkDatabase: jest.fn(() => ({ connected: true, responseTimeMs: 1, version: 2, walMode: true, tableCount: 10 })),
}));

await jest.unstable_mockModule("../src/metrics.js", () => ({
  recordDetailedHealthCheck: jest.fn(),
  recordConnectionHealthCheck: jest.fn(),
  recordHorizonResponseTime: jest.fn(),
  prometheusMetrics: jest.fn(() => ""),
}));

await jest.unstable_mockModule("../src/database/health-monitor.js", () => ({
  checkConnectionHealthAsync: jest.fn().mockResolvedValue({
    connected: true,
    durationMs: 1,
    lastCheckAt: new Date().toISOString(),
    consecutiveFailures: 0,
    pool: { poolSize: 5, activeConnections: 0, available: 5, utilization: 0, queueLength: 0, timeouts: 0, acquires: 0 },
  }),
  getHealthMetrics: jest.fn().mockReturnValue({ totalChecks: 1, totalFailures: 0 }),
}));

const { clearHealthCache } = await import("../src/routes/health.js");

const express = (await import("express")).default;
const { healthRouter } = await import("../src/routes/health.js");

const app = express();
app.use("/api/v1/health", healthRouter);

describe("GET /api/v1/health", () => {
  beforeEach(() => {
    clearHealthCache();
    getConfiguredContractId.mockReturnValue("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
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
      dbVersion: 2,
      network: "Testnet",
      horizon: { connected: true, url: expect.any(String) },
      contract: {
        configured: true,
        deployed: true,
        initialized: true,
        status: "initialized",
      },
    });
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
  });

  test("caches responses within TTL", async () => {
    await request(app).get("/api/v1/health");
    await request(app).get("/api/v1/health");

    expect(checkHorizonConnectivity).toHaveBeenCalledTimes(1);
    expect(checkContractDeploymentStatus).toHaveBeenCalledTimes(1);
  });
});
