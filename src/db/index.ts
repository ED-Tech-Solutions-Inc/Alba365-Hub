import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { initializeSchema } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function initDatabase(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  db = new Database(config.dbPath);

  // Initialize schema (all tables, indexes)
  initializeSchema(db);

  console.log(`[DB] SQLite database initialized at ${config.dbPath}`);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    // WAL checkpoint before closing
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    console.log("[DB] Database closed");
  }
}

// --- Helper: Run in transaction ---
export function transaction<T>(fn: (db: Database.Database) => T): T {
  const database = getDb();
  const txn = database.transaction(fn);
  return txn(database);
}

// --- Helper: Generate next receipt number ---
export function nextReceiptNumber(): string {
  const database = getDb();
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const stmt = database.prepare(`
    INSERT INTO order_sequence (date_key, current_value) VALUES (?, 1)
    ON CONFLICT(date_key) DO UPDATE SET current_value = current_value + 1
    RETURNING current_value
  `);

  const row = stmt.get(dateKey) as { current_value: number };
  const seq = String(row.current_value).padStart(4, "0");
  return `${dateKey}-${seq}`;
}

// --- Helper: Clamp LIMIT/OFFSET to safe bounds ---
export function clampLimit(value: string | undefined, fallback = 50, max = 500): number {
  const n = parseInt(value ?? String(fallback), 10);
  if (isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function clampOffset(value: string | undefined): number {
  const n = parseInt(value ?? "0", 10);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

// --- Helper: Generate unique ID ---
export function generateId(): string {
  // cuid2-like: timestamp + random
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${random}`;
}
