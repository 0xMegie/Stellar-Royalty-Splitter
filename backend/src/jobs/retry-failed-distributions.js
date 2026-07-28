/**
 * Background job: Retry failed distribution transactions with exponential backoff.
 *
 * Retry strategy:
 *   - Scans for failed 'distribute' transactions where retry_count < 3
 *   - Exponential backoff: 1 minute, 5 minutes, 15 minutes between retries
 *   - Each retry rebuilds the transaction XDR via the Soroban RPC
 *   - Every attempt is logged to the audit trail
 *   - After 3 failed retries, admin is notified via email
 *
 * Retry state persistence:
 *   - retry_count and last_retry_time are persisted in the transactions table
 *   - On restart, the job picks up where it left off (no in-memory state needed)
 *   - Status transitions: failed -> pending (on retry) -> confirmed/failed
 */

import {
  getRetryEligibleTransactions,
  markTransactionRetrying,
  addAuditLog,
  MAX_RETRY_COUNT,
  RETRY_BACKOFF_MS,
} from "../database/index.js";
import { retryBuildTx, addressToScVal } from "../stellar.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import logger from "../logger.js";
import { parsePositiveInt } from "../utils.js";
import { db } from "../database/core.js";

/** How often the scheduler checks for retry-eligible transactions (default 30s). */
const RETRY_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.RETRY_CHECK_INTERVAL_MS,
  30_000
);

/** Track which transactions we've already alerted on to avoid duplicate notifications. */
const alertedExhaustedIds = new Set();

/**
 * Get the backoff delay in milliseconds for a given retry_count.
 * retry_count 0 -> 1min (first retry), 1 -> 5min (second), 2 -> 15min (third)
 */
export function getBackoffDelay(retryCount) {
  return RETRY_BACKOFF_MS[retryCount] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
}

/**
 * Send admin alert that a transaction has exhausted all retries.
 */
export async function sendRetryExhaustedAlert(transaction) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL;

  logger.error("Distribution retry exhausted — all 3 retries failed", {
    event: "retry_exhausted",
    transactionId: transaction.id,
    contractId: transaction.contractId,
    initiatorAddress: transaction.initiatorAddress,
    tokenId: transaction.tokenId,
    retryCount: transaction.retry_count,
    lastError: transaction.errorMessage,
  });

  if (!adminEmail) {
    logger.warn("ADMIN_ALERT_EMAIL not configured; skipping retry-exhausted email notification", {
      transactionId: transaction.id,
    });
    return { sent: false, reason: "admin_email_not_configured" };
  }

  if (!isEmailConfigured()) {
    logger.warn("SMTP not configured; skipping retry-exhausted email notification", {
      transactionId: transaction.id,
    });
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = `[ALERT] Distribution retry exhausted — Transaction #${transaction.id}`;
  const text = [
    `A distribution transaction has failed all ${MAX_RETRY_COUNT} retry attempts.`,
    ``,
    `Transaction ID: ${transaction.id}`,
    `Contract ID: ${transaction.contractId}`,
    `Initiator: ${transaction.initiatorAddress}`,
    `Token ID: ${transaction.tokenId ?? "N/A"}`,
    `Requested Amount: ${transaction.requestedAmount ?? "N/A"}`,
    `Retry Count: ${transaction.retry_count}`,
    `Last Retry: ${transaction.last_retry_time ?? "N/A"}`,
    `Last Error: ${transaction.errorMessage ?? "Unknown"}`,
    `Original Timestamp: ${transaction.timestamp}`,
    ``,
    `Manual intervention is required.`,
  ].join("\n");

  const html = `
    <h2>⚠️ Distribution Retry Exhausted</h2>
    <p>A distribution transaction has failed all <strong>${MAX_RETRY_COUNT}</strong> retry attempts and requires manual intervention.</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
      <tr><td><strong>Transaction ID</strong></td><td>${transaction.id}</td></tr>
      <tr><td><strong>Contract ID</strong></td><td>${transaction.contractId}</td></tr>
      <tr><td><strong>Initiator</strong></td><td>${transaction.initiatorAddress}</td></tr>
      <tr><td><strong>Token ID</strong></td><td>${transaction.tokenId ?? "N/A"}</td></tr>
      <tr><td><strong>Requested Amount</strong></td><td>${transaction.requestedAmount ?? "N/A"}</td></tr>
      <tr><td><strong>Retry Count</strong></td><td>${transaction.retry_count}</td></tr>
      <tr><td><strong>Last Retry</strong></td><td>${transaction.last_retry_time ?? "N/A"}</td></tr>
      <tr><td><strong>Last Error</strong></td><td>${transaction.errorMessage ?? "Unknown"}</td></tr>
      <tr><td><strong>Original Timestamp</strong></td><td>${transaction.timestamp}</td></tr>
    </table>
    <p>Please investigate and resolve this issue manually.</p>
  `;

  try {
    const result = await sendEmail({ to: adminEmail, subject, html, text });
    if (result.sent) {
      logger.info("Retry-exhausted alert email sent", {
        transactionId: transaction.id,
        adminEmail,
      });
    }
    return result;
  } catch (error) {
    logger.error("Failed to send retry-exhausted alert email", {
      transactionId: transaction.id,
      error: error.message,
    });
    return { sent: false, reason: error.message };
  }
}

/**
 * Attempt to retry a single failed transaction.
 * Returns the outcome: 'retried', 'exhausted', or 'error'.
 */
export async function retryTransaction(transaction, now = new Date()) {
  const retryNumber = transaction.retry_count + 1;
  const backoffMs = getBackoffDelay(transaction.retry_count);

  logger.info("Retrying failed distribution", {
    event: "distribution_retry_attempt",
    transactionId: transaction.id,
    contractId: transaction.contractId,
    retryNumber,
    maxRetries: MAX_RETRY_COUNT,
    backoffMs,
  });

  // Log the retry attempt to audit trail
  addAuditLog(transaction.contractId, "distribution_retry_attempt", "system", {
    transactionId: transaction.id,
    retryNumber,
    maxRetries: MAX_RETRY_COUNT,
    backoffMs,
    previousError: transaction.errorMessage,
  });

  try {
    // Rebuild the transaction XDR — this fetches a fresh sequence number
    // and re-simulates the contract call
    const scvlArgs = transaction.tokenId ? [addressToScVal(transaction.tokenId)] : [];
    await retryBuildTx(
      transaction.initiatorAddress,
      transaction.contractId,
      "distribute",
      scvlArgs
    );

    // XDR rebuild succeeded — mark as retrying (status -> pending, increment retry_count)
    markTransactionRetrying(transaction.id, now);

    addAuditLog(transaction.contractId, "distribution_retry_scheduled", "system", {
      transactionId: transaction.id,
      retryNumber,
      status: "pending",
    });

    logger.info("Distribution retry scheduled successfully", {
      event: "distribution_retry_scheduled",
      transactionId: transaction.id,
      retryNumber,
    });

    return "retried";
  } catch (error) {
    const errorMessage = error?.message ?? String(error);

    // Rebuild failed — update retry metadata but keep status as failed
    // We still increment retry_count and update last_retry_time
    markTransactionRetrying(transaction.id, now);

    // Then immediately mark as failed again with the new error
    db.prepare(`
      UPDATE transactions
      SET status = 'failed',
          errorMessage = ?
      WHERE id = ?
    `).run(`Retry ${retryNumber} failed: ${errorMessage}`, transaction.id);

    addAuditLog(transaction.contractId, "distribution_retry_failed", "system", {
      transactionId: transaction.id,
      retryNumber,
      error: errorMessage,
    });

    logger.warn("Distribution retry failed", {
      event: "distribution_retry_failed",
      transactionId: transaction.id,
      retryNumber,
      error: errorMessage,
    });

    // Check if all retries are now exhausted
    if (retryNumber >= MAX_RETRY_COUNT) {
      const exhaustedTx = {
        ...transaction,
        retry_count: retryNumber,
        errorMessage: `Retry ${retryNumber} failed: ${errorMessage}`,
        last_retry_time: now.toISOString(),
      };

      if (!alertedExhaustedIds.has(transaction.id)) {
        alertedExhaustedIds.add(transaction.id);
        await sendRetryExhaustedAlert(exhaustedTx);

        addAuditLog(transaction.contractId, "distribution_retry_exhausted", "system", {
          transactionId: transaction.id,
          totalRetries: retryNumber,
          finalError: errorMessage,
          adminNotified: true,
        });
      }

      return "exhausted";
    }

    return "error";
  }
}

/**
 * Main retry job: scan for eligible transactions and retry them.
 * Called periodically by the scheduler.
 *
 * @param {Date} [now] - Current time (injectable for testing)
 * @returns {Object} Summary of what was processed
 */
export async function retryFailedDistributions(now = new Date()) {
  const eligible = getRetryEligibleTransactions(now);

  if (eligible.length === 0) {
    return { processed: 0, retried: 0, exhausted: 0, errors: 0 };
  }

  logger.info("Found retry-eligible failed distributions", {
    count: eligible.length,
  });

  let retried = 0;
  let exhausted = 0;
  let errors = 0;

  for (const transaction of eligible) {
    try {
      const outcome = await retryTransaction(transaction, now);
      if (outcome === "retried") retried++;
      else if (outcome === "exhausted") exhausted++;
      else errors++;
    } catch (error) {
      errors++;
      logger.error("Unexpected error processing retry", {
        transactionId: transaction.id,
        error: error.message,
      });
    }
  }

  const result = { processed: eligible.length, retried, exhausted, errors };
  logger.info("Retry job completed", result);
  return result;
}

/**
 * Start the retry scheduler. Returns a stop function.
 */
export function startRetryScheduler() {
  logger.info("Starting failed-distribution retry scheduler", {
    intervalMs: RETRY_CHECK_INTERVAL_MS,
    maxRetries: MAX_RETRY_COUNT,
    backoffMs: RETRY_BACKOFF_MS,
  });

  const interval = setInterval(async () => {
    try {
      await retryFailedDistributions();
    } catch (error) {
      logger.error("Retry scheduler error", { error: error.message });
    }
  }, RETRY_CHECK_INTERVAL_MS);

  // Don't block process exit on this timer
  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Retry scheduler stopped");
    },
    interval,
  };
}

/** Reset internal state (for tests). */
export function _resetAlertedExhaustedIds() {
  alertedExhaustedIds.clear();
}

export const _config = {
  RETRY_CHECK_INTERVAL_MS,
  MAX_RETRY_COUNT,
  RETRY_BACKOFF_MS,
};
