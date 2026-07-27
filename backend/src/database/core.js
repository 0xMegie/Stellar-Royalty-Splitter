import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // safe with WAL, much faster
db.pragma("cache_size = -64000"); // 64MB page cache
db.pragma("foreign_keys = ON"); // enforce FK constraints
db.pragma("temp_store = MEMORY"); // temp tables in memory

// Checkpoint the WAL periodically to prevent unbounded growth.
let _writeCount = 0;
export function countWrite() {
  if (++_writeCount % 100 === 0) {
    checkpointDatabase();
  }
}

export function checkpointDatabase() {
  if (!db.open) return;

  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    logger.error("Error while checkpointing database WAL", err);
  }
}

export function closeDatabase() {
  if (!db.open) return;

  checkpointDatabase();
  db.close();
}

// Final checkpoint on clean shutdown.
process.on("exit", checkpointDatabase);
// SIGTERM and SIGINT are handled in index.js for graceful HTTP + DB shutdown.

// Initialize database schema
export function initializeDatabase() {
  // Migration version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = [
    {
      version: 1,
      sql: `/* initial schema — already applied via CREATE TABLE IF NOT EXISTS */`,
    },
    {
      version: 3,
      sql: `
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(contractId, url)
        );
        CREATE INDEX IF NOT EXISTS idx_webhooks_contractId ON webhooks(contractId);
      `,
    },
    {
      // #133: enforce FK constraints on existing databases by recreating
      // distribution_payouts and secondary_royalty_distributions with
      // ON DELETE CASCADE. SQLite doesn't support ADD CONSTRAINT, so we
      // use the rename-create-copy-drop pattern inside a transaction.
      version: 2,
      sql: `
        PRAGMA foreign_keys = OFF;

        BEGIN;

        CREATE TABLE IF NOT EXISTS distribution_payouts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL DEFAULT '',
          collaboratorAddress TEXT NOT NULL,
          amountReceived TEXT NOT NULL,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO distribution_payouts_new
          SELECT id, transactionId, contractId, collaboratorAddress, amountReceived
          FROM distribution_payouts;
        DROP TABLE distribution_payouts;
        ALTER TABLE distribution_payouts_new RENAME TO distribution_payouts;

        CREATE TABLE IF NOT EXISTS secondary_royalty_distributions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL,
          totalRoyaltiesDistributed TEXT NOT NULL,
          numberOfSales INTEGER NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO secondary_royalty_distributions_new
          SELECT id, transactionId, contractId, totalRoyaltiesDistributed, numberOfSales, timestamp
          FROM secondary_royalty_distributions;
        DROP TABLE secondary_royalty_distributions;
        ALTER TABLE secondary_royalty_distributions_new RENAME TO secondary_royalty_distributions;

        COMMIT;

        PRAGMA foreign_keys = ON;
      `,
    },
    {
      version: 5,
      sql: `
        CREATE TABLE IF NOT EXISTS payment_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          walletAddress TEXT NOT NULL UNIQUE,
          paymentMethod TEXT NOT NULL CHECK(paymentMethod IN ('direct_transfer', 'usdc', 'xlm')),
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_payment_preferences_walletAddress
          ON payment_preferences(walletAddress);
      `,
    },
    {
      version: 6,
        sql: `
          CREATE TABLE IF NOT EXISTS email_digest_subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL,
            timezone TEXT NOT NULL DEFAULT 'UTC',
            dayOfWeek INTEGER NOT NULL DEFAULT 0,
            hourOfDay INTEGER NOT NULL DEFAULT 9,
            enabled INTEGER NOT NULL DEFAULT 1,
            unsubscribeToken TEXT NOT NULL UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS email_digest_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscriberId INTEGER NOT NULL,
            weekStart TEXT NOT NULL,
            weekEnd TEXT NOT NULL,
            sentAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            earningsSummary TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'failed')),
            FOREIGN KEY(subscriberId) REFERENCES email_digest_subscribers(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_wallet
            ON email_digest_subscribers(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_enabled
            ON email_digest_subscribers(enabled);
          CREATE INDEX IF NOT EXISTS idx_email_digest_log_subscriber
            ON email_digest_log(subscriberId);
          CREATE INDEX IF NOT EXISTS idx_email_digest_log_week
            ON email_digest_log(weekStart, weekEnd);
        `,
      },
      {
        version: 7,
        sql: `
        ALTER TABLE transactions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN last_retry_time DATETIME;
        CREATE INDEX IF NOT EXISTS idx_transactions_retry_eligible
          ON transactions(status, type, retry_count, last_retry_time);
      `,
      },
      {
        version: 8,
        sql: `
          CREATE TABLE IF NOT EXISTS disputes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticketId TEXT NOT NULL UNIQUE,
            walletAddress TEXT NOT NULL,
            contractId TEXT,
            category TEXT NOT NULL CHECK(category IN ('wrong_amount', 'missing_payment', 'other')),
            description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'under_review', 'resolved', 'closed')),
            adminNote TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS dispute_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            disputeId INTEGER NOT NULL,
            author TEXT NOT NULL CHECK(author IN ('contributor', 'admin')),
            message TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(disputeId) REFERENCES disputes(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_disputes_walletAddress ON disputes(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
          CREATE INDEX IF NOT EXISTS idx_disputes_contractId ON disputes(contractId);
          CREATE INDEX IF NOT EXISTS idx_dispute_comments_disputeId ON dispute_comments(disputeId);
        `,
      },
      {
        // #603: contributor referral tracking
        version: 9,
        sql: `
          CREATE TABLE IF NOT EXISTS referrals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referrerAddress TEXT NOT NULL,
            referredAddress TEXT NOT NULL UNIQUE,
            referralCode TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'active', 'bonus_paid')),
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            activatedAt DATETIME
          );

          CREATE TABLE IF NOT EXISTS referral_bonuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referralId INTEGER NOT NULL,
            referrerAddress TEXT NOT NULL,
            bonusAmountStroops INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL,
            awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(referralId) REFERENCES referrals(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS referral_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            referralCode TEXT NOT NULL UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_referrals_referrerAddress
            ON referrals(referrerAddress);
          CREATE INDEX IF NOT EXISTS idx_referrals_referredAddress
            ON referrals(referredAddress);
          CREATE INDEX IF NOT EXISTS idx_referrals_referralCode
            ON referrals(referralCode);
          CREATE INDEX IF NOT EXISTS idx_referrals_status
            ON referrals(status);
          CREATE INDEX IF NOT EXISTS idx_referral_bonuses_referralId
            ON referral_bonuses(referralId);
          CREATE INDEX IF NOT EXISTS idx_referral_bonuses_referrerAddress
            ON referral_bonuses(referrerAddress);
          CREATE INDEX IF NOT EXISTS idx_referral_links_walletAddress
            ON referral_links(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_referral_links_referralCode
            ON referral_links(referralCode);
        `,
      },
      {
        version: 4,
        sql: `
        CREATE TABLE IF NOT EXISTS contract_event_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          originalTransactionId INTEGER NOT NULL,
          txHash TEXT,
          contractId TEXT NOT NULL,
          type TEXT NOT NULL,
          initiatorAddress TEXT NOT NULL,
          requestedAmount TEXT,
          tokenId TEXT,
          timestamp DATETIME,
          blockTime DATETIME,
          status TEXT NOT NULL,
          errorMessage TEXT,
          payoutCount INTEGER NOT NULL DEFAULT 0,
          payoutsJson TEXT NOT NULL DEFAULT '[]',
          archivedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(originalTransactionId)
        );

        CREATE TABLE IF NOT EXISTS event_archive_policy (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 1,
          retentionDays INTEGER NOT NULL DEFAULT 90,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT OR IGNORE INTO event_archive_policy (id, enabled, retentionDays)
        VALUES (1, 1, 90);

        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contractId
          ON contract_event_archive(contractId);
        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_timestamp
          ON contract_event_archive(COALESCE(blockTime, timestamp));
        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contract_time
          ON contract_event_archive(contractId, COALESCE(blockTime, timestamp));
      `,
    },
    {
      // #608: API rate-limit dashboard — per-key usage tracking
      version: 10,
      sql: `
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_value TEXT NOT NULL UNIQUE,
          label TEXT,
          custom_limit_per_minute INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS rate_limit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id INTEGER NOT NULL,
          bucket_minute TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          blocked_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE(key_id, bucket_minute),
          FOREIGN KEY(key_id) REFERENCES api_keys(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_api_keys_key_value
          ON api_keys(key_value);
        CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_bucket
          ON rate_limit_events(key_id, bucket_minute);
        CREATE INDEX IF NOT EXISTS idx_rate_limit_events_bucket
          ON rate_limit_events(bucket_minute);
      `,
    },
  ];

  const applied = db
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((r) => r.version);

  for (const migration of migrations) {
    if (!applied.includes(migration.version)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      logger.info(`Applied migration v${migration.version}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txHash TEXT UNIQUE,
      contractId TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initialize', 'distribute', 'secondary_royalty', 'secondary_distribute')),
      initiatorAddress TEXT NOT NULL,
      requestedAmount TEXT,
      tokenId TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      blockTime DATETIME,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'failed')),
      errorMessage TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_time DATETIME
    );

    CREATE TABLE IF NOT EXISTS distribution_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL DEFAULT '',
      collaboratorAddress TEXT NOT NULL,
      amountReceived TEXT NOT NULL,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS secondary_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      nftId TEXT NOT NULL,
      previousOwner TEXT NOT NULL,
      newOwner TEXT NOT NULL,
      salePrice TEXT NOT NULL,
      saleToken TEXT NOT NULL,
      royaltyAmount TEXT NOT NULL,
      royaltyRate INTEGER NOT NULL,
      distributed INTEGER NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      transactionHash TEXT
    );

    CREATE TABLE IF NOT EXISTS secondary_royalty_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL,
      totalRoyaltiesDistributed TEXT NOT NULL,
      numberOfSales INTEGER NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      action TEXT NOT NULL,
      user TEXT,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_contractId ON transactions(contractId);
    CREATE INDEX IF NOT EXISTS idx_transactions_txHash ON transactions(txHash);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_event_time ON transactions(COALESCE(blockTime, timestamp));
    CREATE INDEX IF NOT EXISTS idx_transactions_retry_eligible
      ON transactions(status, type, retry_count, last_retry_time);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_contractId ON secondary_sales(contractId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_nftId ON secondary_sales(nftId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_timestamp ON secondary_sales(timestamp);
    CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId ON secondary_royalty_distributions(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_contractId ON audit_log(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secondary_sales_dedup ON secondary_sales(contractId, nftId, previousOwner, newOwner, salePrice, saleToken);

    CREATE TABLE IF NOT EXISTS contract_event_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      originalTransactionId INTEGER NOT NULL,
      txHash TEXT,
      contractId TEXT NOT NULL,
      type TEXT NOT NULL,
      initiatorAddress TEXT NOT NULL,
      requestedAmount TEXT,
      tokenId TEXT,
      timestamp DATETIME,
      blockTime DATETIME,
      status TEXT NOT NULL,
      errorMessage TEXT,
      payoutCount INTEGER NOT NULL DEFAULT 0,
      payoutsJson TEXT NOT NULL DEFAULT '[]',
      archivedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(originalTransactionId)
    );

    CREATE TABLE IF NOT EXISTS event_archive_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      retentionDays INTEGER NOT NULL DEFAULT 90,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO event_archive_policy (id, enabled, retentionDays)
    VALUES (1, 1, 90);
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contractId ON contract_event_archive(contractId);
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_timestamp ON contract_event_archive(COALESCE(blockTime, timestamp));
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contract_time ON contract_event_archive(contractId, COALESCE(blockTime, timestamp));
  `);

  // Migration guards for existing databases
  try {
    db.exec(`ALTER TABLE secondary_sales ADD COLUMN distributed INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }

  try {
    db.exec(`ALTER TABLE distribution_payouts ADD COLUMN contractId TEXT NOT NULL DEFAULT ''`);
  } catch (_) {
    /* column already exists */
  }

  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }

  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN last_retry_time DATETIME`);
  } catch (_) {
    /* column already exists */
  }
}

/**
 * Get the current database schema migration version.
 */
export function getMigrationVersion() {
  const result = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get();
  return result?.version ?? 0;
}

export default db;
