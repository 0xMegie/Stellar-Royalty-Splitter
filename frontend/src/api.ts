// Thin client that talks to the Express backend

import { extractContractError } from "./lib/contract-errors";

const BASE = "/api";
export const SESSION_EXPIRED_EVENT = "srs:session-expired";
const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Please connect your wallet again.";

let sessionExpiryNotified = false;

function notifySessionExpired() {
  if (sessionExpiryNotified || typeof window === "undefined") return;
  sessionExpiryNotified = true;
  window.dispatchEvent(
    new CustomEvent(SESSION_EXPIRED_EVENT, {
      detail: { message: SESSION_EXPIRED_MESSAGE },
    }),
  );
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getErrorMessage(data: unknown, status: number) {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return data.error;
  }

  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const data = await readJson(res);

  if (res.status === 401) {
    notifySessionExpired();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  if (res.ok) {
    sessionExpiryNotified = false;
    return data as T;
  }

  throw new Error(getErrorMessage(data, res.status));
}

// #279: surface a structured `code + message + details` shape from
// the backend's error response instead of just `data.error`. The
// caller's `catch (e)` block can call `extractContractError(e)` to
// pull the same fields back out and the toast surfaces the real
// failure reason (`Caller is not the contract admin (code 2)`)
// rather than a generic "transaction failed".
export class BackendApiError extends Error {
  code: string | number | null;
  details?: string;
  status: number;
  constructor(
    status: number,
    code: string | number | null,
    message: string,
    details?: string,
  ) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readErrorBody(status: number, data: unknown): BackendApiError {
  const parsed = extractContractError(data ?? { error: "Request failed" });
  return new BackendApiError(
    status,
    parsed.code,
    parsed.message,
    parsed.details,
  );
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export interface TransactionRecord {
  id: number;
  txHash: string | null;
  contractId: string;
  type: "initialize" | "distribute";
  initiatorAddress: string;
  requestedAmount: string | null;
  tokenId: string | null;
  timestamp: string;
  blockTime: string | null;
  status: "pending" | "confirmed" | "failed";
  errorMessage: string | null;
  payoutCount?: number;
}

export interface TransactionDetails extends TransactionRecord {
  payouts?: Array<{
    collaboratorAddress: string;
    amountReceived: string;
  }>;
}

export interface AuditLogEntry {
  id: number;
  contractId: string;
  action: string;
  user: string | null;
  details: string | null;
  timestamp: string;
}

export interface SecondarySale {
  id: number;
  nftId: string;
  previousOwner: string;
  newOwner: string;
  salePrice: string;
  saleToken: string;
  royaltyAmount: string;
  royaltyRate: number;
  timestamp: string;
  transactionHash: string | null;
}

export interface RoyaltyStats {
  totalSecondarySales: number;
  totalRoyaltiesGenerated: number | string;
  lastDistribution: {
    timestamp: string;
    totalRoyaltiesDistributed: string;
    numberOfSales: number;
  } | null;
}

export const api = {
  initialize: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
  }) => post<{ xdr: string; transactionId: number }>("/initialize", body),

  distribute: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
  }) => post<{ xdr: string; transactionId: number }>("/distribute", body),

  getContractBalance: (contractId: string, tokenId: string) =>
    get<{ balance: string }>(
      `/contract/balance/${contractId}?tokenId=${encodeURIComponent(tokenId)}`,
    ),

  getCollaborators: (contractId: string) =>
    get<{ address: string; basisPoints: number }[]>(
      `/collaborators/${contractId}`,
    ),

  // Transaction History & Audit Log APIs
  getTransactionHistory: (contractId: string, limit = 50, offset = 0) =>
    get<{
      success: boolean;
      data: TransactionRecord[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/history/${contractId}?limit=${limit}&offset=${offset}`),

  getTransactionDetails: (txHash: string) =>
    get<{ success: boolean; data: TransactionDetails }>(
      `/transaction/${txHash}`,
    ),

  confirmTransaction: (
    txHash: string,
    body: {
      status: "pending" | "confirmed" | "failed";
      blockTime?: string;
      errorMessage?: string;
      transactionId?: number;
    },
  ) =>
    post<{ success: boolean; message: string }>(
      `/transaction/confirm/${txHash}`,
      body,
    ),

  getAuditLog: (contractId: string, limit = 100, offset = 0) =>
    get<{ success: boolean; data: AuditLogEntry[] }>(
      `/audit/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  addAuditLog: (
    contractId: string,
    body: {
      action: string;
      user?: string;
      details?: Record<string, unknown>;
    },
  ) =>
    post<{ success: boolean; message: string }>(`/audit/${contractId}`, body),

  // Secondary Royalty APIs
  recordSecondarySale: (body: {
    contractId: string;
    walletAddress: string;
    nftId: string;
    previousOwner: string;
    newOwner: string;
    salePrice: number;
    saleToken: string;
    royaltyRate: number;
  }) =>
    post<{ xdr: string; transactionId: number; royaltyAmount: number }>(
      "/secondary-royalty",
      body,
    ),

  setRoyaltyRate: (body: {
    contractId: string;
    walletAddress: string;
    royaltyRate: number;
  }) =>
    post<{ xdr: string; transactionId: number }>(
      "/secondary-royalty/set-rate",
      body,
    ),

  distributeSecondaryRoyalties: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
  }) =>
    post<{
      xdr: string;
      transactionId: number;
      numberOfSales: number;
      totalRoyalties: string;
    }>("/secondary-royalty/distribute", body),

  getRoyaltyStats: (contractId: string) =>
    get<RoyaltyStats>(`/secondary-royalty/stats/${contractId}`),

  getSecondarySales: (
    contractId: string,
    limit = 50,
    offset = 0,
    nftId?: string,
  ) =>
    get<{ sales: SecondarySale[]; total: number }>(
      `/secondary-royalty/sales/${contractId}?limit=${limit}&offset=${offset}${nftId ? `&nftId=${nftId}` : ""}`,
    ),

  getSecondaryRoyaltyDistributions: (
    contractId: string,
    limit = 50,
    offset = 0,
  ) =>
    get<{
      distributions: Array<{
        id: number;
        transactionId: number;
        totalRoyaltiesDistributed: string;
        numberOfSales: number;
        timestamp: string;
        txHash: string | null;
        status: string;
        initiatorAddress: string;
      }>;
      total?: number;
    }>(
      `/secondary-royalty/distributions/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  // NEW: Fetch secondary royalty pool balance
  getSecondaryRoyaltyPool: (contractId: string) =>
    get<{ poolBalance: string }>(`/secondary-royalty/pool/${contractId}`),

  // NEW: Fetch contract status
  getContractStatus: (contractId: string) =>
    get<{ initialized: boolean }>(`/contract/status/${contractId}`),

  // NEW: Fetch royalty rate from contract
  getRoyaltyRate: (contractId: string) =>
    get<{ royaltyRate: number }>(`/secondary-royalty/rate/${contractId}`),

  // Analytics API
  getAnalytics: (
    contractId: string,
    dateRange?: { start: string; end: string },
  ) =>
    get<{
      success: boolean;
      data: {
        totalDistributed: number;
        totalTransactions: number;
        averagePayout: number;
        topEarners: Array<{
          address: string;
          totalEarned: number;
          payouts: number;
        }>;
        distributionTrends: Array<{
          date: string;
          amount: number;
          count: number;
        }>;
        collaboratorStats: Array<{
          address: string;
          totalEarned: number;
          payoutCount: number;
        }>;
      };
      message?: string;
    }>(
      `/analytics/${contractId}${dateRange ? `?start=${dateRange.start}&end=${dateRange.end}` : ""}`,
    ),

  // Payment Preferences (#584)
  getPaymentPreference: (walletAddress: string) =>
    get<{
      success: boolean;
      data: { walletAddress: string; paymentMethod: string; updatedAt: string };
    }>(`/preferences/payment?walletAddress=${encodeURIComponent(walletAddress)}`).then(
      (res) => res.data,
    ),

  savePaymentPreference: (
    walletAddress: string,
    paymentMethod: "direct_transfer" | "usdc" | "xlm",
  ) =>
    post<{
      success: boolean;
      data: { walletAddress: string; paymentMethod: string; updatedAt: string };
    }>("/preferences/payment", { walletAddress, paymentMethod }).then(
      (res) => res.data,
    ),

  // #597: CSV Bulk Import
  downloadCsvTemplate: () => {
    window.open(`${BASE}/csv-import/template`, "_blank");
  },

  validateCsv: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return post<{ success: boolean; data: { valid: Array<{ rowIndex: number; address: string; share: number }>; errors: Array<{ rowIndex: number; address: string; share: string; error: string }> } }>("/csv-import/validate", formData as unknown as Record<string, unknown>);
  },

  previewCsv: (file: File, contractId?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    if (contractId) formData.append("contractId", contractId);
    return post<{ success: boolean; data: { importId: string | null; fileName: string; totalRows: number; validRows: Array<{ rowIndex: number; address: string; share: number }>; errorRows: Array<{ rowIndex: number; address: string; share: string; error: string }>; summary: { total: number; valid: number; errors: number } } }>("/csv-import/preview", formData as unknown as Record<string, unknown>);
  },

  importCsv: (file: File, contractId: string, importedBy?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("contractId", contractId);
    if (importedBy) formData.append("importedBy", importedBy);
    return post<{ success: boolean; data: { importId: number; fileName: string; summary: { total: number; successCount: number; errorCount: number } } }>("/csv-import/import", formData as unknown as Record<string, unknown>);
  },

  getCsvImportHistory: (contractId: string) =>
    get<{ success: boolean; data: Array<{ id: number; contractId: string; fileName: string; rowCount: number; importedBy: string; status: string; error_message: string | null; created_at: string; completed_at: string | null }> }>(`/csv-import/history/${contractId}`),

  getCsvImportResults: (importId: number) =>
    get<{ success: boolean; data: { import: Record<string, unknown>; results: Array<{ id: number; rowIndex: number; address: string; share: number; status: string; errorMessage: string | null }>; summary: { total: number; successCount: number; errorCount: number } } }>(`/csv-import/results/${importId}`),

  // #595: Contributor Tax Information
  getContributorTax: (walletAddress: string) =>
    get<{ success: boolean; data: { id: number; walletAddress: string; tax_status: string | null; tax_id: string | null; w9_file_name: string | null; created_at: string; updated_at: string } | null }>(`/contributor-tax/${walletAddress}`),

  saveContributorTax: (walletAddress: string, tax_status: string, tax_id?: string) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/contributor-tax", { walletAddress, tax_status, tax_id }),

  uploadTaxDocument: (walletAddress: string, file: File) => {
    const formData = new FormData();
    formData.append("taxDocument", file);
    return post<{ success: boolean; data: Record<string, unknown>; file: { name: string; size: number } }>(`/contributor-tax/upload/${walletAddress}`, formData as unknown as Record<string, unknown>);
  },

  getTaxDocument: (walletAddress: string) => {
    window.open(`${BASE}/contributor-tax/document/${walletAddress}`, "_blank");
  },

  getTaxComplianceReport: () =>
    get<{ success: boolean; data: Array<Record<string, unknown>>; summary: { total: number; compliant: number; nonCompliant: number; missing: number } }>("/contributor-tax/report/compliance"),

  getContributorsMissingTaxInfo: () =>
    get<{ success: boolean; data: Array<Record<string, unknown>>; count: number }>("/contributor-tax/report/missing"),

  // #594: Real-Time Notifications
  getNotifications: (walletAddress: string, limit = 50, offset = 0) =>
    get<{ success: boolean; data: Array<{ id: number; walletAddress: string; type: string; title: string; message: string | null; data: string | null; read: number; created_at: string }>; unreadCount: number }>(`/notifications/${walletAddress}?limit=${limit}&offset=${offset}`),

  getUnreadNotificationCount: (walletAddress: string) =>
    get<{ success: boolean; count: number }>(`/notifications/${walletAddress}/unread-count`),

  markNotificationRead: (id: number) =>
    post<{ success: boolean }>(`/notifications/${id}/read`, {}),

  markAllNotificationsRead: (walletAddress: string) =>
    post<{ success: boolean }>(`/notifications/read-all/${walletAddress}`, {}),

  deleteNotification: (id: number) =>
    request<{ success: boolean }>(`/notifications/${id}`, { method: "DELETE" }),

  sendNotification: (walletAddress: string, type: string, title: string, message?: string, data?: Record<string, unknown>) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/notifications/send", { walletAddress, type, title, message, data }),

  getNotificationPreferences: (walletAddress: string) =>
    get<{ success: boolean; data: { walletAddress: string; email_enabled: number; in_app_enabled: number; sms_enabled: number; notify_distribution: number; notify_payment: number; notify_failure: number; notify_hold: number } }>(`/notifications/preferences/${walletAddress}`),

  saveNotificationPreferences: (prefs: { walletAddress: string; email_enabled?: boolean; in_app_enabled?: boolean; sms_enabled?: boolean; notify_distribution?: boolean; notify_payment?: boolean; notify_failure?: boolean; notify_hold?: boolean }) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/notifications/preferences", prefs),

  // #596: Payment Hold/Release
  placePaymentHold: (transactionId: number, holdReason: string, holdUntil?: string, placedBy?: string) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/payment-holds/place", { transactionId, holdReason, holdUntil, placedBy }),

  releasePaymentHold: (transactionId: number, releasedBy?: string, approvalNote?: string) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/payment-holds/release", { transactionId, releasedBy, approvalNote }),

  approveHoldRelease: (transactionId: number, approvedBy?: string, approvalNote?: string) =>
    post<{ success: boolean; data: Record<string, unknown> }>("/payment-holds/approve-release", { transactionId, approvedBy, approvalNote }),

  getTransactionWithHold: (transactionId: number) =>
    get<{ success: boolean; data: Record<string, unknown> }>(`/payment-holds/transaction/${transactionId}`),

  getHeldTransactions: (contractId: string, status = "active") =>
    get<{ success: boolean; data: Array<Record<string, unknown>>; count: number }>(`/payment-holds/contract/${contractId}?status=${status}`),

  getAllHeldTransactions: (status = "active") =>
    get<{ success: boolean; data: Array<Record<string, unknown>>; count: number }>(`/payment-holds/all?status=${status}`),

  getPendingHoldReleases: () =>
    get<{ success: boolean; data: Array<Record<string, unknown>>; count: number }>("/payment-holds/pending-release"),

  getHoldAuditTrail: (transactionId: number) =>
    get<{ success: boolean; data: Array<{ id: number; transactionId: number; action: string; reason: string | null; performedBy: string | null; details: string | null; created_at: string }> }>(`/payment-holds/audit/${transactionId}`),
};
