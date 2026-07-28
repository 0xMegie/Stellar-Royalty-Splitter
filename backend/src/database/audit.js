/**
 * Audit logging functions.
 * Tracks all contract-related actions for compliance and debugging.
 */

import { db, countWrite } from "./core.js";

export function getAuditLog(contractId, limit = 100, offset = 0, filters = {}) {
  const { action, user, startDate, endDate, search } = filters;

  let query = `
    SELECT 
      id,
      contractId,
      action,
      user,
      details,
      timestamp
    FROM audit_log
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (user) {
    query += ` AND user = ?`;
    params.push(user);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  if (search) {
    query += ` AND (action LIKE ? OR user LIKE ? OR details LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params).map((row) => {
    let details = null;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (_) {
      // Keep malformed legacy audit details readable as null.
    }
    return { ...row, details };
  });
}

export function countAuditLog(contractId, filters = {}) {
  const { action, user, startDate, endDate, search } = filters;

  let query = `SELECT COUNT(*) as total FROM audit_log WHERE contractId = ?`;
  const params = [contractId];

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (user) {
    query += ` AND user = ?`;
    params.push(user);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  if (search) {
    query += ` AND (action LIKE ? OR user LIKE ? OR details LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  return db.prepare(query).get(...params).total;
}

export function addAuditLog(contractId, action, user, details) {
  const stmt = db.prepare(`
    INSERT INTO audit_log 
    (contractId, action, user, details)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, JSON.stringify(details));
  countWrite();
}
