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
    "",
  ].join("\n");
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
}
