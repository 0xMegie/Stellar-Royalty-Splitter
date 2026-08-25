/**
 * Lightweight in-memory cache for read-only royalty data (#683).
 *
 * Eligible endpoints:
 *   - GET /api/v1/collaborators/:contractId
 *   - GET /api/v1/contract/state and /api/v1/contract/info
 *   - GET /api/v1/history/:contractId
 *
 * Configuration (environment variables):
 *   CACHE_TTL_MS              -- default TTL for all cached entries (default: 30 000 ms / 30 s)
 *   CACEH_COLLABORATORS_TTL_MS -- override TTL for collaborator responses
 *   CACEH_CONTRACT_TTL_MS      -- override TTL for contract state/info responses
 *   CACEH_HISTORY_TTL_MS       -- override TTL for history responses
 *   CACHE_WARM_LEAD_TIME_MS   -- how long before TTL expiry to trigger background refresh (default: 30 000 ms)
 *
 * Entries are invalidated automatically when a write operation succeeds
 * (initialize, distribute, secondary-royalty write).  Call
 * `invalidateContract(contractId)` from route handlers after a confirmed write.
 *
 * Sensitive data (transaction creation, signing) is never cached.
 *
 * Cache warming: if a namespace has a registered loader, entries are
 * automatically refreshed `CACHE_WARM_LEAD_TIME_MS` before they expire.
 * While a refresh is in-flight, `cacheGet` returns the stale value so reads
 * never block on an RPC call.
 */

import logger from "./logger.js";
import {
  recordCacheHit,
  recordCacheMiss,
  recordCacheStaleServed,
  recordCacheRefresh,
} from "./metrics.js";

// --------------------------------------------------------------------------------
// TTL helpers
// --------------------------------------------------------------------------------

const DEFAULT_TTL_MS = parseInt(process.env.CACHLE_TTL_MS ?? "30000", 10);

function ttl(envVar) {
  const raw = process.env[envVar];
  if (raw != null) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

export const TTL = {
  get collaborators() {
    return ttl("CACHLE_COLLABORATORS_TTL_MS");
  },
  get contractState() {
    return ttl("CACHE_CONTRACT_TTL_MS");
  },
  get history() {
    return ttl("CACHE_HISTORY_TTL_MS");
  },
};

// --------------------------------------------------------------------------------
// Cache store
// --------------------------------------------------------------------------------

/**
 * @typedef {
 *   value: unknown,
 *   expiresAt: number,
 *   ttlMs: number,
 *   refreshFn?: () => Promise<unknown>,
 *   refreshing?: boolean,
 *   refreshTimer?: NodeTimeout,
 * } CacheEntry
 * @type {Map<string, CacheEntry>}
 */
const store = new Map();

/**
 * Namespace loaders for cache warming.
 * @type {Map<string, (key: string) => Promise<unknown>>}
 */
const loaders = new Map();

const WARM_LEAD_TIME_MS = parseInt(process.env.CACHE_WARM_LEAD_TIME_MS ?? "30000", 10);

// --------------------------------------------------------------------------------
// Cache warming helpers
// --------------------------------------------------------------------------------

function clearEntryTimer(entry) {
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = undefined;
  }
}

function scheduleRefresh(key, entry) {
  clearEntryTimer(entry);
  const delay = Math.max(0, entry.expiresAt - Date.now() - WARM_LEAD_TIME_MS);
  entry.refreshTimer = setTimeout(() => {
    void refreshEntry(key);
  }, delay);
  if (entry.refreshTimer.unref) entry.refreshTimer.unref();
}

async function refreshEntry(key) {
  const entry = store.get(key);
  if (!entry || !entry.refreshFn || entry.refreshing) return;

  entry.refreshing = true;
  const startedAt = Date.now();
  try {
    const newValue = await entry.refreshFn();
    // Store the fresh value; this also schedules the next refresh.
    cacheSet(key, newValue, entry.ttlMs);
    recordCacheRefresh(Date.now() - startedAt);
  } catch (err) {
    logger.warn(`[cache] REFRESH FAILED ${key}`, { error: err.message });
    // Gracefully degrade: keep the stale value available for reads.
    // The periodic scheduler will retry on its next pass.
  } finally {
    const current = store.get(key);
    if (current && current.refreshing) {
      current.refreshing = false;
    }
  }
}

/**
 * Register a loader for a cache namespace. When an entry in this namespace is
 * cached, a background refresh will be scheduled before TTL expiry using this
 * loader. The loader receives the full cache key and must return the fresh
 * value for that key.
 *
 * @param {string} namespace - first segment of the cache key (e.g. "collaborators")
 * @param {(key: string) => Promise<unknown> } loader
 */
export function registerCacheLoader(namespace, loader) {
  loaders.set(namespace, loader);
}

/**
 * Force a refresh for a single cache key. Useful for the background warmer.
 * If the key is not cached, this is a no-op unless a loader exists and the
 * key can be derived (we leave that to higher-level warmers).
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function refreshCacheEntry(key) {
  const entry = store.get(key);
  if (!entry || !entry.refreshFn || entry.refreshing) return;
  await refreshEntry(key);
}

// --------------------------------------------------------------------------------
// Public cache API
// --------------------------------------------------------------------------------

/**
 * Build a namespaced cache key.
 *
 * @param {string} namespace  - logical group, e.g. "collaborators"
 * @param {string} identifier - contract ID or compound key
 * @param {string} [suffix]   - optional extra discriminator (e.g. pagination)
 * @returns {string}
 */
export function cacheKey(namespace, identifier, suffix = "") {
  return suffix ? `${namespace}::${identifier}::${suffix}` : `${namespace}::${identifier}`;
}

/**
 * Read a cache entry.  Returns `undefined` on a miss or expired entry.
 *
 * For entries registered with a loader, returns stale data while a refresh is
 * in-flight and triggers a refresh on expired reads (stale-while-revalidate).
 *
 * @param {string} key
 * @returns {unknown|undefined}
 */
export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) {
    recordCacheMiss();
    return undefined;
  }

  const now = Date.now();
  if (now <= entry.expiresAt) {
    recordCacheHit();
    return entry.value;
  }

  // Expired: if we can refresh, serve stale data and kick off a background refresh.
  if (entry.refreshFn) {
    recordCacheStaleServed();
    if (!entry.refreshing) {
      void refreshEntry(key);
    }
    return entry.value;
  }

  // Non-warmable entry: treat as a miss and remove.
  clearEntryTimer(entry);
  store.delete(key);
  recordCacheMiss();
  return undefined;
}

/**
 * Write a cache entry.
 *
 * @param {string}  key
 * @param {unknown} value
 * @param {number}  ttlMs  - time-to-live in milliseconds
 */
export function cacheSet(key, value, ttlMs) {
  if (ttlMs <= 0) return; // TTL of 0 disables caching for that namespace

  const existing = store.get(key);
  if (existing) clearEntryTimer(existing);

  const namespace = key.split(":")[0];
  const loader = loaders.get(namespace);
  const refreshFn = loader ? () => loader(key) : undefined;

  const entry = {
    value,
    expiresAt: Date.now() + ttlMs,
    ttlMs,
    refreshFn,
  };

  store.set(key, entry);
  if (refreshFn) scheduleRefresh(key, entry);

  logger.debug(`[cache] SET ${key} (ttl=${ttlMs}ms${refreshFn ? ", warm" : ""})`);
}

/**
 * Remove a single cache entry.
 *
 * @param {string} key
 */
export function cacheDel(key) {
  const entry = store.get(key);
  if (entry) {
    clearEntryTimer(entry);
    store.delete(key);
    logger.debug(`[cache] DEL ${key}`);
  }
}

/**
 * Invalidate all cache entries that belong to a given contract ID.
 * Called after any successful write that changes on-chain or off-chain state.
 *
 * @param {string} contractId
 */
export function invalidateContract(contractId) {
  let count = 0;
  for (const [key, entry] of store) {
    if (key.includes(contractId)) {
      clearEntryTimer(entry);
      store.delete(key);
      count++;
    }
  }
  if (count > 0) {
    logger.info(`[cache] invalidated ${count} entr${count === 1 ? "y" : "ies"} for contract ${contractId}`);
  }
}

/**
 * Flush the entire cache (useful in tests).
 */
export function clearCache() {
  for (const entry of store.values()) {
    clearEntryTimer(entry);
  }
  store.clear();
}

/**
 * Return the number of live (non-expired) entries.
 * Useful for health metrics and tests.
 *
 * @returns {number}
 */
export function cacheSize() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) {
    if (now <= entry.expiresAt) live++;
  }
  return live;
}

/**
 * Return all cache keys (useful for debugging and tests).
 * @returns {string[]}
 */
export function cacheKeys() {
  return Array.from(store.keys());
}
