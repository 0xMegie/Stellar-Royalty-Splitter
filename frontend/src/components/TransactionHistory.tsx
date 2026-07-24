import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { TransactionDetailView } from "./TransactionDetailView";

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

  const truncateHash = (hash: string | null) =>
    hash ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : "Pending";

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
        <button onClick={fetchHistory} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

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
    </div>
  );
};
