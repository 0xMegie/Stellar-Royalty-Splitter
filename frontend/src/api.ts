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

  // Transaction volume report (#590)
  getTransactionVolume: (
    contractId: string,
    opts?: { start?: string; end?: string; bucket?: "day" | "week" | "month" },
  ) => {
    const params = new URLSearchParams();
    if (opts?.start) params.set("start", opts.start);
    if (opts?.end) params.set("end", opts.end);
    if (opts?.bucket) params.set("bucket", opts.bucket);
    const qs = params.toString();
    return get<{
      success: boolean;
      data: {
        contractId: string;
        bucket: string;
        period: { start: string; end: string };
        successRate: number | null;
        statusBreakdown: { confirmed: number; failed: number; pending: number; total: number };
        buckets: Array<{ period: string; transactions: number; volume: number }>;
      };
    }>(`/analytics/${contractId}/volume${qs ? `?${qs}` : ""}`);
  },

  // Multi-contract earnings aggregation (#568)
  getMultiContractEarnings: (
    address: string,
    opts?: { start?: string; end?: string },
  ) => {
    const params = new URLSearchParams({ address });
    if (opts?.start) params.set("start", opts.start);
    if (opts?.end) params.set("end", opts.end);
    return get<{
      success: boolean;
      data: {
        address: string;
        period: { start: string | null; end: string };
        summary: {
          totalEarned: number;
          totalPayouts: number;
          contractCount: number;
          avgPerContract: number;
        };
        contracts: Array<{
          contractId: string;
          totalEarned: number;
          payoutCount: number;
          avgPayout: number;
          lastActivity: string;
          share: number;
        }>;
      };
    }>(`/analytics/multi-contract?${params.toString()}`);
  },

  // System health (#592)
  getHealth: () =>
    get<{
      ok: boolean;
      dbVersion: number;
      network: string;
      generatedAt: string;
      horizon: { connected: boolean; url: string };
      contract: {
        configured: boolean;
        deployed: boolean;
        initialized: boolean;
        status: string;
        contractId: string | null;
      };
      dbMetrics?: {
        transactions: {
          total: number;
          confirmed: number;
          failed: number;
          pending: number;
          lastActivity: string | null;
        };
      };
    }>(`/health`),

  // Contributor suspension/deactivation (#593)
  getContributorStatuses: (contractId: string, includeActive = false) =>
    get<{
      success: boolean;
      data: Array<{
        contractId: string;
        address: string;
        status: "active" | "suspended" | "deactivated";
        reason: string | null;
        suspendedAt: string | null;
        deactivatedAt: string | null;
        updatedBy: string | null;
        updatedAt: string;
      }>;
    }>(`/contributor-status/${contractId}${includeActive ? "?includeActive=true" : ""}`),

  getContributorStatus: (contractId: string, address: string) =>
    get<{
      success: boolean;
      data: {
        contractId: string;
        address: string;
        status: "active" | "suspended" | "deactivated";
        reason: string | null;
        suspendedAt: string | null;
        deactivatedAt: string | null;
        updatedBy: string | null;
      };
    }>(`/contributor-status/${contractId}/${address}`),

  setContributorStatus: (
    contractId: string,
    address: string,
    body: {
      status: "active" | "suspended" | "deactivated";
      reason?: string;
      updatedBy?: string;
    },
  ) =>
    post<{
      success: boolean;
      data: {
        contractId: string;
        address: string;
        status: "active" | "suspended" | "deactivated";
        reason: string | null;
        suspendedAt: string | null;
        deactivatedAt: string | null;
        updatedBy: string | null;
        updatedAt: string;
      };
    }>(`/contributor-status/${contractId}/${address}`, body),

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
};
