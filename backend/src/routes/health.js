import { Router } from "express";
import {
  getMigrationVersion,
  recordHealthSnapshot,
  pruneHealthHistory,
  getHealthHistory,
  getSLAStats,
} from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
} from "../stellar.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
const RECORD_INTERVAL_MS = parseInt(
  process.env.HEALTH_RECORD_INTERVAL_MS ?? "3600000",
  10
); // 1 hour default
let cachedHealth = null;
let cacheExpiresAt = 0;
let lastRecordedAt = 0;

/**
 * GET /api/v1/health
 * Extended health: DB migration version, network, Horizon (with latency),
 * contract status, and per-component color indicators (#787).
 * Automatically records hourly snapshots to health_history table.
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const horizonStart = Date.now();
    const [horizon, contract] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
    ]);
    const horizonLatencyMs = Date.now() - horizonStart;

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    let dbOk = true;
    try {
      getMigrationVersion();
    } catch {
      dbOk = false;
    }

    const body = {
      ok: horizon.connected && contractHealthy && dbOk,
      dbVersion: getMigrationVersion(),
      dbOk,
      network: getNetworkLabel(),
      horizon: {
        ...horizon,
        latencyMs: horizonLatencyMs,
      },
      contract,
      components: {
        database: {
          status: dbOk ? "healthy" : "degraded",
          color: dbOk ? "green" : "red",
        },
        horizon: {
          status: horizon.connected
            ? horizonLatencyMs > 3000
              ? "degraded"
              : "healthy"
            : "down",
          color: horizon.connected
            ? horizonLatencyMs > 3000
              ? "yellow"
              : "green"
            : "red",
          latencyMs: horizonLatencyMs,
        },
        contract: {
          status: !contract.configured
            ? "not_configured"
            : contractHealthy
            ? "healthy"
            : "error",
          color: !contract.configured
            ? "gray"
            : contractHealthy
            ? "green"
            : "red",
        },
      },
      timestamp: new Date().toISOString(),
    };

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);

    // Record hourly snapshot (non-blocking — never fails the health check)
    if (now - lastRecordedAt >= RECORD_INTERVAL_MS) {
      lastRecordedAt = now;
      try {
        recordHealthSnapshot({
          ok: body.ok,
          horizonConnected: horizon.connected,
          horizonLatencyMs,
          contractStatus: contract.status ?? "unknown",
          dbOk,
          details: { network: body.network, contractId },
        });
        pruneHealthHistory();
      } catch (err) {
        console.error("Failed to record health snapshot", err);
      }
    }

    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/health/history?hours=24
 * Returns hourly health snapshots for trend analysis (capped at 30 days).
 */
healthRouter.get("/history", async (req, res, next) => {
  try {
    const hours = Math.min(
      parseInt(req.query.hours ?? "24", 10) || 24,
      720 // cap at 30 days
    );
    const history = getHealthHistory(hours);
    res.json({ ok: true, data: history, count: history.length, periodHours: hours });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/health/sla?days=30
 * Returns SLA statistics: uptime %, latency stats, snapshot counts (capped at 365 days).
 */
healthRouter.get("/sla", async (req, res, next) => {
  try {
    const days = Math.min(
      parseInt(req.query.days ?? "30", 10) || 30,
      365
    );
    const sla = getSLAStats(days);
    res.json({ ok: true, data: sla });
  } catch (err) {
    next(err);
  }
});

/** Reset cached health (for tests). */
export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
  lastRecordedAt = 0;
}
