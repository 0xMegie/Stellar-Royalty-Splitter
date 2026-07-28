import { useState, useEffect } from "react";
import { api, TransactionRecord, TransactionDetails } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { buildCSV, downloadCSV, filterByDateRange, ExportFilter } from "../utils/csv";

interface TransactionHistoryProps {
  contractId: string;
}

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  contractId,
}) => {
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<TransactionDetails | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [exportFilter, setExportFilter] = useState<ExportFilter>({ startDate: null, endDate: null });
  const [exporting, setExporting] = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const LIMIT = 10;

  const fetchHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTransactionHistory(contractId, LIMIT, offset);
      setTransactions(result.data || []);
      setTotal(result.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch history");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      // Fetch all transactions (up to 10 000) then filter client-side
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
  useEffect(() => { fetchHistory(); }, [contractId, offset]);

  const openModal = async (tx: TransactionRecord) => {
    if (!tx.txHash) {
      // No hash yet — show what we have without fetching details
      setSelected({ ...tx });
      return;
    }
    setModalLoading(true);
    setSelected({ ...tx }); // show immediately with basic data
    try {
      const result = await api.getTransactionDetails(tx.txHash);
      setSelected(result.data);
    } catch {
      // keep the basic data already shown
    } finally {
      setModalLoading(false);
    }
  };

  const closeModal = () => { setSelected(null); };

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

  const truncateHash = (hash: string | null) =>
    hash ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : "Pending";

  return (
    <div className="transaction-history">
      <div className="history-header">
        <h2>Transaction History</h2>
        <div className="history-header-actions">
          <button
            className="export-toggle-btn"
            onClick={() => setShowExportPanel((v) => !v)}
            aria-expanded={showExportPanel}
          >
            ↓ Export CSV
          </button>
          <button onClick={fetchHistory} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

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

      {transactions.length === 0 && !loading && (
        <div className="empty-state">No transactions yet</div>
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
                    onClick={() => openModal(tx)}
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
                      <span className="tx-hash-text">{truncateHash(tx.txHash)}</span>
                      {tx.txHash && (
                        <CopyButton
                          value={tx.txHash}
                          label="transaction hash"
                          size="sm"
                        />
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

      {loading && <div className="loading">Loading transactions...</div>}

      {/* Detail modal */}
      {selected && (
        <div className="tx-modal-overlay" onClick={closeModal} role="dialog" aria-modal="true" aria-label="Transaction details">
          <div className="tx-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tx-modal-header">
              <h3>Transaction Details</h3>
              <button className="tx-modal-close" onClick={closeModal} aria-label="Close">✕</button>
            </div>

            <div className="tx-modal-body">
              <div className="tx-detail-row">
                <span className="tx-detail-label">Type</span>
                <span>
                  <span className={`tx-category ${isSecondary(selected.type) ? "tx-category-secondary" : "tx-category-primary"}`}>
                    {isSecondary(selected.type) ? "Secondary" : "Primary"}
                  </span>
                  <span className="tx-type">{getTypeLabel(selected.type)}</span>
                </span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Status</span>
                <span
                  className="status-badge"
                  style={{
                    backgroundColor: getStatusColor(selected.status),
                    color: selected.status === "failed" ? "white" : "black",
                  }}
                >
                  {selected.status}
                </span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">TX Hash</span>
                <span className="tx-detail-hash">
                  <span className="tx-detail-mono">{selected.txHash ?? "Pending"}</span>
                  {selected.txHash && (
                    <CopyButton
                      value={selected.txHash}
                      label="transaction hash"
                      size="sm"
                    />
                  )}
                </span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Initiator</span>
                <span className="tx-detail-mono">{selected.initiatorAddress}</span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Timestamp</span>
                <span>{formatDate(selected.timestamp)}</span>
              </div>

              {selected.requestedAmount && (
                <div className="tx-detail-row">
                  <span className="tx-detail-label">Amount</span>
                  <span>{formatNumber(selected.requestedAmount)}</span>
                </div>
              )}

              {selected.tokenId && (
                <div className="tx-detail-row">
                  <span className="tx-detail-label">Token</span>
                  <span className="tx-detail-mono">{selected.tokenId}</span>
                </div>
              )}

              {selected.status === "failed" && selected.errorMessage && (
                <div className="tx-detail-row tx-detail-error">
                  <span className="tx-detail-label">Error</span>
                  <span className="tx-error-text">{selected.errorMessage}</span>
                </div>
              )}

              {modalLoading && (
                <div className="tx-modal-loading">Loading payout details…</div>
              )}

              {!modalLoading && selected.payouts && selected.payouts.length > 0 && (
                <div className="tx-payouts">
                  <span className="tx-detail-label">Payouts</span>
                  <table className="tx-payouts-table">
                    <thead>
                      <tr><th>Collaborator</th><th>Amount</th></tr>
                    </thead>
                    <tbody>
                      {selected.payouts.map((p, i) => (
                        <tr key={i}>
                          <td className="tx-detail-mono">{p.collaboratorAddress}</td>
                          <td>{formatNumber(p.amountReceived)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
