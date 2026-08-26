import client from "prom-client";

const metrics = {
  distributeCallsTotal: 0,
  transactionsSuccessfulTotal: 0,
  transactionsFailedTotal: 0,
  horizonResponseTimeMsTotal: 0,
  horizonResponseTimeCount: 0,
  // DoS protection counters (#426)
  oversizedRequestsRejectedTotal: 0,
  dosRateLimitedTotal: 0,
  // Detailed health check component response times (#423)
  healthCheckDatabaseResponseTimeMs: 0,
  healthCheckHorizonResponseTimeMs: 0,
  healthCheckSorobanResponseTimeMs: 0,
  healthCheckCacheResponseTimeMs: 0,
  healthCheckTotal: 0,
};

// Comprehensive Prometheus metrics (#816)
const register = new client.Registry();

// Counter for function invocations
const contractFunctionDuration = new client.Histogram({
  name: "stellar_contract_function_duration_seconds",
  help: "Duration of contract function calls in seconds",
  labelNames: ["contractId", "functionName"],
  registers: [register],
});

// Counter for RPC operations
const rpcOperationDuration = new client.Histogram({
  name: "stellar_rpc_operation_duration_seconds",
  help: "Duration of Soroban RPC operations in seconds",
  labelNames: ["operationType"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Database query duration
const dbQueryDuration = new client.Histogram({
  name: "stellar_db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["queryType"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

// Cache hit/miss counters
const cacheHits = new client.Counter({
  name: "stellar_cache_hits_total",
  help: "Total cache hits",
  labelNames: ["namespace"],
  registers: [register],
});

const cacheMisses = new client.Counter({
  name: "stellar_cache_misses_total",
  help: "Total cache misses",
  labelNames: ["namespace"],
  registers: [register],
});

// Rate limiter metrics
const rateLimitHits = new client.Counter({
  name: "stellar_rate_limit_hits_total",
  help: "Total rate limit hits",
  labelNames: ["dimension"],
  registers: [register],
});

// Active connections gauge
const activeConnections = new client.Gauge({
  name: "stellar_active_connections",
  help: "Number of active database connections",
  registers: [register],
});

function formatMetricValue(value) {
  return Number.isFinite(value) ? value : 0;
}

export function recordDistributeCall() {
  metrics.distributeCallsTotal += 1;
}

export function recordTransactionSuccess() {
  metrics.transactionsSuccessfulTotal += 1;
}

export function recordTransactionFailure() {
  metrics.transactionsFailedTotal += 1;
}

// DoS protection metrics (#426)
export function recordOversizedRequest() {
  metrics.oversizedRequestsRejectedTotal += 1;
}

export function recordDoSRejection() {
  metrics.dosRateLimitedTotal += 1;
}

// Detailed health check metrics (#423)
export function recordDetailedHealthCheck({ databaseMs, horizonMs, sorobanMs, cacheMs }) {
  metrics.healthCheckTotal += 1;
  if (Number.isFinite(databaseMs) && databaseMs >= 0)
    metrics.healthCheckDatabaseResponseTimeMs = databaseMs;
  if (Number.isFinite(horizonMs) && horizonMs >= 0)
    metrics.healthCheckHorizonResponseTimeMs = horizonMs;
  if (Number.isFinite(sorobanMs) && sorobanMs >= 0)
    metrics.healthCheckSorobanResponseTimeMs = sorobanMs;
  if (Number.isFinite(cacheMs) && cacheMs >= 0)
    metrics.healthCheckCacheResponseTimeMs = cacheMs;
}

export function recordHorizonResponseTime(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  metrics.horizonResponseTimeMsTotal += durationMs;
  metrics.horizonResponseTimeCount += 1;
}

export function getMetricsSnapshot() {
  const averageHorizonResponseTimeMs =
    metrics.horizonResponseTimeCount === 0
      ? 0
      : metrics.horizonResponseTimeMsTotal / metrics.horizonResponseTimeCount;

  return {
    ...metrics,
    averageHorizonResponseTimeMs,
  };
}

export function prometheusMetrics() {
  const snapshot = getMetricsSnapshot();
  const legacyMetrics = [
    "# HELP stellar_distribute_calls_total Total distribute endpoint calls.",
    "# TYPE stellar_distribute_calls_total counter",
    `stellar_distribute_calls_total ${snapshot.distributeCallsTotal}`,
    "# HELP stellar_transactions_successful_total Successful distribute transactions built by the API.",
    "# TYPE stellar_transactions_successful_total counter",
    `stellar_transactions_successful_total ${snapshot.transactionsSuccessfulTotal}`,
    "# HELP stellar_transactions_failed_total Failed distribute transaction build attempts.",
    "# TYPE stellar_transactions_failed_total counter",
    `stellar_transactions_failed_total ${snapshot.transactionsFailedTotal}`,
    "# HELP stellar_horizon_response_time_average_ms Average Horizon response time in milliseconds.",
    "# TYPE stellar_horizon_response_time_average_ms gauge",
    `stellar_horizon_response_time_average_ms ${formatMetricValue(
      snapshot.averageHorizonResponseTimeMs,
    )}`,
    "# HELP stellar_horizon_response_time_count Horizon response time observations.",
    "# TYPE stellar_horizon_response_time_count counter",
    `stellar_horizon_response_time_count ${snapshot.horizonResponseTimeCount}`,
    "# HELP stellar_oversized_requests_rejected_total Requests rejected due to body size exceeding the limit.",
    "# TYPE stellar_oversized_requests_rejected_total counter",
    `stellar_oversized_requests_rejected_total ${snapshot.oversizedRequestsRejectedTotal}`,
    "# HELP stellar_dos_rate_limited_total Requests rate-limited due to repeated oversized payload attacks.",
    "# TYPE stellar_dos_rate_limited_total counter",
    `stellar_dos_rate_limited_total ${snapshot.dosRateLimitedTotal}`,
    "# HELP stellar_health_check_total Total detailed health check requests.",
    "# TYPE stellar_health_check_total counter",
    `stellar_health_check_total ${snapshot.healthCheckTotal}`,
    "# HELP stellar_health_database_response_time_ms Last database health check response time in milliseconds.",
    "# TYPE stellar_health_database_response_time_ms gauge",
    `stellar_health_database_response_time_ms ${formatMetricValue(snapshot.healthCheckDatabaseResponseTimeMs)}`,
    "# HELP stellar_health_horizon_response_time_ms Last Horizon health check response time in milliseconds.",
    "# TYPE stellar_health_horizon_response_time_ms gauge",
    `stellar_health_horizon_response_time_ms ${formatMetricValue(snapshot.healthCheckHorizonResponseTimeMs)}`,
    "# HELP stellar_health_soroban_response_time_ms Last Soroban RPC health check response time in milliseconds.",
    "# TYPE stellar_health_soroban_response_time_ms gauge",
    `stellar_health_soroban_response_time_ms ${formatMetricValue(snapshot.healthCheckSorobanResponseTimeMs)}`,
    "# HELP stellar_health_cache_response_time_ms Last cache health check response time in milliseconds.",
    "# TYPE stellar_health_cache_response_time_ms gauge",
    `stellar_health_cache_response_time_ms ${formatMetricValue(snapshot.healthCheckCacheResponseTimeMs)}`,
    "",
  ].join("\n");

  return register.metrics() + "\n" + legacyMetrics;
}

export function resetMetrics() {
  metrics.distributeCallsTotal = 0;
  metrics.transactionsSuccessfulTotal = 0;
  metrics.transactionsFailedTotal = 0;
  metrics.horizonResponseTimeMsTotal = 0;
  metrics.horizonResponseTimeCount = 0;
  metrics.oversizedRequestsRejectedTotal = 0;
  metrics.dosRateLimitedTotal = 0;
  metrics.healthCheckDatabaseResponseTimeMs = 0;
  metrics.healthCheckHorizonResponseTimeMs = 0;
  metrics.healthCheckSorobanResponseTimeMs = 0;
  metrics.healthCheckCacheResponseTimeMs = 0;
  metrics.healthCheckTotal = 0;
  register.resetMetrics();
}

// New comprehensive metrics functions (#816)
export function recordContractFunctionDuration(contractId, functionName, durationSeconds) {
  contractFunctionDuration.observe({ contractId, functionName }, durationSeconds);
}

export function recordRpcOperationDuration(operationType, durationSeconds) {
  rpcOperationDuration.observe({ operationType }, durationSeconds);
}

export function recordDbQueryDuration(queryType, durationSeconds) {
  dbQueryDuration.observe({ queryType }, durationSeconds);
}

export function recordCacheHit(namespace) {
  cacheHits.inc({ namespace });
}

export function recordCacheMiss(namespace) {
  cacheMisses.inc({ namespace });
}

export function recordRateLimitHit(dimension) {
  rateLimitHits.inc({ dimension });
}

export function setActiveConnections(count) {
  activeConnections.set(count);
}
