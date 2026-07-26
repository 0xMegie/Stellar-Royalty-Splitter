/**
 * Database module index — re-exports all database functions.
 * Provides backwards compatibility while organizing code into focused submodules.
 */

// Core database setup
export {
  db,
  checkpointDatabase,
  closeDatabase,
  countWrite,
  initializeDatabase,
  getMigrationVersion,
} from "./core.js";

// Transaction tracking
export {
  recordTransaction,
  updateTransactionHash,
  updateTransactionStatus,
  addDistributionPayout,
  getTransactionCount,
  getTransactionHistory,
  getTransactionDetails,
  getTransactionById,
  getRetryEligibleTransactions,
  markTransactionRetrying,
  markTransactionRetryExhausted,
  getRetryExhaustedTransactions,
  getTransactionRetryCount,
  RETRY_BACKOFF_MS,
  MAX_RETRY_COUNT,
} from "./transactions.js";

// Webhooks (#295)
export { registerWebhook, listWebhooks, deleteWebhook } from "./webhooks.js";

// Audit logging
export { getAuditLog, addAuditLog, countAuditLog } from "./audit.js";

// Secondary royalties
export {
  recordSecondarySale,
  getSecondarySales,
  countSecondarySales,
  markSalesDistributed,
  recordSecondaryRoyaltyDistribution,
  getSecondaryRoyaltyDistributions,
  getRoyaltyStatistics,
} from "./secondary-royalties.js";

// Analytics
export { getAnalyticsData } from "./analytics.js";

// Payment preferences (#584)
export { getPaymentPreference, savePaymentPreference } from "./payment-preferences.js";

// Contract event archival
export {
  DEFAULT_ARCHIVE_BATCH_SIZE,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  archiveContractEvents,
  getArchiveCutoffDate,
  getArchivePolicy,
  getArchivedEventCount,
  getArchivedEvents,
  updateArchivePolicy,
} from "./archive.js";

// Email digest (#569)
export {
  subscribeEmailDigest,
  getSubscriberByToken,
  getSubscriberByWallet,
  unsubscribeByEmailDigest,
  unsubscribeByWallet,
  updateSubscriberPreferences,
  getAllEnabledSubscribers,
  getSubscribersDueForDigest,
  wasDigestSentThisWeek,
  logDigestSent,
  logDigestFailed,
  getDigestHistory,
  getEarningsForWeek,
} from "./email-digest.js";

// Disputes / ticket system (#607)
export {
  createDispute,
  getDisputeByTicketId,
  getDisputesByWallet,
  countDisputesByWallet,
  getAllDisputes,
  countAllDisputes,
  updateDisputeStatus,
  addDisputeComment,
  getDisputeComments,
} from "./disputes.js";

// Referral tracking (#603)
export {
  DEFAULT_REFERRAL_BONUS_STROOPS,
  generateReferralLink,
  getReferralLinkByWallet,
  getReferralLinkByCode,
  registerReferral,
  activateReferral,
  getReferralByReferred,
  getReferralsByReferrer,
  countReferralsByReferrer,
  awardReferralBonus,
  getBonusesByReferrer,
  getReferralDashboard,
  getAllReferrals,
  countAllReferrals,
} from "./referrals.js";

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;
