/**
 * Lightweight in-memory cache for read-only royalty data (#683).
 *
 * Eligible endpoints:
 *   - GET /api/v1/collaborators/:contractId
 *   - GET /api/v1/contract/state and /api/v1/contract/info
 *   - GET /api/v1/history/:contractId
 *
 * Configuration (environment variables):
 *   CACHE_TTL_MS              — default TTL for all cached entries (default: 30 000 ms / 30 s)
 *   CACHE_COLLABORATORS_TTL_MS — override TTL for collaborator responses
 *   CACHE_CONTRACT_TTL_MS      — override TTL for contract state/info responses
 *   CACHE_HISTORY_TTL_MS       — override TTL for history responses
 *
 * Entries are invalidated automatically when a write operation succeeds
 * (initialize, distribute, secondary-royalty write).  Call
 * `invalidateContract(contractId)` from route handlers after a confirmed write.
 *
 * Sensitive data (transaction creation, signing) is never cached.
 */

import logger from "./logger.js";

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? "30000", 10);

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
    return ttl("CACHE_COLLABORATORS_TTL_MS");
  },
  get contractState() {
    return ttl("CACHE_CONTRACT_TTL_MS");
  },
  get history() {
    return ttl("CACHE_HISTORY_TTL_MS");
  },
};

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

/**
 * @typedef {{ value: unknown, expiresAt: number }} CacheEntry
 * @type {Map<string, CacheEntry>}
 */
const store = new Map();

/**
 * Build a namespaced cache key.
 *
 * @param {string} namespace  - logical group, e.g. "collaborators"
 * @param {string} identifier - contract ID or compound key
 * @param {string} [suffix]   - optional extra discriminator (e.g. pagination)
 * @returns {string}
 */
export function cacheKey(namespace, identifier, suffix = "") {
  return suffix ? `${namespace}:${identifier}:${suffix}` : `${namespace}:${identifier}`;
}

/**
 * Read a cache entry.  Returns `undefined` on a miss or expired entry.
 *
 * @param {string} key
 * @returns {unknown|undefined}
 */
export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
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
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  logger.debug(`[cache] SET ${key} (ttl=${ttlMs}ms)`);
}

/**
 * Remove a single cache entry.
 *
 * @param {string} key
 */
export function cacheDel(key) {
  if (store.delete(key)) {
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
  for (const key of store.keys()) {
    if (key.includes(contractId)) {
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
