import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const checkHorizonConnectivity = jest.fn();
const checkContractDeploymentStatus = jest.fn();
const checkSorobanConnectivity = jest.fn();
const getCacheStatus = jest.fn();
const getConfiguredContractId = jest.fn();
const getNetworkLabel = jest.fn(() => "Testnet");
const checkDatabase = jest.fn();
const recordDetailedHealthCheck = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkSorobanConnectivity,
  getCacheStatus,
  getConfiguredContractId,
  getNetworkLabel,
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 7),
  checkDatabase,
}));

await jest.unstable_mockModule("../src/metrics.js", () => ({
  recordDetailedHealthCheck,
  recordHorizonResponseTime: jest.fn(),
  prometheusMetrics: jest.fn(() => ""),
}));

const { clearHealthCache } = await import("../src/routes/health.js");
const express = (await import("express")).default;
const { healthRouter } = await import("../src/routes/health.js");

const app = express();
app.use("/api/v1/health", healthRouter);

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockAllHealthy() {
  getConfiguredContractId.mockReturnValue(
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  checkDatabase.mockReturnValue({
    connected: true,
    responseTimeMs: 2,
    version: 7,
    walMode: true,
    tableCount: 12,
  });
  checkHorizonConnectivity.mockResolvedValue({
    connected: true,
    url: "https://horizon-testnet.stellar.org",
  });
  checkSorobanConnectivity.mockResolvedValue({
    connected: true,
    responseTimeMs: 45,
    status: "healthy",
    url: "https://soroban-testnet.stellar.org",
  });
  checkContractDeploymentStatus.mockResolvedValue({
    configured: true,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    deployed: true,
    initialized: true,
    status: "initialized",
  });
  getCacheStatus.mockReturnValue({ cached: true, ageMs: 5000, ttlMs: 30000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/v1/health/detailed", () => {
  beforeEach(() => {
    clearHealthCache();
    mockAllHealthy();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("returns 200 with full component breakdown when all healthy", async () => {
    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.network).toBe("Testnet");
    expect(res.body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const { database, horizon, soroban, contract, cache } = res.body.components;

    expect(database.status).toBe("ok");
    expect(database.connected).toBe(true);
    expect(database.version).toBe(7);
    expect(database.walMode).toBe(true);
    expect(typeof database.responseTimeMs).toBe("number");

    expect(horizon.status).toBe("ok");
    expect(horizon.connected).toBe(true);
    expect(typeof horizon.responseTimeMs).toBe("number");

    expect(soroban.status).toBe("ok");
    expect(soroban.connected).toBe(true);
    expect(typeof soroban.responseTimeMs).toBe("number");

    expect(contract.status).toBe("ok");
    expect(contract.initialized).toBe(true);

    expect(cache.status).toBe("ok");
    expect(cache.cached).toBe(true);
  });

  test("returns 503 when database is down", async () => {
    checkDatabase.mockReturnValue({
      connected: false,
      responseTimeMs: 1,
      error: "Database is closed",
    });

    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.components.database.status).toBe("error");
    expect(res.body.components.database.error).toBe("Database is closed");
    // Other components still present
    expect(res.body.components.horizon.status).toBe("ok");
    expect(res.body.components.soroban.status).toBe("ok");
  });

  test("returns 503 when Horizon is unreachable", async () => {
    checkHorizonConnectivity.mockResolvedValue({
      connected: false,
      url: "https://horizon-testnet.stellar.org",
    });

    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.components.horizon.status).toBe("error");
    expect(res.body.components.database.status).toBe("ok");
    expect(res.body.components.soroban.status).toBe("ok");
  });

  test("returns 503 when Soroban RPC is unreachable", async () => {
    checkSorobanConnectivity.mockResolvedValue({
      connected: false,
      responseTimeMs: 5001,
      url: "https://soroban-testnet.stellar.org",
      error: "Soroban getHealth timed out after 5000ms",
    });

    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.components.soroban.status).toBe("error");
  });

  test("returns 503 when configured contract is in error state", async () => {
    checkContractDeploymentStatus.mockResolvedValue({
      configured: true,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      deployed: false,
      initialized: false,
      status: "error",
    });

    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.components.contract.status).toBe("error");
    // Critical infra still healthy
    expect(res.body.components.database.status).toBe("ok");
    expect(res.body.components.horizon.status).toBe("ok");
  });

  test("returns 200 when no contract is configured (not_configured is non-critical)", async () => {
    getConfiguredContractId.mockReturnValue(null);
    checkContractDeploymentStatus.mockResolvedValue({
      configured: false,
      contractId: null,
      deployed: false,
      initialized: false,
      status: "not_configured",
    });

    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.components.contract.status).toBe("ok");
  });

  test("returns response times for every component", async () => {
    const res = await request(app).get("/api/v1/health/detailed");

    expect(res.status).toBe(200);
    const { database, horizon, soroban, cache } = res.body.components;
    for (const component of [database, horizon, soroban, cache]) {
      expect(typeof component.responseTimeMs).toBe("number");
      expect(component.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("records Prometheus metrics on each request", async () => {
    await request(app).get("/api/v1/health/detailed");

    expect(recordDetailedHealthCheck).toHaveBeenCalledTimes(1);
    const call = recordDetailedHealthCheck.mock.calls[0][0];
    expect(typeof call.databaseMs).toBe("number");
    expect(typeof call.horizonMs).toBe("number");
    expect(typeof call.sorobanMs).toBe("number");
    expect(typeof call.cacheMs).toBe("number");
  });

  test("component check timeout surfaces as error without crashing", async () => {
    jest.setTimeout(10_000);
    // Simulate a check that hangs past the configured timeout by having it never resolve.
    checkSorobanConnectivity.mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    // Use a short env timeout so the test doesn't actually wait 5 s.
    process.env.HEALTH_CHECK_TIMEOUT_MS = "50";

    const res = await request(app).get("/api/v1/health/detailed");

    delete process.env.HEALTH_CHECK_TIMEOUT_MS;

    expect(res.status).toBe(503);
    expect(res.body.components.soroban.status).toBe("error");
    expect(res.body.components.soroban.error).toMatch(/timed out/i);
    // Other components unaffected
    expect(res.body.components.database.status).toBe("ok");
    expect(res.body.components.horizon.status).toBe("ok");
  }, 10_000);
});
