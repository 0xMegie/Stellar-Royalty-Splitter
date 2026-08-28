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
  // Connection health monitoring (#496)
  connectionHealthTotalChecks: 0,
  connectionHealthTotalFailures: 0,
  connectionHealthConsecutiveFailures: 0,
  connectionHealthLastCheckDurationMs: 0,
  connectionHealthReconnectionsAttempted: 0,
  connectionHealthReconnectionsSucceeded: 0,
  connectionHealthReconnectionsFailed: 0,
  connectionHealthPoolUtilization: 0,
};

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

  return [
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
    // Connection health monitoring (#496)
    "# HELP stellar_db_health_checks_total Total connection health checks performed.",
    "# TYPE stellar_db_health_checks_total counter",
    `stellar_db_health_checks_total ${snapshot.connectionHealthTotalChecks}`,
    "# HELP stellar_db_health_failures_total Total connection health check failures.",
    "# TYPE stellar_db_health_failures_total counter",
    `stellar_db_health_failures_total ${snapshot.connectionHealthTotalFailures}`,
    "# HELP stellar_db_health_consecutive_failures Current consecutive connection failures.",
    "# TYPE stellar_db_health_consecutive_failures gauge",
    `stellar_db_health_consecutive_failures ${snapshot.connectionHealthConsecutiveFailures}`,
    "# HELP stellar_db_health_check_duration_ms Last connection health check duration in ms.",
    "# TYPE stellar_db_health_check_duration_ms gauge",
    `stellar_db_health_check_duration_ms ${formatMetricValue(snapshot.connectionHealthLastCheckDurationMs)}`,
    "# HELP stellar_db_reconnection_attempts_total Total reconnection attempts.",
    "# TYPE stellar_db_reconnection_attempts_total counter",
    `stellar_db_reconnection_attempts_total ${snapshot.connectionHealthReconnectionsAttempted}`,
    "# HELP stellar_db_reconnection_successes_total Total successful reconnections.",
    "# TYPE stellar_db_reconnection_successes_total counter",
    `stellar_db_reconnection_successes_total ${snapshot.connectionHealthReconnectionsSucceeded}`,
    "# HELP stellar_db_reconnection_failures_total Total failed reconnection attempts.",
    "# TYPE stellar_db_reconnection_failures_total counter",
    `stellar_db_reconnection_failures_total ${snapshot.connectionHealthReconnectionsFailed}`,
    "# HELP stellar_db_pool_utilization_percent Current database pool utilization percentage.",
    "# TYPE stellar_db_pool_utilization_percent gauge",
    `stellar_db_pool_utilization_percent ${formatMetricValue(snapshot.connectionHealthPoolUtilization)}`,
    "",
  ].join("\n");
}

export function recordConnectionHealthCheck(m) {
  metrics.connectionHealthTotalChecks = m.totalChecks ?? 0;
  metrics.connectionHealthTotalFailures = m.totalFailures ?? 0;
  metrics.connectionHealthConsecutiveFailures = m.consecutiveFailures ?? 0;
  metrics.connectionHealthLastCheckDurationMs = m.lastCheckDurationMs ?? 0;
  metrics.connectionHealthReconnectionsAttempted = m.reconnectionsAttempted ?? 0;
  metrics.connectionHealthReconnectionsSucceeded = m.reconnectionsSucceeded ?? 0;
  metrics.connectionHealthReconnectionsFailed = m.reconnectionsFailed ?? 0;
  metrics.connectionHealthPoolUtilization = m.poolUtilization ?? 0;
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
  metrics.connectionHealthTotalChecks = 0;
  metrics.connectionHealthTotalFailures = 0;
  metrics.connectionHealthConsecutiveFailures = 0;
  metrics.connectionHealthLastCheckDurationMs = 0;
  metrics.connectionHealthReconnectionsAttempted = 0;
  metrics.connectionHealthReconnectionsSucceeded = 0;
  metrics.connectionHealthReconnectionsFailed = 0;
  metrics.connectionHealthPoolUtilization = 0;
}
