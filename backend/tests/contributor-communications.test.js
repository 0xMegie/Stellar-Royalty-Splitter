/**
 * Tests for contributor communication history (#612).
 *
 * Covers:
 *   - Table initialization
 *   - Recording communications (email, support_ticket, message, internal_note)
 *   - Getting communications by wallet
 *   - Getting communications by contract
 *   - Searching communications
 *   - Adding internal notes (admin only)
 *   - Communication timeline
 *   - Counting communications
 *   - Internal note visibility
 */

import { db, initializeDatabase } from "../src/database/index.js";
import {
  ensureCommunicationsTable,
  recordCommunication,
  getCommunicationsByWallet,
  getCommunicationsByContract,
  searchCommunications,
  addInternalNote,
  getCommunicationTimeline,
  countCommunications,
} from "../src/database/contributor-communications.js";

const TEST_WALLET = "GA7QYNF7SOWQ3GLR2BGM4GJ3DPZ3Q4Y5Q6R7S8T9U0V1W2X3Y4Z5A6B7C";
const TEST_CONTRACT = "CCJFT3Q7V4TFL4ZXWYX4R5X3K5X5K5X5K5X5K5X5K5X5K5X5K5X5K5X5";

function cleanTestData() {
  db.prepare("DELETE FROM contributor_communications WHERE walletAddress = ?").run(TEST_WALLET);
}

describe("Contributor Communication History", () => {
  beforeAll(() => {
    initializeDatabase();
    ensureCommunicationsTable();
  });

  beforeEach(() => {
    cleanTestData();
  });

  afterAll(() => {
    cleanTestData();
  });

  describe("ensureCommunicationsTable", () => {
    test("creates the contributor_communications table", () => {
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='contributor_communications'"
        )
        .get();
      expect(tableExists).toBeTruthy();
    });
  });

  describe("recordCommunication", () => {
    test("records an email communication", () => {
      const comm = recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        subject: "Payment Confirmation",
        body: "Your payment of 100 XLM has been processed.",
        direction: "outbound",
        createdBy: "system",
      });

      expect(comm).toBeDefined();
      expect(comm.walletAddress).toBe(TEST_WALLET);
      expect(comm.type).toBe("email");
      expect(comm.subject).toBe("Payment Confirmation");
      expect(comm.direction).toBe("outbound");
      expect(comm.isInternal).toBe(false);
      expect(comm.id).toBeGreaterThan(0);
    });

    test("records a support ticket", () => {
      const comm = recordCommunication({
        walletAddress: TEST_WALLET,
        contractId: TEST_CONTRACT,
        type: "support_ticket",
        subject: "Missing Payment",
        body: "I did not receive my royalty payment for March.",
        direction: "inbound",
        referenceId: "TKT-12345",
        metadata: { priority: "high", category: "payment" },
      });

      expect(comm.type).toBe("support_ticket");
      expect(comm.contractId).toBe(TEST_CONTRACT);
      expect(comm.referenceId).toBe("TKT-12345");
      expect(comm.metadata).toBe(JSON.stringify({ priority: "high", category: "payment" }));
    });

    test("records a message", () => {
      const comm = recordCommunication({
        walletAddress: TEST_WALLET,
        type: "message",
        body: "Thanks for the quick response!",
        direction: "inbound",
      });

      expect(comm.type).toBe("message");
      expect(comm.body).toBe("Thanks for the quick response!");
    });

    test("records a system notification", () => {
      const comm = recordCommunication({
        walletAddress: TEST_WALLET,
        type: "system_notification",
        subject: "Contract Updated",
        body: "Your contract has been updated with new terms.",
        direction: "outbound",
        status: "sent",
      });

      expect(comm.type).toBe("system_notification");
      expect(comm.status).toBe("sent");
    });

    test("records an internal note", () => {
      const comm = recordCommunication({
        walletAddress: TEST_WALLET,
        type: "internal_note",
        body: "Customer called about delayed payment. Escalated to finance team.",
        direction: "internal",
        isInternal: true,
        createdBy: "admin@example.com",
      });

      expect(comm.type).toBe("internal_note");
      expect(comm.isInternal).toBe(true);
      expect(comm.direction).toBe("internal");
    });

    test("rejects invalid communication type", () => {
      expect(() => {
        recordCommunication({
          walletAddress: TEST_WALLET,
          type: "invalid_type",
          body: "test",
          direction: "inbound",
        });
      }).toThrow();
    });

    test("rejects invalid direction", () => {
      expect(() => {
        recordCommunication({
          walletAddress: TEST_WALLET,
          type: "email",
          body: "test",
          direction: "invalid_direction",
        });
      }).toThrow();
    });
  });

  describe("getCommunicationsByWallet", () => {
    test("returns empty array for wallet with no communications", () => {
      const comms = getCommunicationsByWallet("GUNRELATEDWALLET1234567890123456789012345678901");
      expect(comms).toEqual([]);
    });

    test("returns communications for a wallet in reverse chronological order", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "First message",
        direction: "outbound",
      });

      // Small delay to ensure different timestamps
      const comm2 = recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Second message",
        direction: "inbound",
      });

      const comms = getCommunicationsByWallet(TEST_WALLET);
      expect(comms).toHaveLength(2);
      expect(comms[0].body).toBe("Second message");
    });

    test("excludes internal notes by default", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Normal communication",
        direction: "outbound",
      });

      addInternalNote({
        walletAddress: TEST_WALLET,
        body: "Internal admin note",
        createdBy: "admin",
      });

      const comms = getCommunicationsByWallet(TEST_WALLET);
      expect(comms).toHaveLength(1);
      expect(comms[0].body).toBe("Normal communication");
    });

    test("includes internal notes when requested", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Normal communication",
        direction: "outbound",
      });

      addInternalNote({
        walletAddress: TEST_WALLET,
        body: "Internal admin note",
        createdBy: "admin",
      });

      const comms = getCommunicationsByWallet(TEST_WALLET, { includeInternal: true });
      expect(comms).toHaveLength(2);
    });
  });

  describe("getCommunicationsByContract", () => {
    test("returns communications for a contract", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        contractId: TEST_CONTRACT,
        type: "email",
        body: "Contract related communication",
        direction: "outbound",
      });

      const comms = getCommunicationsByContract(TEST_CONTRACT);
      expect(comms).toHaveLength(1);
      expect(comms[0].body).toBe("Contract related communication");
    });
  });

  describe("searchCommunications", () => {
    test("finds communications by body content", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Payment issue with the latest distribution",
        direction: "inbound",
      });

      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "General inquiry about the platform",
        direction: "inbound",
      });

      const results = searchCommunications("Payment issue");
      expect(results).toHaveLength(1);
      expect(results[0].body).toContain("Payment issue");
    });

    test("finds communications by subject", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        subject: "Urgent: Payment Delay",
        body: "My payment is delayed.",
        direction: "inbound",
      });

      const results = searchCommunications("Urgent");
      expect(results).toHaveLength(1);
    });

    test("finds communications by wallet address", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Test communication",
        direction: "outbound",
      });

      const results = searchCommunications(TEST_WALLET.slice(0, 10));
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("returns empty array for no matches", () => {
      const results = searchCommunications("nonexistent_content_xyz");
      expect(results).toEqual([]);
    });
  });

  describe("addInternalNote", () => {
    test("creates an internal note", () => {
      const note = addInternalNote({
        walletAddress: TEST_WALLET,
        contractId: TEST_CONTRACT,
        body: "Reviewed account. All payments are up to date.",
        createdBy: "admin@example.com",
      });

      expect(note.type).toBe("internal_note");
      expect(note.isInternal).toBe(true);
      expect(note.direction).toBe("internal");
      expect(note.contractId).toBe(TEST_CONTRACT);
    });

    test("internal notes are not visible to regular queries", () => {
      addInternalNote({
        walletAddress: TEST_WALLET,
        body: "Confidential admin note",
        createdBy: "admin",
      });

      const comms = getCommunicationsByWallet(TEST_WALLET);
      const internalNotes = comms.filter((c) => c.isInternal);
      expect(internalNotes).toHaveLength(0);
    });
  });

  describe("getCommunicationTimeline", () => {
    test("returns communications in chronological order", () => {
      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "First communication",
        direction: "inbound",
      });

      recordCommunication({
        walletAddress: TEST_WALLET,
        type: "email",
        body: "Second communication",
        direction: "outbound",
      });

      const timeline = getCommunicationTimeline(TEST_WALLET);
      expect(timeline).toHaveLength(2);
      expect(timeline[0].body).toBe("First communication");
      expect(timeline[1].body).toBe("Second communication");
    });
  });

  describe("countCommunications", () => {
    test("returns 0 for wallet with no communications", () => {
      const count = countCommunications("GUNRELATEDWALLET1234567890123456789012345678901");
      expect(count).toBe(0);
    });

    test("returns correct count excluding internal notes", () => {
      recordCommunication({ walletAddress: TEST_WALLET, type: "email", body: "Comm 1", direction: "outbound" });
      recordCommunication({ walletAddress: TEST_WALLET, type: "email", body: "Comm 2", direction: "inbound" });
      addInternalNote({ walletAddress: TEST_WALLET, body: "Internal note", createdBy: "admin" });

      expect(countCommunications(TEST_WALLET)).toBe(2);
      expect(countCommunications(TEST_WALLET, { includeInternal: true })).toBe(3);
    });
  });
});