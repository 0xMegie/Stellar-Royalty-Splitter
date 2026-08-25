import { Router } from "express";
import { addressToScVal, BatchTransactionBuilder } from "../stellar.js";
import { validate, batchDistributeSchema, MAX_BATCH_OPERATIONS } from "../validation.js";
import { recordTransaction, addAuditLog } from "../database/index.js";
import { sendError } from "../error-response.js";
import { invalidateContract } from "../cache.js";
import { recordTransactionFailure, recordTransactionSuccess } from "../metrics.js";

export const batchDistributeRouter = Router();

/**
 * POST /api/v1/batch-distribute
 * Body: { walletAddress, operations: [{ contractId, tokenId, amount? }, ...] }
 *
 * Batches up to MAX_BATCH_OPERATIONS (50, the Soroban-friendly cap) distribute
 * calls for one wallet into a single BatchTransactionBuilder run (#759),
 * collapsing the sequence-number/fee-estimation RPC round trips that would
 * otherwise happen once per contract into one round trip for the whole group.
 *
 * Each operation is still built and returned as its own transaction XDR —
 * batching is transparent to callers and to Soroban itself, it only reduces
 * backend RPC overhead. One operation failing (e.g. a bad contractId or a
 * simulation error) does not fail the others; per-operation results are
 * returned so the caller can retry just the failed ones.
 *
 * Existing single-operation routes (POST /distribute) are unchanged and
 * continue to work independently of this route.
 */
batchDistributeRouter.post(
  "/",
  validate(batchDistributeSchema),
  async (req, res, next) => {
    try {
      const { walletAddress, operations } = req.body;

      // Validate total requested amount and detect duplicate/overlapping
      // contract targets before doing any RPC work — a batch that pays the
      // same contract twice, or overflows a sane total, is almost always a
      // client bug rather than an intentional request.
      const seenContracts = new Set();
      const duplicateContracts = new Set();
      let totalAmount = 0n;
      for (const op of operations) {
        if (seenContracts.has(op.contractId)) {
          duplicateContracts.add(op.contractId);
        }
        seenContracts.add(op.contractId);
        if (op.amount !== undefined) {
          totalAmount += BigInt(op.amount);
        }
      }

      if (duplicateContracts.size > 0) {
        return sendError(
          res,
          400,
          "duplicate_contract_in_batch",
          `Batch contains duplicate contractId(s): ${[...duplicateContracts].join(", ")}`
        );
      }

      // Record each operation as a pending transaction up front so the
      // audit trail and history reflect the whole batch even if some
      // operations fail to build.
      const builder = new BatchTransactionBuilder(walletAddress);
      const pending = operations.map((op) => {
        const transactionId = recordTransaction(op.contractId, "distribute", walletAddress, {
          tokenId: op.tokenId,
          batch: true,
        });
        builder.add({
          contractId: op.contractId,
          method: "distribute",
          args: [addressToScVal(op.tokenId)],
        });
        return { transactionId, contractId: op.contractId, tokenId: op.tokenId };
      });

      const built = await builder.build();

      const results = built.map((result, i) => {
        const { transactionId, contractId, tokenId } = pending[i];
        if (result.ok) {
          recordTransactionSuccess();
          addAuditLog(contractId, "distribution_initiated", walletAddress, {
            transactionId,
            tokenId,
            batch: true,
          });
          invalidateContract(contractId);
          return { contractId, tokenId, transactionId, xdr: result.xdr };
        }
        recordTransactionFailure();
        return {
          contractId,
          tokenId,
          transactionId,
          error: result.error?.message ?? "Failed to build transaction",
        };
      });

      const failureCount = results.filter((r) => r.error).length;

      res.json({
        success: failureCount === 0,
        totalOperations: operations.length,
        totalAmount: totalAmount.toString(),
        succeeded: results.length - failureCount,
        failed: failureCount,
        maxBatchSize: MAX_BATCH_OPERATIONS,
        results,
      });
    } catch (err) {
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);
