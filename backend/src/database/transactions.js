/**
 * Transaction tracking and distribution payout functions.
 * Handles recording, updating, and querying transactions and their related payouts.
 */

import { db, countWrite } from "./core.js";

/**
 * Exponential backoff delays in milliseconds for each retry attempt.
 * retry_count 0 -> wait 1m, retry_count 1 -> wait 5m, retry_count 2 -> wait 15m
 */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];
export const MAX_RETRY_COUNT = 3;

export function recordTransaction(contractId, type, initiatorAddress, data) {
  const { requestedAmount, tokenId } = data;

  const stmt = db.prepare(`
    INSERT INTO transactions 
    (contractId, type, initiatorAddress, requestedAmount, tokenId, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const result = stmt.run(contractId, type, initiatorAddress, requestedAmount, tokenId);
  countWrite();
  return result.lastInsertRowid;
}

export function updateTransactionHash(transactionId, txHash) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET txHash = ? 
    WHERE id = ?
  `);

  stmt.run(txHash, transactionId);
  countWrite();
}

export function updateTransactionStatus(txHash, status, blockTime = null, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET status = ?, blockTime = ?, errorMessage = ? 
    WHERE txHash = ?
  `);

  stmt.run(status, blockTime, errorMessage, txHash);
  countWrite();
}

export function addDistributionPayout(
  transactionId,
  contractId,
  collaboratorAddress,
  amountReceived
) {
  const stmt = db.prepare(`
    INSERT INTO distribution_payouts 
    (transactionId, contractId, collaboratorAddress, amountReceived)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(transactionId, contractId, collaboratorAddress, amountReceived);
  countWrite();
}

export function getTransactionCount(contractId) {
  const stmt = db.prepare(`SELECT COUNT(*) as total FROM transactions WHERE contractId = ?`);
  return stmt.get(contractId).total;
}

export function getTransactionHistory(contractId, limit = 50, offset = 0) {
  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time,
      COUNT(dp.id) as payoutCount
    FROM transactions t
    LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
    WHERE t.contractId = ?
    GROUP BY t.id
    ORDER BY t.timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

export function getTransactionById(transactionId) {
  const stmt = db.prepare(`
    SELECT
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time
    FROM transactions t
    WHERE t.id = ?
  `);

  return stmt.get(transactionId) ?? null;
}

export function getTransactionDetails(txHash) {
  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time
    FROM transactions t
    WHERE t.txHash = ?
  `);

  const transaction = stmt.get(txHash);

  if (!transaction) {
    return null;
  }

  const payoutsStmt = db.prepare(`
    SELECT collaboratorAddress, amountReceived
    FROM distribution_payouts
    WHERE transactionId = ?
  `);

  const payouts = payoutsStmt.all(transaction.id);

  return {
    ...transaction,
    payouts,
  };
}

// ── Retry management functions ──────────────────────────────────────────────

/**
 * Get failed distribute transactions that are eligible for retry.
 * Eligibility criteria:
 *   - status = 'failed'
 *   - type = 'distribute'
 *   - retry_count < MAX_RETRY_COUNT (3)
 *   - Enough time has passed since last_retry_time (exponential backoff)
 *     OR last_retry_time IS NULL (never retried yet)
 *
 * @param {Date} [now] - Current time (injectable for testing)
 * @returns {Array} Array of transaction objects eligible for retry
 */
export function getRetryEligibleTransactions(now = new Date()) {
  const nowIso = now.toISOString();

  // Build conditions for each backoff tier:
  // - retry_count = 0: no last_retry_time OR last_retry_time + 1min <= now
  // - retry_count = 1: last_retry_time + 5min <= now
  // - retry_count = 2: last_retry_time + 15min <= now
  const stmt = db.prepare(`
    SELECT
      id,
      txHash,
      contractId,
      type,
      initiatorAddress,
      requestedAmount,
      tokenId,
      timestamp,
      blockTime,
      status,
      errorMessage,
      retry_count,
      last_retry_time
    FROM transactions
    WHERE status = 'failed'
      AND type = 'distribute'
      AND retry_count < ?
      AND (
        last_retry_time IS NULL
        OR (retry_count = 0 AND datetime(last_retry_time, '+1 minute') <= ?)
        OR (retry_count = 1 AND datetime(last_retry_time, '+5 minutes') <= ?)
        OR (retry_count = 2 AND datetime(last_retry_time, '+15 minutes') <= ?)
      )
    ORDER BY timestamp ASC
  `);

  return stmt.all(MAX_RETRY_COUNT, nowIso, nowIso, nowIso);
}

/**
 * Mark a transaction as being retried: increment retry_count, update last_retry_time,
 * and set status back to 'pending'.
 *
 * @param {number} transactionId
 * @param {Date} [now] - Current time (injectable for testing)
 */
export function markTransactionRetrying(transactionId, now = new Date()) {
  const nowIso = now.toISOString();
  const stmt = db.prepare(`
    UPDATE transactions
    SET retry_count = retry_count + 1,
        last_retry_time = ?,
        status = 'pending',
        errorMessage = NULL,
        txHash = NULL
    WHERE id = ?
  `);

  stmt.run(nowIso, transactionId);
  countWrite();
}

/**
 * Mark a transaction as having exhausted all retries.
 * Sets status to 'failed' with a final error message.
 *
 * @param {number} transactionId
 * @param {string} errorMessage
 */
export function markTransactionRetryExhausted(transactionId, errorMessage) {
  const stmt = db.prepare(`
    UPDATE transactions
    SET status = 'failed',
        errorMessage = ?
    WHERE id = ?
  `);

  stmt.run(errorMessage, transactionId);
  countWrite();
}

/**
 * Get all failed distribute transactions that have exhausted all retries
 * (retry_count >= MAX_RETRY_COUNT).
 *
 * @returns {Array} Array of transaction objects with exhausted retries
 */
export function getRetryExhaustedTransactions() {
  const stmt = db.prepare(`
    SELECT
      id,
      txHash,
      contractId,
      type,
      initiatorAddress,
      requestedAmount,
      tokenId,
      timestamp,
      blockTime,
      status,
      errorMessage,
      retry_count,
      last_retry_time
    FROM transactions
    WHERE status = 'failed'
      AND type = 'distribute'
      AND retry_count >= ?
    ORDER BY timestamp ASC
  `);

  return stmt.all(MAX_RETRY_COUNT);
}

/**
 * Get the current retry count for a transaction.
 *
 * @param {number} transactionId
 * @returns {number} The retry count, or 0 if not found
 */
export function getTransactionRetryCount(transactionId) {
  const stmt = db.prepare(`SELECT retry_count FROM transactions WHERE id = ?`);
  const row = stmt.get(transactionId);
  return row?.retry_count ?? 0;
}
