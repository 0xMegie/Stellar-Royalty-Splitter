import { useCallback, useEffect, useState } from "react";
import {
  clearQueue,
  getQueueCount,
  subscribeToQueueUpdates,
} from "../lib/offlineQueue";

/**
 * Live pending-write count for the offline queue (#771), plus a manual
 * clear action for the "Clear queue" control in the offline indicator.
 */
export function useOfflineQueue() {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getQueueCount().then((count) => {
      if (!cancelled) setPendingCount(count);
    });

    const unsubscribe = subscribeToQueueUpdates((count) => {
      if (!cancelled) setPendingCount(count);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const clear = useCallback(async () => {
    await clearQueue();
    setPendingCount(0);
  }, []);

  return { pendingCount, clearQueue: clear };
}
