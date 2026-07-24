import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { initializeDatabase, closeDatabase, getAuditLog, addAuditLog, countAuditLog } from "../src/database/index.js";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Audit Log Search and Filter", () => {
  const testDbPath = path.join(__dirname, "test-audit-search.db");

  beforeEach(() => {
    // Clean up any existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    process.env.DATABASE_PATH = testDbPath;
    initializeDatabase();

    // Seed test data
    const contractId = "test-contract-123";
    
    // Add various audit log entries
    addAuditLog(contractId, "initialize", "user1", { collaborators: 5 });
    addAuditLog(contractId, "distribute", "user1", { amount: "100" });
    addAuditLog(contractId, "distribute", "user2", { amount: "200" });
    addAuditLog(contractId, "update_share", "user1", { collaborator: "addr1" });
    addAuditLog(contractId, "update_share", "user2", { collaborator: "addr2" });
    addAuditLog(contractId, "pause", "admin", { reason: "maintenance" });
    
    // Add entries for a different contract
    addAuditLog("other-contract", "initialize", "user3", { collaborators: 3 });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe("Basic functionality", () => {
    it("should return all audit logs without filters", () => {
      const results = getAuditLog("test-contract-123", 50, 0);
      expect(results).toHaveLength(6);
    });

    it("should count all audit logs without filters", () => {
      const count = countAuditLog("test-contract-123");
      expect(count).toBe(6);
    });

    it("should return empty array for contract with no logs", () => {
      const results = getAuditLog("nonexistent-contract", 50, 0);
      expect(results).toHaveLength(0);
    });

    it("should count 0 for contract with no logs", () => {
      const count = countAuditLog("nonexistent-contract");
      expect(count).toBe(0);
    });
  });

  describe("Action filter", () => {
    it("should filter by action type", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { action: "distribute" });
      expect(results).toHaveLength(2);
      results.forEach((entry) => {
        expect(entry.action).toBe("distribute");
      });
    });

    it("should count filtered results by action", () => {
      const count = countAuditLog("test-contract-123", { action: "distribute" });
      expect(count).toBe(2);
    });

    it("should return empty for non-existent action", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { action: "nonexistent" });
      expect(results).toHaveLength(0);
    });
  });

  describe("User filter", () => {
    it("should filter by user", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { user: "user1" });
      expect(results).toHaveLength(3);
      results.forEach((entry) => {
        expect(entry.user).toBe("user1");
      });
    });

    it("should count filtered results by user", () => {
      const count = countAuditLog("test-contract-123", { user: "user1" });
      expect(count).toBe(3);
    });

    it("should return empty for non-existent user", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { user: "nonexistent" });
      expect(results).toHaveLength(0);
    });
  });

  describe("Date range filter", () => {
    it("should filter by start date", () => {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() - 1);
      const startDateStr = startDate.toISOString();
      
      const results = getAuditLog("test-contract-123", 50, 0, { startDate: startDateStr });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should filter by end date", () => {
      const endDate = new Date();
      endDate.setHours(endDate.getHours() + 1);
      const endDateStr = endDate.toISOString();
      
      const results = getAuditLog("test-contract-123", 50, 0, { endDate: endDateStr });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should filter by date range", () => {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() - 1);
      const endDate = new Date();
      endDate.setHours(endDate.getHours() + 1);
      
      const results = getAuditLog("test-contract-123", 50, 0, {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return empty for future date range", () => {
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() + 10);
      const endDate = new Date();
      endDate.setFullYear(endDate.getFullYear() + 11);
      
      const results = getAuditLog("test-contract-123", 50, 0, {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("Search functionality", () => {
    it("should search by action keyword", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { search: "dist" });
      expect(results.length).toBeGreaterThan(0);
      results.forEach((entry) => {
        expect(entry.action.toLowerCase()).toContain("dist");
      });
    });

    it("should search by user keyword", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { search: "user1" });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should search by details content", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { search: "100" });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return empty for non-matching search", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { search: "nonexistent12345" });
      expect(results).toHaveLength(0);
    });
  });

  describe("Combined filters", () => {
    it("should combine action and user filters", () => {
      const results = getAuditLog("test-contract-123", 50, 0, {
        action: "distribute",
        user: "user1",
      });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("distribute");
      expect(results[0].user).toBe("user1");
    });

    it("should combine action and date range filters", () => {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() - 1);
      const endDate = new Date();
      endDate.setHours(endDate.getHours() + 1);
      
      const results = getAuditLog("test-contract-123", 50, 0, {
        action: "distribute",
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      expect(results.length).toBeGreaterThan(0);
      results.forEach((entry) => {
        expect(entry.action).toBe("distribute");
      });
    });

    it("should combine user and date range filters", () => {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() - 1);
      const endDate = new Date();
      endDate.setHours(endDate.getHours() + 1);
      
      const results = getAuditLog("test-contract-123", 50, 0, {
        user: "user1",
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      expect(results.length).toBeGreaterThan(0);
      results.forEach((entry) => {
        expect(entry.user).toBe("user1");
      });
    });

    it("should combine all filters", () => {
      const startDate = new Date();
      startDate.setHours(startDate.getHours() - 1);
      const endDate = new Date();
      endDate.setHours(endDate.getHours() + 1);
      
      const results = getAuditLog("test-contract-123", 50, 0, {
        action: "distribute",
        user: "user1",
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        search: "100",
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should count with combined filters", () => {
      const count = countAuditLog("test-contract-123", {
        action: "distribute",
        user: "user1",
      });
      expect(count).toBe(1);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", () => {
      const results = getAuditLog("test-contract-123", 2, 0);
      expect(results).toHaveLength(2);
    });

    it("should respect offset parameter", () => {
      const firstPage = getAuditLog("test-contract-123", 2, 0);
      const secondPage = getAuditLog("test-contract-123", 2, 2);
      
      expect(firstPage).toHaveLength(2);
      expect(secondPage).toHaveLength(2);
      
      // Ensure different results
      const firstIds = firstPage.map((r) => r.id);
      const secondIds = secondPage.map((r) => r.id);
      expect(firstIds).not.toEqual(secondIds);
    });

    it("should return empty results when offset exceeds total", () => {
      const results = getAuditLog("test-contract-123", 50, 100);
      expect(results).toHaveLength(0);
    });

    it("should count total regardless of pagination", () => {
      const count = countAuditLog("test-contract-123");
      expect(count).toBe(6);
    });
  });

  describe("Performance", () => {
    it("should handle large datasets efficiently", () => {
      const contractId = "performance-test-contract";
      
      // Add 1000 entries
      for (let i = 0; i < 1000; i++) {
        addAuditLog(contractId, `action_${i % 10}`, `user_${i % 5}`, { index: i });
      }
      
      const start = Date.now();
      const results = getAuditLog(contractId, 50, 0, { action: "action_0" });
      const duration = Date.now() - start;
      
      expect(results.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500); // Should complete in less than 500ms
    });

    it("should count large datasets efficiently", () => {
      const contractId = "count-performance-test";
      
      // Add 1000 entries
      for (let i = 0; i < 1000; i++) {
        addAuditLog(contractId, `action_${i % 10}`, `user_${i % 5}`, { index: i });
      }
      
      const start = Date.now();
      const count = countAuditLog(contractId, { action: "action_0" });
      const duration = Date.now() - start;
      
      expect(count).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500); // Should complete in less than 500ms
    });
  });

  describe("Edge cases", () => {
    it("should handle empty filters object", () => {
      const results = getAuditLog("test-contract-123", 50, 0, {});
      expect(results).toHaveLength(6);
    });

    it("should handle null/undefined filter values", () => {
      const results = getAuditLog("test-contract-123", 50, 0, {
        action: null,
        user: undefined,
        startDate: null,
        endDate: undefined,
        search: null,
      });
      expect(results).toHaveLength(6);
    });

    it("should handle special characters in search", () => {
      const results = getAuditLog("test-contract-123", 50, 0, { search: "%" });
      // Should not throw error
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
