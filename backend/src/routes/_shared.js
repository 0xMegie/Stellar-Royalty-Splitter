import { retryBuildTx } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database/index.js";
import { startSpan } from "../tracing.js";

/**
 * Shared pattern for transaction-building routes:
 * 1. Record transaction in database
 * 2. Build transaction XDR
 * 3. Log audit event
 * 4. Return XDR and transaction ID
 *
 * This eliminates duplication across initialize, distribute, and similar routes.
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
  // Record transaction in database for audit trail
  const transactionId = recordTransaction(
    contractId,
    transactionType,
    walletAddress,
    transactionMetadata
  );

  // Build the transaction XDR (instrumented span for RPC call latency)
  const txXdr = await startSpan(
    `rpc.${transactionType}`,
    {
      "contract.id": contractId,
      "wallet.address": walletAddress,
      "operation.type": transactionType,
    },
    () => retryBuildTx(walletAddress, contractId, transactionType, scvlArgs)
  );

  // Log the audit event
  addAuditLog(contractId, auditAction, walletAddress, {
    transactionId,
    ...auditMetadata,
  });

  return { xdr: txXdr, transactionId };
}
