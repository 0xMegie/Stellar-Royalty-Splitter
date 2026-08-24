import React, { useState, useEffect, useCallback } from "react";
import { api, type TransactionRecord, type SecondarySale } from "../api";
import { useSettings } from "../context/SettingsContext";
import { formatCurrency, formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { Skeleton } from "./Skeleton";
import "./EarningsDashboard.css";

interface CollaboratorEarning {
  address: string;
  basisPoints: number;
  totalEarned: number;
  payoutCount: number;
  avgPayout: number;
}

interface RecentPayout {
  id: string | number;
  type: "primary" | "secondary";
  timestamp: string;
  txHash: string | null;
  amount: string | number;
  status: string;
  details?: string;
}

interface EarningsDashboardProps {
  contractId?: string;
  walletAddress?: string | null;
}

export const EarningsDashboard: React.FC<EarningsDashboardProps> = ({
  contractId,
  walletAddress,
}) => {
  const { settings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalDistributed, setTotalDistributed] = useState<number>(0);
  const [primaryTotal, setPrimaryTotal] = useState<number>(0);
  const [secondaryTotal, setSecondaryTotal] = useState<number>(0);
  const [collaborators, setCollaborators] = useState<CollaboratorEarning[]>([]);
  const [recentPayouts, setRecentPayouts] = useState<RecentPayout[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "primary" | "secondary">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const loadDashboardData = useCallback(async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Fetch analytics, collaborator shares, royalty stats, and transaction history in parallel
      const [analyticsRes, collabRes, statsRes, historyRes, salesRes] = await Promise.allSettled([
        api.getAnalytics(contractId),
        api.getCollaborators(contractId),
        api.getRoyaltyStats(contractId),
        api.getTransactionHistory(contractId, 20, 0),
        api.getSecondarySales(contractId, 20, 0),
      ]);

      if (analyticsRes.status === "rejected" && collabRes.status === "rejected") {
        setError("Failed to load earnings dashboard data. Please try again.");
        return;
      }

      // Parse Analytics data
      let totalDist = 0;
      let primTotal = 0;
      let secTotal = 0;
      let collabStatsMap = new Map<string, { totalEarned: number; payoutCount: number }>();

      if (analyticsRes.status === "fulfilled" && analyticsRes.value.success) {
        const data = analyticsRes.value.data;
        totalDist = data.totalDistributed ?? 0;
        primTotal = data.primaryRoyaltiesTotal ?? 0;
        secTotal = data.secondaryRoyaltiesTotal ?? 0;

        (data.collaboratorStats || []).forEach((c) => {
          collabStatsMap.set(c.address, {
            totalEarned: c.totalEarned,
            payoutCount: c.payoutCount,
          });
        });
      }

      // Parse Secondary Stats if analytics secondary was 0
      if (statsRes.status === "fulfilled" && statsRes.value) {
        const stats = statsRes.value;
        if (!secTotal && stats.totalRoyaltiesGenerated) {
          secTotal = typeof stats.totalRoyaltiesGenerated === "number"
            ? stats.totalRoyaltiesGenerated
            : parseFloat(stats.totalRoyaltiesGenerated) || 0;
        }
      }

      // Combine Collaborator shares with earnings stats
      let collabList: CollaboratorEarning[] = [];
      if (collabRes.status === "fulfilled" && Array.isArray(collabRes.value)) {
        collabList = collabRes.value.map((c) => {
          const stats = collabStatsMap.get(c.address) || { totalEarned: 0, payoutCount: 0 };
          return {
            address: c.address,
            basisPoints: c.basisPoints,
            totalEarned: stats.totalEarned,
            payoutCount: stats.payoutCount,
            avgPayout: stats.payoutCount > 0 ? stats.totalEarned / stats.payoutCount : 0,
          };
        });
      } else if (collabStatsMap.size > 0) {
        collabStatsMap.forEach((stats, addr) => {
          collabList.push({
            address: addr,
            basisPoints: 0,
            totalEarned: stats.totalEarned,
            payoutCount: stats.payoutCount,
            avgPayout: stats.payoutCount > 0 ? stats.totalEarned / stats.payoutCount : 0,
          });
        });
      }

      // Combine Recent Payout Activity
      const payoutsList: RecentPayout[] = [];

      if (historyRes.status === "fulfilled" && historyRes.value?.data) {
        historyRes.value.data.forEach((tx: TransactionRecord) => {
          payoutsList.push({
            id: `tx-${tx.id}`,
            type: tx.type === "secondary_distribute" || tx.type === "secondary_royalty" ? "secondary" : "primary",
            timestamp: tx.timestamp,
            txHash: tx.txHash,
            amount: tx.requestedAmount ?? "—",
            status: tx.status,
            details: tx.type === "initialize" ? "Contract Initialization" : `${tx.type === "distribute" ? "Primary Royalty Distribution" : "Secondary Royalty Distribution"}`
          });
        });
      }

      if (salesRes.status === "fulfilled" && salesRes.value?.sales) {
        salesRes.value.sales.forEach((sale: SecondarySale) => {
          payoutsList.push({
            id: `sale-${sale.id}`,
            type: "secondary",
            timestamp: sale.timestamp,
            txHash: sale.transactionHash,
            amount: sale.royaltyAmount,
            status: "confirmed",
            details: `NFT Resale (ID: ${sale.nftId})`,
          });
        });
      }

      // Sort payouts descending by timestamp
      payoutsList.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      setTotalDistributed(totalDist);
      setPrimaryTotal(primTotal);
      setSecondaryTotal(secTotal);
      setCollaborators(collabList);
      setRecentPayouts(payoutsList);
    } catch (err: unknown) {
      console.error("Error loading earnings dashboard:", err);
      setError("Failed to load earnings dashboard data. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  if (!contractId) {
    return (
      <div className="earnings-dashboard-empty" data-testid="earnings-dashboard-empty">
        <div className="empty-card">
          <div className="empty-icon">💎</div>
          <h2>Collaborator Earnings Dashboard</h2>
          <p>Please select or initialize a contract to view total royalties and earnings breakdown.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="earnings-dashboard-loading" data-testid="earnings-dashboard-loading">
        <div className="skeleton-header">
          <Skeleton width="280px" height="32px" />
          <Skeleton width="400px" height="20px" className="mt-2" />
        </div>
        <div className="kpi-grid">
          <Skeleton height="110px" />
          <Skeleton height="110px" />
          <Skeleton height="110px" />
          <Skeleton height="110px" />
        </div>
        <Skeleton height="250px" className="mt-6" />
        <Skeleton height="300px" className="mt-6" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="earnings-dashboard-error" data-testid="earnings-dashboard-error">
        <div className="error-alert" role="alert">
          <div className="error-title">Error Loading Dashboard</div>
          <p>{error}</p>
          <button type="button" className="retry-btn" onClick={() => void loadDashboardData()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const filteredCollaborators = collaborators.filter((c) =>
    c.address.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredPayouts = recentPayouts.filter((p) => {
    if (activeTab === "primary") return p.type === "primary";
    if (activeTab === "secondary") return p.type === "secondary";
    return true;
  });

  return (
    <div className="earnings-dashboard" data-testid="earnings-dashboard">
      <header className="earnings-header">
        <div className="earnings-header-info">
          <h1>Collaborator Earnings Dashboard</h1>
          <p className="subtitle">
            Comprehensive overview of primary distributions, secondary resale royalties, and collaborator payouts.
          </p>
        </div>
        <button
          type="button"
          className="refresh-dashboard-btn"
          onClick={() => void loadDashboardData()}
          title="Refresh dashboard data"
        >
          🔄 Refresh
        </button>
      </header>

      {/* KPI Cards Section */}
      <section className="kpi-grid" aria-label="Royalty Summary Statistics">
        <div className="kpi-card total-distributed-card">
          <div className="kpi-header">
            <span className="kpi-icon">💰</span>
            <span className="kpi-title">Total Distributed</span>
          </div>
          <div className="kpi-value">{formatCurrency(totalDistributed, settings.displayCurrency)}</div>
          <div className="kpi-subtext">All-time primary & secondary payouts</div>
        </div>

        <div className="kpi-card primary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">✨</span>
            <span className="kpi-title">Primary Royalties</span>
          </div>
          <div className="kpi-value">{formatCurrency(primaryTotal, settings.displayCurrency)}</div>
          <div className="kpi-subtext">Direct contract distributions</div>
        </div>

        <div className="kpi-card secondary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">🔄</span>
            <span className="kpi-title">Secondary Royalties</span>
          </div>
          <div className="kpi-value">{formatCurrency(secondaryTotal, settings.displayCurrency)}</div>
          <div className="kpi-subtext">NFT marketplace resales</div>
        </div>

        <div className="kpi-card collaborator-count-card">
          <div className="kpi-header">
            <span className="kpi-icon">👥</span>
            <span className="kpi-title">Collaborators</span>
          </div>
          <div className="kpi-value">{formatNumber(collaborators.length)}</div>
          <div className="kpi-subtext">Allocated payout recipients</div>
        </div>
      </section>

      {/* Collaborators Breakdown Section */}
      <section className="dashboard-section collaborators-section" aria-labelledby="collab-earnings-heading">
        <div className="section-header">
          <div>
            <h2 id="collab-earnings-heading">Collaborator Allocations & Earnings</h2>
            <p className="section-sub">Individual breakdown of shares and accumulated earnings.</p>
          </div>
          <div className="search-box">
            <input
              type="text"
              placeholder="Search by address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search collaborators by address"
            />
            {searchQuery && (
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="table-responsive">
          <table className="earnings-table">
            <thead>
              <tr>
                <th scope="col">Collaborator Address</th>
                <th scope="col" className="text-right">Share %</th>
                <th scope="col" className="text-right">Basis Points</th>
                <th scope="col" className="text-right">Total Earned</th>
                <th scope="col" className="text-right">Payout Count</th>
                <th scope="col" className="text-right">Avg Payout</th>
              </tr>
            </thead>
            <tbody>
              {filteredCollaborators.length > 0 ? (
                filteredCollaborators.map((c) => {
                  const sharePct = (c.basisPoints / 100).toFixed(2);
                  const isConnectedUser = walletAddress && c.address === walletAddress;
                  return (
                    <tr key={c.address} className={isConnectedUser ? "highlight-user-row" : ""}>
                      <td className="address-cell" data-label="Collaborator Address">
                        <div className="address-wrapper">
                          <span className="address-text" title={c.address}>
                            {c.address.slice(0, 10)}...{c.address.slice(-6)}
                          </span>
                          {isConnectedUser && <span className="you-badge">You</span>}
                          <CopyButton value={c.address} label="address" size="sm" />
                        </div>
                      </td>
                      <td className="text-right" data-label="Share %">
                        <span className="badge-share">{sharePct}%</span>
                      </td>
                      <td className="text-right" data-label="Basis Points">
                        {formatNumber(c.basisPoints)} bp
                      </td>
                      <td className="text-right font-medium" data-label="Total Earned">
                        {formatCurrency(c.totalEarned, settings.displayCurrency)}
                      </td>
                      <td className="text-right" data-label="Payout Count">
                        {formatNumber(c.payoutCount)}
                      </td>
                      <td className="text-right" data-label="Avg Payout">
                        {formatCurrency(c.avgPayout, settings.displayCurrency)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    {searchQuery ? "No collaborators match your search query." : "No collaborator earnings found for this contract."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Payout Activity Section */}
      <section className="dashboard-section recent-activity-section" aria-labelledby="payout-activity-heading">
        <div className="section-header">
          <div>
            <h2 id="payout-activity-heading">Recent Payout Activity</h2>
            <p className="section-sub">Latest primary distribution transactions and secondary royalty payouts.</p>
          </div>
          <div className="tabs-bar" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "all"}
              className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All Payouts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "primary"}
              className={`tab-btn ${activeTab === "primary" ? "active" : ""}`}
              onClick={() => setActiveTab("primary")}
            >
              Primary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "secondary"}
              className={`tab-btn ${activeTab === "secondary" ? "active" : ""}`}
              onClick={() => setActiveTab("secondary")}
            >
              Secondary
            </button>
          </div>
        </div>

        <div className="table-responsive">
          <table className="payouts-table">
            <thead>
              <tr>
                <th scope="col">Date / Time</th>
                <th scope="col">Type</th>
                <th scope="col">Details</th>
                <th scope="col" className="text-right">Amount</th>
                <th scope="col" className="text-center">Status</th>
                <th scope="col" className="text-right">Transaction Hash</th>
              </tr>
            </thead>
            <tbody>
              {filteredPayouts.length > 0 ? (
                filteredPayouts.map((p) => {
                  const formattedDate = new Date(p.timestamp).toLocaleString();
                  return (
                    <tr key={p.id}>
                      <td data-label="Date / Time" className="date-cell">
                        {formattedDate}
                      </td>
                      <td data-label="Type">
                        <span className={`type-badge type-${p.type}`}>
                          {p.type === "primary" ? "Primary" : "Secondary"}
                        </span>
                      </td>
                      <td data-label="Details" className="details-cell">
                        {p.details || "Royalty Payout"}
                      </td>
                      <td data-label="Amount" className="text-right font-medium">
                        {typeof p.amount === "number"
                          ? formatCurrency(p.amount, settings.displayCurrency)
                          : p.amount}
                      </td>
                      <td data-label="Status" className="text-center">
                        <span className={`status-pill status-${p.status}`}>
                          {p.status}
                        </span>
                      </td>
                      <td data-label="Transaction Hash" className="text-right">
                        {p.txHash ? (
                          <div className="tx-hash-wrapper">
                            <span className="tx-hash" title={p.txHash}>
                              {p.txHash.slice(0, 8)}...{p.txHash.slice(-6)}
                            </span>
                            <CopyButton value={p.txHash} label="transaction hash" size="sm" />
                          </div>
                        ) : (
                          <span className="no-hash">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    No recent payout activity found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default EarningsDashboard;
