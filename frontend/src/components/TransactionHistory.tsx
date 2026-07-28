import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { TransactionDetailView } from "./TransactionDetailView";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import { useNetwork } from "../context/NetworkContext";

interface TransactionHistoryProps {
  contractId: string;
  selectedTxHash?: string | null;
  onSelectTxHash?: (hash: string | null) => void;
}

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
  const LIMIT = 10;

  const activeTxHash = propSelectedTxHash !== undefined ? propSelectedTxHash : localSelectedTxHash;

  function handleSelectTxHash(hash: string | null) {
    if (onSelectTxHash) {
      onSelectTxHash(hash);
    } else {
      setLocalSelectedTxHash(hash);
    }
  }

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
                    onClick={() => tx.txHash && handleSelectTxHash(tx.txHash)}
                    title="Click to view details"
                  >
                    <td><span className="tx-type">{tx.type}</span></td>
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

      {loading && <div className="loading">Loading transactions...</div>}
    </div>
  );
};
