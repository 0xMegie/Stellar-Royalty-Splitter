import { useEffect, useState } from "react";
import { isOnline, watchConnectivity } from "../lib/registerServiceWorker";
import { useOfflineQueue } from "../hooks/useOfflineQueue";

/**
 * Banner that appears whenever the browser reports `offline` (#522), or
 * whenever writes are still pending sync after reconnecting (#771).
 *
 * Renders nothing when online with an empty queue so it occupies no
 * layout space. While offline (or while queued writes are still being
 * drained), renders a fixed-position banner at the top of the viewport
 * with a brief message, the pending count, and a manual "Clear queue"
 * escape hatch, with a status-role for assistive tech.
 */
export function OfflineIndicator(): JSX.Element | null {
  const [online, setOnline] = useState<boolean>(isOnline());
  const { pendingCount, clearQueue } = useOfflineQueue();

  useEffect(() => {
    const handle = watchConnectivity(setOnline);
    return () => handle.stop();
  }, []);

  if (online && pendingCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: online ? "#2563eb" : "#b45309",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        textAlign: "center",
        padding: "0.5rem 1rem",
        fontSize: "0.9rem",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
      }}
    >
      <span>
        {online
          ? `Syncing ${pendingCount} pending ${pendingCount === 1 ? "change" : "changes"}…`
          : "You're offline — writes will be queued and synced when you reconnect."}
        {!online && pendingCount > 0 && ` (${pendingCount} pending)`}
      </span>
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => void clearQueue()}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.6)",
            color: "#fff",
            borderRadius: "4px",
            padding: "0.15rem 0.5rem",
            fontSize: "0.8rem",
            cursor: "pointer",
          }}
        >
          Clear queue
        </button>
      )}
    </div>
  );
}
