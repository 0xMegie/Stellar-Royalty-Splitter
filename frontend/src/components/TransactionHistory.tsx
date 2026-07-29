import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { TransactionDetailView } from "./TransactionDetailView";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import { useNetwork } from "../context/NetworkContext";
import { ListSkeleton } from "./Skeleton";

interface TransactionHistoryProps {
  contractId: string;
  selectedTxHash?: string | null;
  onSelectTxHash?: (hash: string | null) => void;
}

interface HistoryFilters {
  type: "" | "distribute" | "initialize";
  recipient: string;
  startDate: string;
  endDate: string;
}

const DEFAULT_FILTERS: HistoryFilters = {
  type: "",
  recipient: "",
  startDate: "",
  endDate: "",
};

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  contractId,
  selectedTxHash: propSelectedTxHash,
  onSelectTxHash,
}) => {
  const { network } = useNetwork();
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [localSelectedTxHash, setLocalSelectedTxHash] = useState<string | null>(null);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFilter, setExportFilter] = useState<{ startDate: string | null; endDate: string | null }>({
    startDate: null,
    endDate: null,
  });

  // Search / filter state
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  const LIMIT = 10;

  const activeTxHash = propSelectedTxHash !== undefined ? propSelectedTxHash : localSelectedTxHash;

  const hasActiveFilters =
    filters.type !== "" ||
    filters.recipient !== "" ||
    filters.startDate !== "" ||
    filters.endDate !== "";

  function handleSelectTxHash(hash: string | null) {
    if (onSelectTxHash) {
      onSelectTxHash(hash);
    } else {
      setLocalSelectedTxHash(hash);
    }
  }

  const fetchHistory = async (activeFilters = filters) => {
    setLoading(true);
    setError(null);
    try {
      const apiFilters: Parameters<typeof api.getTransactionHistory>[3] = {};
      if (activeFilters.type) apiFilters.type = activeFilters.type as "distribute" | "initialize";
      if (activeFilters.recipient) apiFilters.recipient = activeFilters.recipient;
      if (activeFilters.startDate) apiFilters.startDate = activeFilters.startDate;
      if (activeFilters.endDate) apiFilters.endDate = activeFilters.endDate;

      const result = await api.getTransactionHistory(contractId, LIMIT, offset, apiFilters);
      setTransactions(result.data || []);
      setTotal(result.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch history");
    } finally {
      setLoading(false);
    }
  };

  function applyFilters() {
    setFilters(pendingFilters);
    setOffset(0);
  }

  function resetFilters() {
    setPendingFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setOffset(0);
  }

  function filterByDateRange(
    txs: TransactionRecord[],
    f: { startDate: string | null; endDate: string | null },
  ): TransactionRecord[] {
    return txs.filter((tx) => {
      const ts = new Date(tx.timestamp).getTime();
      if (f.startDate && ts < new Date(f.startDate).getTime()) return false;
      if (f.endDate && ts > new Date(f.endDate + "T23:59:59").getTime()) return false;
      return true;
    });
  }

  function buildCSV(txs: TransactionRecord[]): string {
    const header = ["ID", "Type", "Initiator", "Amount", "TX Hash", "Status", "Timestamp"].join(",");
    const rows = txs.map((tx) =>
      [
        tx.id,
        tx.type,
        tx.initiatorAddress,
        tx.requestedAmount ?? "",
        tx.txHash ?? "",
        tx.status,
        tx.timestamp,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [header, ...rows].join("\n");
  }

  function downloadCSV(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await api.getTransactionHistory(contractId, 10_000, 0);
      const all: TransactionRecord[] = result.data ?? [];
      const filtered = filterByDateRange(all, exportFilter);
      if (filtered.length === 0) {
        alert("No transactions found for the selected date range.");
        return;
      }
      const csv = buildCSV(filtered);
      const datePart = new Date().toISOString().split("T")[0];
      downloadCSV(csv, `transactions-${contractId.slice(0, 8)}-${datePart}.csv`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => { setOffset(0); }, [contractId]);
  // Re-fetch when offset or active filters change
  useEffect(() => { fetchHistory(filters); }, [contractId, offset, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const TYPE_LABELS: Record<string, string> = {
    distribute: "Primary Distribution",
    secondary_royalty: "Secondary Royalty",
    secondary_distribute: "Secondary Distribution",
    initialize: "Initialization",
  };

  const isSecondary = (type: string) => type.startsWith("secondary_");

  const getTypeLabel = (type: string) => TYPE_LABELS[type] ?? type;

  const getStatusColor = (status: string) => {
    switch (status) {
      case "confirmed": return "#4ade80";
      case "failed":    return "#f87171";
      default:          return "#facc15";
    }
  };

  const formatDate = (dateString: string) => {
    try { return new Date(dateString).toLocaleString(); }
    catch { return dateString; }
  };

  const truncateAddress = (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`;

  if (activeTxHash) {
    return (
      <TransactionDetailView
        txHash={activeTxHash}
        onBack={() => handleSelectTxHash(null)}
      />
    );
  }

  return (
    <div className="transaction-history">
      <div className="history-header">
        <h2>Transaction History</h2>
        <div className="history-header-actions">
          <button
            className="filter-toggle-btn"
            onClick={() => setShowFilterPanel((v) => !v)}
            aria-expanded={showFilterPanel}
          >
            {hasActiveFilters ? "Filters (active)" : "Filters"}
          </button>
          <button
            className="export-toggle-btn"
            onClick={() => setShowExportPanel((v) => !v)}
            aria-expanded={showExportPanel}
          >
            ↓ Export CSV
          </button>
          <button onClick={() => fetchHistory(filters)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {showFilterPanel && (
        <div className="filter-panel" role="search" aria-label="Filter transactions">
          <div className="filter-controls">
            <label className="filter-label">
              Recipient address
              <input
                type="text"
                className="filter-input"
                placeholder="Search by wallet address…"
                value={pendingFilters.recipient}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, recipient: e.target.value }))
                }
              />
            </label>

            <label className="filter-label">
              Type
              <select
                className="filter-select"
                value={pendingFilters.type}
                onChange={(e) =>
                  setPendingFilters((f) => ({
                    ...f,
                    type: e.target.value as HistoryFilters["type"],
                  }))
                }
              >
                <option value="">All types</option>
                <option value="distribute">Distribute</option>
                <option value="initialize">Initialize</option>
              </select>
            </label>

            <label className="filter-label">
              From
              <input
                type="date"
                className="filter-date-input"
                value={pendingFilters.startDate}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, startDate: e.target.value }))
                }
              />
            </label>

            <label className="filter-label">
              To
              <input
                type="date"
                className="filter-date-input"
                value={pendingFilters.endDate}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, endDate: e.target.value }))
                }
              />
            </label>
          </div>

          <div className="filter-actions">
            <button className="filter-apply-btn" onClick={applyFilters} disabled={loading}>
              Apply filters
            </button>
            {hasActiveFilters && (
              <button className="filter-reset-btn" onClick={resetFilters}>
                Reset all filters
              </button>
            )}
          </div>
        </div>
      )}

      {showExportPanel && (
        <div className="export-panel">
          <div className="export-filters">
            <label className="export-label">
              From
              <input
                type="date"
                className="export-date-input"
                value={exportFilter.startDate ?? ""}
                onChange={(e) =>
                  setExportFilter((f) => ({ ...f, startDate: e.target.value || null }))
                }
              />
            </label>
            <label className="export-label">
              To
              <input
                type="date"
                className="export-date-input"
                value={exportFilter.endDate ?? ""}
                onChange={(e) =>
                  setExportFilter((f) => ({ ...f, endDate: e.target.value || null }))
                }
              />
            </label>
            <button
              className="export-btn"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? "Exporting…" : "Download CSV"}
            </button>
          </div>
          <p className="export-hint">
            Leave dates blank to export all transactions. Amounts are converted from stroops to XLM.
          </p>
        </div>
      )}

      {error && <div className="error-message">{error}</div>}

      {transactions.length === 0 && loading && (
        <>
          <span className="sr-only">Loading transactions…</span>
          <ListSkeleton items={5} label="Loading transactions…" />
        </>
      )}

      {transactions.length === 0 && !loading && (
        <div className="empty-state" data-testid="history-empty-state">
          {hasActiveFilters
            ? "No transactions match the active filters."
            : "No transactions yet"}
        </div>
      )}

      {transactions.length > 0 && (
        <>
          <div className="transactions-table">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Initiator</th>
                  <th>Amount</th>
                  <th>TX Hash</th>
                  <th>Status</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="tx-row-clickable"
                    onClick={() => tx.txHash && handleSelectTxHash(tx.txHash)}
                    title="Click to view details"
                  >
                    <td>
                      <span className={`tx-category ${isSecondary(tx.type) ? "tx-category-secondary" : "tx-category-primary"}`}>
                        {isSecondary(tx.type) ? "Secondary" : "Primary"}
                      </span>
                      <span className="tx-type">{getTypeLabel(tx.type)}</span>
                    </td>
                    <td title={tx.initiatorAddress}>{truncateAddress(tx.initiatorAddress)}</td>
                    <td>{tx.requestedAmount ? formatNumber(tx.requestedAmount) : "—"}</td>
                    <td
                      className="tx-hash-cell"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {tx.txHash ? (
                        <>
                          <a
                            href={getStellarExpertTxUrl(network, tx.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tx-hash-link"
                            aria-label={`View transaction ${tx.txHash} on Stellar Expert`}
                            title={`View on Stellar Expert (${network})`}
                          >
                            {formatTxHash(tx.txHash)}
                          </a>
                          <CopyButton
                            value={tx.txHash}
                            label="transaction hash"
                            size="sm"
                          />
                        </>
                      ) : (
                        <span
                          className="tx-hash-pending"
                          aria-label="Transaction hash not yet available"
                        >
                          Pending
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={{
                          backgroundColor: getStatusColor(tx.status),
                          color: tx.status === "failed" ? "white" : "black",
                        }}
                      >
                        {tx.status}
                      </span>
                    </td>
                    <td>{formatDate(tx.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
              Previous
            </button>
            <span>
              Showing {offset + 1}–{offset + transactions.length} of {total} transactions
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={offset + transactions.length >= total}
            >
              Next
            </button>
          </div>
        </>
      )}

      {loading && transactions.length > 0 && (
        <div className="loading">Loading transactions...</div>
      )}
    </div>
  );
};
