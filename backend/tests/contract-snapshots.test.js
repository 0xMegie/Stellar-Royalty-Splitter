/**
 * Tests for contract state snapshots (#613).
 *
 * Covers:
 *   - Snapshot table initialization
 *   - Creating snapshots
 *   - Listing snapshots
 *   - Getting a snapshot by ID
 *   - Verifying snapshot integrity
 *   - Pruning old snapshots
 *   - All snapshots admin view
 *   - Snapshot scheduler
 */

import { db, initializeDatabase } from "../src/database/index.js";
import {
  ensureSnapshotTable,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  verifySnapshotIntegrity,
  countSnapshots,
  getAllSnapshots,
  pruneSnapshots,
} from "../src/database/contract-snapshots.js";

// Helper to reset test state
const TEST_CONTRACT = "CCJFT3Q7V4TFL4ZXWYX4R5X3K5X5K5X5K5X5K5X5K5X5K5X5K5X5K5X5";

function cleanTestSnapshots() {
  db.prepare("DELETE FROM contract_snapshots WHERE contractId = ?").run(TEST_CONTRACT);
}

describe("Contract State Snapshots", () => {
  beforeAll(() => {
    initializeDatabase();
    ensureSnapshotTable();
  });

  beforeEach(() => {
    cleanTestSnapshots();
  });

  afterAll(() => {
    cleanTestSnapshots();
  });

  describe("ensureSnapshotTable", () => {
    test("creates the contract_snapshots table", () => {
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='contract_snapshots'"
        )
        .get();
      expect(tableExists).toBeTruthy();
    });
  });

  describe("createSnapshot", () => {
    test("creates a snapshot with all fields", () => {
      const snapshot = createSnapshot({
        contractId: TEST_CONTRACT,
        label: "test-snapshot-1",
        collaborators: JSON.stringify(["GABCD...", "GEFGH..."]),
        shares: JSON.stringify({ "GABCD...": 60, "GEFGH...": 40 }),
        balances: JSON.stringify({ "GABCD...": "1000", "GEFGH...": "500" }),
        transactionCount: 42,
        lastTransactionId: 100,
        createdBy: "test-operator",
      });

      expect(snapshot).toBeDefined();
      expect(snapshot.contractId).toBe(TEST_CONTRACT);
      expect(snapshot.label).toBe("test-snapshot-1");
      expect(snapshot.transactionCount).toBe(42);
      expect(snapshot.lastTransactionId).toBe(100);
      expect(snapshot.createdBy).toBe("test-operator");
      expect(snapshot.id).toBeGreaterThan(0);
      expect(snapshot.stateHash).toBeDefined();
      expect(snapshot.stateHash.length).toBe(64); // SHA-256 hex
    });

    test("creates a snapshot with minimal fields", () => {
      const snapshot = createSnapshot({
        contractId: TEST_CONTRACT,
      });

      expect(snapshot).toBeDefined();
      expect(snapshot.contractId).toBe(TEST_CONTRACT);
      expect(snapshot.label).toBeNull();
      expect(snapshot.collaborators).toBe("[]");
      expect(snapshot.shares).toBe("{}");
      expect(snapshot.balances).toBe("{}");
      expect(snapshot.transactionCount).toBe(0);
      expect(snapshot.stateHash).toBeDefined();
    });

    test("creates a snapshot with explicit empty state", () => {
      const snapshot = createSnapshot({
        contractId: TEST_CONTRACT,
        label: "empty-state",
        collaborators: "[]",
        shares: "{}",
        balances: "{}",
        transactionCount: 0,
      });

      expect(snapshot.label).toBe("empty-state");
      expect(snapshot.transactionCount).toBe(0);
    });

    test("generates different hashes for different data", () => {
      const s1 = createSnapshot({
        contractId: TEST_CONTRACT,
        shares: JSON.stringify({ addr1: 100 }),
      });

      const s2 = createSnapshot({
        contractId: TEST_CONTRACT,
        shares: JSON.stringify({ addr1: 200 }),
      });

      expect(s1.stateHash).not.toBe(s2.stateHash);
    });
  });

  describe("listSnapshots", () => {
    test("returns empty list when no snapshots exist", () => {
      const snapshots = listSnapshots(TEST_CONTRACT);
      expect(snapshots).toEqual([]);
    });

    test("returns snapshots in reverse chronological order", () => {
      createSnapshot({ contractId: TEST_CONTRACT, label: "first" });
      createSnapshot({ contractId: TEST_CONTRACT, label: "second" });
      createSnapshot({ contractId: TEST_CONTRACT, label: "third" });

      const snapshots = listSnapshots(TEST_CONTRACT);
      expect(snapshots).toHaveLength(3);
      expect(snapshots[0].label).toBe("third");
      expect(snapshots[1].label).toBe("second");
      expect(snapshots[2].label).toBe("first");
    });

    test("respects pagination", () => {
      for (let i = 0; i < 5; i++) {
        createSnapshot({ contractId: TEST_CONTRACT, label: `snapshot-${i}` });
      }

      const page1 = listSnapshots(TEST_CONTRACT, { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].label).toBe("snapshot-4");

      const page2 = listSnapshots(TEST_CONTRACT, { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].label).toBe("snapshot-2");
    });
  });

  describe("getSnapshot", () => {
    test("returns null for non-existent snapshot", () => {
      const snapshot = getSnapshot(99999);
      expect(snapshot).toBeNull();
    });

    test("returns the correct snapshot by ID", () => {
      const created = createSnapshot({
        contractId: TEST_CONTRACT,
        label: "find-me",
      });

      const found = getSnapshot(created.id);
      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.label).toBe("find-me");
    });

    test("returns all fields", () => {
      const created = createSnapshot({
        contractId: TEST_CONTRACT,
        label: "full-check",
        collaborators: JSON.stringify(["addr1", "addr2"]),
        shares: JSON.stringify({ addr1: 50, addr2: 50 }),
        balances: JSON.stringify({ addr1: "500", addr2: "500" }),
        transactionCount: 10,
        lastTransactionId: 25,
        createdBy: "tester",
      });

      const found = getSnapshot(created.id);
      expect(found.collaborators).toBe(JSON.stringify(["addr1", "addr2"]));
      expect(found.shares).toBe(JSON.stringify({ addr1: 50, addr2: 50 }));
      expect(found.balances).toBe(JSON.stringify({ addr1: "500", addr2: "500" }));
      expect(found.stateHash).toBeDefined();
    });
  });

  describe("verifySnapshotIntegrity", () => {
    test("returns valid: true for unmodified snapshot", () => {
      const snapshot = createSnapshot({
        contractId: TEST_CONTRACT,
        collaborators: JSON.stringify(["addr1"]),
        shares: JSON.stringify({ addr1: 100 }),
        balances: JSON.stringify({ addr1: "1000" }),
      });

      const result = verifySnapshotIntegrity(snapshot.id);
      expect(result.valid).toBe(true);
      expect(result.computedHash).toBe(result.storedHash);
    });

    test("returns valid: false for non-existent snapshot", () => {
      const result = verifySnapshotIntegrity(99999);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Snapshot not found");
    });
  });

  describe("countSnapshots", () => {
    test("returns 0 when no snapshots exist", () => {
      expect(countSnapshots(TEST_CONTRACT)).toBe(0);
    });

    test("returns correct count", () => {
      createSnapshot({ contractId: TEST_CONTRACT });
      createSnapshot({ contractId: TEST_CONTRACT });
      expect(countSnapshots(TEST_CONTRACT)).toBe(2);
    });
  });

  describe("getAllSnapshots", () => {
    test("returns all snapshots across contracts", () => {
      createSnapshot({ contractId: TEST_CONTRACT, label: "contract-a" });
      const otherContract = "CCDEMO1234567890";
      createSnapshot({ contractId: otherContract, label: "contract-b" });

      const all = getAllSnapshots({ limit: 100, offset: 0 });
      const relevant = all.filter(
        (s) => s.contractId === TEST_CONTRACT || s.contractId === otherContract
      );
      expect(relevant.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("pruneSnapshots", () => {
    test("deletes old snapshots beyond keep count", () => {
      for (let i = 0; i < 5; i++) {
        createSnapshot({ contractId: TEST_CONTRACT, label: `prune-test-${i}` });
      }

      const deleted = pruneSnapshots(TEST_CONTRACT, 3);
      expect(deleted).toBe(2);

      const remaining = listSnapshots(TEST_CONTRACT);
      expect(remaining).toHaveLength(3);
    });

    test("keeps all snapshots when count exceeds total", () => {
      for (let i = 0; i < 3; i++) {
        createSnapshot({ contractId: TEST_CONTRACT, label: `keep-all-${i}` });
      }

      const deleted = pruneSnapshots(TEST_CONTRACT, 10);
      expect(deleted).toBe(0);

      const remaining = listSnapshots(TEST_CONTRACT);
      expect(remaining).toHaveLength(3);
    });
  });
});