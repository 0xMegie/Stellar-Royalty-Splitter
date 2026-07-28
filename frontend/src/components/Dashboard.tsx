import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { api } from "../api";
import "./Dashboard.css";
import { useSettings } from "../context/SettingsContext";
import { formatNumber, formatCurrency } from "../utils/format";
import {
  buildContractPerformanceSummary,
  type ContractPerformanceSummary,
} from "../utils/contractPerformance";
import { DashboardSkeleton } from "./Skeleton";




interface DashboardStats {
  totalDistributed: number;
  totalTransactions: number;
  averagePayout: number;
  topEarners: Array<{ address: string; totalEarned: number; payouts: number }>;
  distributionTrends: Array<{ date: string; amount: number; count: number }>;
  collaboratorStats: Array<{
    address: string;
    totalEarned: number;
    payoutCount: number;
  }>;
}

interface DashboardProps {
  contractId: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ contractId }) => {
  const { settings } = useSettings();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [performanceData, setPerformanceData] = useState<ContractPerformanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [performanceLoading, setPerformanceLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [allTime, setAllTime] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0],
    end: new Date().toISOString().split("T")[0],
  });
  const [dateError, setDateError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"revenue" | "transactions" | "name">("revenue");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const today = new Date().toISOString().split("T")[0];

  const loadStats = useCallback(async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.getAnalytics(contractId, allTime ? undefined : dateRange);

      if (response.success) {
        setStats(response.data);
      } else {
        setError(response.message || "Failed to load analytics");
      }
    } catch (err) {
      console.error("Error loading dashboard stats:", err);
      setError("Error loading analytics data");
    } finally {
      setLoading(false);
    }
  }, [contractId, allTime, dateRange]);

  const loadPerformance = useCallback(async () => {
    setPerformanceLoading(true);
    setPerformanceError(null);

    try {
      const response = await api.getContractPerformance(allTime ? undefined : dateRange, {
        sortBy,
        direction: sortDirection,
        limit: 100,
      });

      if (response.success) {
        setPerformanceData(buildContractPerformanceSummary(response.data.contracts, {
          sortBy,
          direction: sortDirection,
          limit: 100,
        }));
      } else {
        setPerformanceError(response.message || "Failed to load contract performance");
      }
    } catch (err) {
      console.error("Error loading contract performance:", err);
      setPerformanceError("Error loading contract performance data");
    } finally {
      setPerformanceLoading(false);
    }
  }, [allTime, dateRange, sortBy, sortDirection]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    void loadPerformance();
  }, [loadPerformance]);

  if (!contractId) {
    return (
      <div className="dashboard-empty">
        <div className="empty-state">
          <div className="empty-icon">📊</div>
          <h2>No Contract Selected</h2>
          <p>Please initialize or select a contract to view analytics.</p>
        </div>
      </div>
    );
  }

  const isLoading = loading || performanceLoading;

  function formatContractId(id: string): string {
    if (id.length <= 16) return id;
    return `${id.slice(0, 8)}…${id.slice(-6)}`;
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-copy">
          <h1>Contract Performance Dashboard</h1>
          <p className="dashboard-subtitle">
            Monitor which contracts generate the most revenue and activity.
          </p>
        </div>

        <div className="dashboard-toolbar" role="region" aria-label="Dashboard filters">
          <div className="toolbar-group toolbar-dates">
            <span className="toolbar-label">Date range</span>
            <div className="toolbar-controls">
              <button
                type="button"
                onClick={() => setAllTime(!allTime)}
                className={`preset-btn${allTime ? " active" : ""}`}
                aria-pressed={allTime}
              >
                All time
              </button>
              <div className="date-inputs">
                <label className="sr-only" htmlFor="performance-start-date">Start date</label>
                <input
                  id="performance-start-date"
                  type="date"
                  value={dateRange.start}
                  max={today}
                  disabled={allTime}
                  aria-label="Start date"
                  onChange={(e) => {
                    const start = e.target.value;
                    if (start > dateRange.end) {
                      setDateError("Start date must be on or before end date.");
                    } else {
                      setDateError(null);
                      setDateRange({ ...dateRange, start });
                    }
                  }}
                />
                <span className="date-separator" aria-hidden="true">to</span>
                <label className="sr-only" htmlFor="performance-end-date">End date</label>
                <input
                  id="performance-end-date"
                  type="date"
                  value={dateRange.end}
                  max={today}
                  disabled={allTime}
                  aria-label="End date"
                  onChange={(e) => {
                    const end = e.target.value;
                    if (end < dateRange.start) {
                      setDateError("End date must be on or after start date.");
                    } else {
                      setDateError(null);
                      setDateRange({ ...dateRange, end });
                    }
                  }}
                />
              </div>
            </div>
          </div>

          <div className="toolbar-group toolbar-sort">
            <span className="toolbar-label">Sort by</span>
            <div className="toolbar-controls">
              <select
                id="performance-sort"
                aria-label="Sort contracts"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "revenue" | "transactions" | "name")}
              >
                <option value="revenue">Revenue</option>
                <option value="transactions">Transactions</option>
                <option value="name">Name</option>
              </select>
              <button
                type="button"
                className="sort-direction-btn"
                aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}`}
                onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
              >
                {sortDirection === "asc" ? "↑ Asc" : "↓ Desc"}
              </button>
            </div>
          </div>

          <div className="toolbar-group toolbar-actions">
            <button
              type="button"
              onClick={() => {
                void loadStats();
                void loadPerformance();
              }}
              className="refresh-btn"
              disabled={isLoading}
            >
              Refresh
            </button>
          </div>

          {dateError && <div className="date-error" role="alert">{dateError}</div>}
        </div>
      </header>

      {isLoading && <DashboardSkeleton />}

      {error && <div className="error-message" role="alert">{error}</div>}
      {performanceError && <div className="error-message" role="alert">{performanceError}</div>}

      {performanceData && !performanceLoading && (
        <section className="dashboard-section" aria-labelledby="portfolio-overview-heading">
          <h2 id="portfolio-overview-heading" className="section-heading">Portfolio Overview</h2>
          <div className="kpi-cards kpi-cards-performance">
            <div className="kpi-card kpi-distributed">
              <div className="kpi-label">Total Revenue</div>
              <div className="kpi-value">{formatCurrency(performanceData.totalRevenue, settings.displayCurrency)}</div>
            </div>
            <div className="kpi-card kpi-transactions">
              <div className="kpi-label">Active Contracts</div>
              <div className="kpi-value">{formatNumber(performanceData.activeContracts)}</div>
            </div>
            <div className="kpi-card kpi-average">
              <div className="kpi-label">Transactions This Month</div>
              <div className="kpi-value">{formatNumber(performanceData.transactionsThisMonth)}</div>
            </div>
          </div>

          <div className="performance-table-section">
            <div className="section-heading-row">
              <h2 className="section-heading">Contract Performance</h2>
              <span className="section-meta">{formatNumber(performanceData.contracts.length)} contracts</span>
            </div>
            <div className="stats-table stats-table-responsive">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Contract ID</th>
                    <th scope="col" className="text-right">Revenue</th>
                    <th scope="col" className="text-right">Transactions</th>
                    <th scope="col" className="text-right">Last Activity</th>
                    <th scope="col" className="text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {performanceData.contracts.length > 0 ? (
                    performanceData.contracts.map((contract) => (
                      <tr key={contract.contractId}>
                        <td className="address-cell" data-label="Contract ID" title={contract.contractId}>
                          <span className="address-short">{formatContractId(contract.contractId)}</span>
                          <span className="address-full">{contract.contractId}</span>
                        </td>
                        <td className="text-right" data-label="Revenue">
                          {formatCurrency(contract.revenue, settings.displayCurrency)}
                        </td>
                        <td className="text-right" data-label="Transactions">
                          {formatNumber(contract.transactions)}
                        </td>
                        <td className="text-right" data-label="Last Activity">
                          {contract.lastActivity ? new Date(contract.lastActivity).toLocaleDateString() : "—"}
                        </td>
                        <td className="text-right" data-label="Status">
                          <span className={`status-pill status-${contract.status}`}>{contract.status}</span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="table-empty">No contract activity found</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {stats && !loading && (
        <section className="dashboard-section" aria-labelledby="contract-analytics-heading">
          {stats.totalTransactions === 0 && (
            <div className="empty-data-warning" role="status">
              No data found for this period. Try widening your date range or selecting <strong>All time</strong>.
            </div>
          )}
          <h2 id="contract-analytics-heading" className="section-heading">Contract Analytics</h2>
          <div className="kpi-cards kpi-cards-analytics">
              <div className="kpi-card kpi-distributed">
                <div className="kpi-label">Total Distributed</div>
                <div className="kpi-value">
                  {formatCurrency(stats.totalDistributed, settings.displayCurrency)}
                </div>
              </div>
 
            <div className="kpi-card kpi-transactions">
              <div className="kpi-label">Total Transactions</div>
              <div className="kpi-value">{formatNumber(stats.totalTransactions)}</div>
              <div className="kpi-unit">payouts</div>
            </div>

            <div className="kpi-card kpi-average">
              <div className="kpi-label">Average Payout</div>
              <div className="kpi-value">
                {formatCurrency(stats.averagePayout, settings.displayCurrency)}
              </div>
              <div className="kpi-unit">per transaction</div>
            </div>
 
            <div className="kpi-card kpi-collaborators">
              <div className="kpi-label">Active Collaborators</div>
              <div className="kpi-value">
                {formatNumber(stats.collaboratorStats.length)}
              </div>
              <div className="kpi-unit">unique addresses</div>
            </div>
          </div>

          <div className="charts-section">
            <div className="chart-container">
              <h3 className="chart-title">Revenue Trends (Over Time)</h3>
              {stats.distributionTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minHeight={220}>
                  <LineChart data={stats.distributionTrends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip
                      formatter={(value: number | string) =>
                        typeof value === "number"
                          ? formatCurrency(value, settings.displayCurrency)
                          : value
                      }
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="amount"
                      stroke="#667eea"
                      name={`Total Amount (${settings.displayCurrency})`}
                      strokeWidth={2}
                      dot={{ fill: "#667eea", r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="no-data">No data available</div>
              )}
            </div>

            <div className="chart-container">
              <h3 className="chart-title">Distribution Frequency</h3>
              {stats.distributionTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minHeight={220}>
                  <BarChart data={stats.distributionTrends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar
                      dataKey="count"
                      fill="#764ba2"
                      name="Number of Transactions"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="no-data">No data available</div>
              )}
            </div>
          </div>

          <div className="top-earners-section">
            <h3 className="section-heading">Top Earners</h3>
            <div className="earners-list">
              {stats.topEarners.length > 0 ? (
                stats.topEarners.map((earner, index) => (
                  <div key={index} className="earner-card">
                    <div className="earner-rank">#{index + 1}</div>
                    <div className="earner-info">
                      <div className="earner-address">
                        {earner.address.slice(0, 10)}...
                        {earner.address.slice(-6)}
                      </div>
                      <div className="earner-stats">
                        <span className="earner-amount">
                          {formatCurrency(earner.totalEarned, settings.displayCurrency)}
                        </span>
                        <span className="earner-count">
                          {formatNumber(earner.payouts)} payouts
                        </span>
                      </div>
                    </div>
                    <div className="earner-percentage">
                      {stats.totalDistributed > 0
                        ? ((earner.totalEarned / stats.totalDistributed) * 100).toFixed(1)
                        : "0.0"}
                      %
                    </div>
                  </div>
                ))
              ) : (
                <div className="no-data">No earnings yet</div>
              )}
            </div>
          </div>

          <div className="collaborator-stats-section">
            <h3 className="section-heading">Collaborator Summary</h3>
            <div className="stats-table stats-table-responsive">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Collaborator</th>
                    <th scope="col" className="text-right">Total Earned</th>
                    <th scope="col" className="text-right">Payouts</th>
                    <th scope="col" className="text-right">Avg Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.collaboratorStats.length > 0 ? (
                    stats.collaboratorStats.map((collab, index) => (
                      <tr key={index}>
                        <td className="address-cell" data-label="Collaborator" title={collab.address}>
                          {collab.address.slice(0, 10)}…{collab.address.slice(-6)}
                        </td>
                        <td className="text-right" data-label="Total Earned">
                          {formatCurrency(collab.totalEarned, settings.displayCurrency)}
                        </td>
                        <td className="text-right" data-label="Payouts">
                          {formatNumber(collab.payoutCount)}
                        </td>
                        <td className="text-right" data-label="Avg Payout">
                          {collab.payoutCount > 0
                            ? formatCurrency(collab.totalEarned / collab.payoutCount, settings.displayCurrency)
                            : formatCurrency(0, settings.displayCurrency)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="table-empty">
                        No collaborator data
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
