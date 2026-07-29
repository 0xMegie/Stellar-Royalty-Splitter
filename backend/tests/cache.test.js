/**
 * Tests for the in-memory royalty data cache (#683).
 *
 * Covers:
 *  - cache hit and miss
 *  - TTL expiry
 *  - invalidateContract removes entries belonging to a contract
 *  - TTL=0 disables caching
 *  - cacheSize counts only live entries
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Import the cache module under test (ESM, mocked Date.now via jest.spyOn)
const {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheKey,
  clearCache,
  cacheSize,
  invalidateContract,
} = await import("../src/cache.js");

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("cache helpers (#683)", () => {
  let nowSpy;

  beforeEach(() => {
    clearCache();
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // Basic hit / miss
  // ------------------------------------------------------------------

  test("returns undefined on a cold cache miss", () => {
    expect(cacheGet(cacheKey("collaborators", CONTRACT_A))).toBeUndefined();
  });

  test("returns stored value immediately after cacheSet", () => {
    const key = cacheKey("collaborators", CONTRACT_A);
    const value = [{ address: "GXXX", basisPoints: 5000 }];

    cacheSet(key, value, 30_000);

    expect(cacheGet(key)).toEqual(value);
  });

  test("cache hit does not count as miss", () => {
    const key = cacheKey("history", CONTRACT_A, "50:0:");
    cacheSet(key, { success: true, data: [] }, 30_000);

    // Two reads should both succeed
    expect(cacheGet(key)).toBeDefined();
    expect(cacheGet(key)).toBeDefined();
  });

  // ------------------------------------------------------------------
  // TTL expiry
  // ------------------------------------------------------------------

  test("returns value while within TTL", () => {
    const key = cacheKey("collaborators", CONTRACT_A);
    cacheSet(key, ["collab"], 30_000);

    nowSpy.mockReturnValue(30_999); // 29 999 ms elapsed → still fresh
    expect(cacheGet(key)).toEqual(["collab"]);
  });

  test("returns undefined after TTL expires", () => {
    const key = cacheKey("collaborators", CONTRACT_A);
    cacheSet(key, ["collab"], 30_000);

    nowSpy.mockReturnValue(31_001); // 30 001 ms elapsed → expired
    expect(cacheGet(key)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // cacheDel
  // ------------------------------------------------------------------

  test("cacheDel removes a specific entry", () => {
    const key = cacheKey("history", CONTRACT_A, "10:0:");
    cacheSet(key, { data: [] }, 60_000);
    expect(cacheGet(key)).toBeDefined();

    cacheDel(key);
    expect(cacheGet(key)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // invalidateContract
  // ------------------------------------------------------------------

  test("invalidateContract removes all entries for the given contract", () => {
    const k1 = cacheKey("collaborators", CONTRACT_A);
    const k2 = cacheKey("history", CONTRACT_A, "50:0:");
    const k3 = cacheKey("contractState", CONTRACT_A, "TOKEN123");
    const kOther = cacheKey("collaborators", CONTRACT_B);

    cacheSet(k1, ["a"], 60_000);
    cacheSet(k2, ["b"], 60_000);
    cacheSet(k3, ["c"], 60_000);
    cacheSet(kOther, ["d"], 60_000);

    invalidateContract(CONTRACT_A);

    expect(cacheGet(k1)).toBeUndefined();
    expect(cacheGet(k2)).toBeUndefined();
    expect(cacheGet(k3)).toBeUndefined();
    // Other contract must not be affected
    expect(cacheGet(kOther)).toEqual(["d"]);
  });

  test("invalidateContract is a no-op when no entries match", () => {
    // Should not throw even when nothing is cached
    expect(() => invalidateContract("CXXXUNKNOWNCONTRACT")).not.toThrow();
  });

  // ------------------------------------------------------------------
  // TTL = 0 disables caching
  // ------------------------------------------------------------------

  test("cacheSet with ttlMs=0 does not store the value", () => {
    const key = cacheKey("collaborators", CONTRACT_A);
    cacheSet(key, ["should not be stored"], 0);
    expect(cacheGet(key)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // cacheSize
  // ------------------------------------------------------------------

  test("cacheSize returns 0 on an empty cache", () => {
    expect(cacheSize()).toBe(0);
  });

  test("cacheSize counts only live entries", () => {
    const k1 = cacheKey("collaborators", CONTRACT_A);
    const k2 = cacheKey("history", CONTRACT_A, "50:0:");
    const k3 = cacheKey("collaborators", CONTRACT_B);

    cacheSet(k1, ["a"], 30_000);
    cacheSet(k2, ["b"], 5_000);  // short TTL
    cacheSet(k3, ["c"], 60_000);

    expect(cacheSize()).toBe(3);

    // Expire k2
    nowSpy.mockReturnValue(6_001);
    expect(cacheSize()).toBe(2);
  });

  // ------------------------------------------------------------------
  // clearCache
  // ------------------------------------------------------------------

  test("clearCache removes all entries", () => {
    cacheSet(cacheKey("collaborators", CONTRACT_A), ["a"], 60_000);
    cacheSet(cacheKey("history", CONTRACT_B, "10:0:"), ["b"], 60_000);

    clearCache();
    expect(cacheSize()).toBe(0);
  });
});
