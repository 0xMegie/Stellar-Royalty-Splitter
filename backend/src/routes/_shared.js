import { retryBuildTx } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database/index.js";
import { startTracking } from "../transaction-finality.js";
import logger from "../logger.js";

/**
 * Shared pattern for transaction-building routes:
 * 1. Record transaction in database
 * 2. Build transaction XDR
 * 3. Log audit event
 * 4. Return XDR and transaction ID
 *
 * This eliminates duplication across initialize, distribute, and similar routes.
 *
 * Also emits structured lifecycle logs (#745) so a distribution or
 * initialization can be traced end-to-end: "started" before the DB record is
 * written, "simulation_built" once `retryBuildTx` returns unsigned XDR ready
 * for the wallet to sign, and "failed" if any step throws. There is no
 * "submitted"/"confirmed" step here — this handler only builds XDR for the
 * frontend to sign and submit directly to the network; the backend never
 * observes the signed submission or its on-chain confirmation.
 */
export async function buildAndRecordTransaction({
  contractId,
  walletAddress,
  transactionType,
  scvlArgs,
  auditAction,
  auditMetadata,
  transactionMetadata = {},
}) {
  const startedAt = Date.now();

  logger.info("transaction build started", {
    transactionType,
    contractId,
    walletAddress,
  });

  try {
    // Record transaction in database for audit trail
    const transactionId = recordTransaction(
      contractId,
      transactionType,
      walletAddress,
      transactionMetadata
    );

    // Build the transaction XDR
    const txXdr = await retryBuildTx(walletAddress, contractId, transactionType, scvlArgs);

    // Log the audit event
    addAuditLog(contractId, auditAction, walletAddress, {
      transactionId,
      ...auditMetadata,
    });

    logger.info("transaction build succeeded", {
      transactionType,
      contractId,
      walletAddress,
      transactionId,
      durationMs: Date.now() - startedAt,
    });

    // Start best-effort finality tracking in the background.
    // The tx hash is not known yet (the frontend hasn't submitted the XDR),
    // so we pass null here.  The client can attach the hash later via
    // POST /api/v1/transactions/:id/finality with { txHash }.
    try {
      startTracking({ transactionId, txHash: null });
    } catch (trackErr) {
      // Finality tracking is best-effort — never fail the build response
      logger.warn("Failed to start finality tracking (non-fatal)", {
        transactionId,
        error: trackErr?.message ?? String(trackErr),
      });
    }

    return { xdr: txXdr, transactionId };
  } catch (err) {
    logger.warn("transaction build failed", {
      transactionType,
      contractId,
      walletAddress,
      durationMs: Date.now() - startedAt,
      status: err?.status,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
