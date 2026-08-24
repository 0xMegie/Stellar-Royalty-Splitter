import { Router } from "express";
import { getMigrationVersion, checkDatabase } from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkSorobanConnectivity,
  getCacheStatus,
} from "../stellar.js";
import { recordDetailedHealthCheck } from "../metrics.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
let cachedHealth = null;
let cacheExpiresAt = 0;

/**
 * GET /api/v1/health
 * Operator health: DB migration version, network, Horizon, and optional contract status.
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const [horizon, contract] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
    ]);

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    const body = {
      ok: horizon.connected && contractHealthy,
      dbVersion: getMigrationVersion(),
      network: getNetworkLabel(),
      horizon,
      contract,
    };

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ── Detailed health check ─────────────────────────────────────────────────

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Run a single component check with a per-call timeout.
 * Timeout is read dynamically from HEALTH_CHECK_TIMEOUT_MS so tests can
 * override it without reloading the module.
 *
 * @param {string} name - Human label used in timeout error messages.
 * @param {() => Promise<object>} fn - The check to run.
 * @param {(result: object) => boolean} [isHealthy] - Custom health predicate.
 *   Defaults to: result.connected !== false && !result.error
 * @returns {{ status: "ok"|"error", responseTimeMs: number, [key: string]: any }}
 */
async function runCheck(name, fn, isHealthy) {
  const timeoutMs = parseInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS ?? String(DEFAULT_HEALTH_CHECK_TIMEOUT_MS),
    10
  );
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    const responseTimeMs = Date.now() - start;
    const defaultHealthy = (r) => r.connected !== false && !r.error;
    const healthy = (isHealthy ?? defaultHealthy)(result);
    // Strip the raw component `status` field so our synthesised "ok"/"error"
    // is always the authoritative top-level signal (e.g. Soroban returns
    // status: "healthy", contract returns status: "initialized", etc.).
    const { status: _raw, ...rest } = result;
    return {
      status: healthy ? "ok" : "error",
      responseTimeMs,
      ...rest,
    };
  } catch (err) {
    return {
      status: "error",
      responseTimeMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * GET /api/v1/health/detailed
 * Per-component breakdown: database, Horizon RPC, Soroban RPC, contract state, cache.
 * Each check is independently capped at HEALTH_CHECK_TIMEOUT_MS (default 5 s).
 * Returns 503 when any critical component (database, horizon, soroban) is down.
 */
healthRouter.get("/detailed", async (_req, res, next) => {
  try {
    const contractId = getConfiguredContractId();

    // Contract check needs a custom predicate: no `connected` field, but
    // `deployed` + raw `status` convey health. The predicate sees the raw
    // result before `status` is stripped by runCheck.
    const isContractHealthy = (r) =>
      !r.error &&
      (!r.configured ||
        (r.deployed && r.status !== "error" && r.status !== "unreachable"));

    // All checks run in parallel; each has its own internal timeout.
    const [database, horizon, soroban, contract] = await Promise.all([
      runCheck("database", () => Promise.resolve(checkDatabase())),
      runCheck("horizon", checkHorizonConnectivity),
      runCheck("soroban", checkSorobanConnectivity),
      runCheck("contract", () => checkContractDeploymentStatus(contractId), isContractHealthy),
    ]);

    // Cache status is synchronous — wrap in the same shape.
    const cacheRaw = getCacheStatus();
    const cacheStart = Date.now();
    const cache = {
      status: "ok",
      responseTimeMs: Date.now() - cacheStart,
      ...cacheRaw,
    };

    // Record Prometheus metrics.
    recordDetailedHealthCheck({
      databaseMs: database.responseTimeMs,
      horizonMs: horizon.responseTimeMs,
      sorobanMs: soroban.responseTimeMs,
      cacheMs: cache.responseTimeMs,
    });

    // Critical: database, horizon, soroban must all be ok.
    const criticalOk =
      database.status === "ok" && horizon.status === "ok" && soroban.status === "ok";

    // Contract is critical only when configured; not_configured is fine.
    const contractOk = !contract.configured || contract.status === "ok";

    const ok = criticalOk && contractOk;

    const body = {
      ok,
      network: getNetworkLabel(),
      checkedAt: new Date().toISOString(),
      components: { database, horizon, soroban, contract, cache },
    };

    res.status(ok ? 200 : 503).json(body);
  } catch (err) {
    next(err);
  }
});

/** Reset cached health (for tests). */
export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
}
