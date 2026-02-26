import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

const startTime = Date.now();

export function registerDiagnosticsRoutes(app: FastifyInstance) {
  // Full diagnostics endpoint
  app.get("/api/diagnostics", async () => {
    const db = getDb();

    // Table row counts
    const tables = [
      "products", "categories", "sales", "sale_items", "payments",
      "kitchen_orders", "kitchen_order_items", "customers",
      "cash_drawers", "cash_drawer_transactions", "shifts",
      "terminals", "outbox_queue", "dead_letter_queue",
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        counts[table] = row.c;
      } catch {
        counts[table] = -1; // Table doesn't exist
      }
    }

    // Outbox depth (pending items)
    let outboxPending = 0;
    let outboxOldest: string | null = null;
    try {
      const outbox = db.prepare(
        "SELECT COUNT(*) as c, MIN(created_at) as oldest FROM outbox_queue WHERE status = 'PENDING'"
      ).get() as { c: number; oldest: string | null };
      outboxPending = outbox.c;
      outboxOldest = outbox.oldest;
    } catch { /* ignore */ }

    // Dead letters
    let deadLetterCount = 0;
    try {
      const dl = db.prepare("SELECT COUNT(*) as c FROM dead_letter_queue").get() as { c: number };
      deadLetterCount = dl.c;
    } catch { /* ignore */ }

    // DB file size (approximate via page_count * page_size)
    let dbSizeBytes = 0;
    try {
      const pageCount = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
      dbSizeBytes = pageCount.page_count * pageSize.page_size;
    } catch { /* ignore */ }

    return {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      tenantId: config.tenantId,
      locationId: config.locationId,
      dbSizeBytes,
      dbSizeMB: Math.round(dbSizeBytes / 1024 / 1024 * 100) / 100,
      tableCounts: counts,
      outbox: {
        pending: outboxPending,
        oldest: outboxOldest,
      },
      deadLetters: deadLetterCount,
      timestamp: new Date().toISOString(),
    };
  });

  // Quick health with sync status
  app.get("/api/diagnostics/sync", async () => {
    const db = getDb();

    let pendingSync = 0;
    let lastSyncAt: string | null = null;
    try {
      const outbox = db.prepare(
        "SELECT COUNT(*) as c FROM outbox_queue WHERE status = 'PENDING'"
      ).get() as { c: number };
      pendingSync = outbox.c;
    } catch { /* ignore */ }

    try {
      const last = db.prepare(
        "SELECT MAX(synced_at) as last_sync FROM outbox_queue WHERE status = 'SYNCED'"
      ).get() as { last_sync: string | null };
      lastSyncAt = last.last_sync;
    } catch { /* ignore */ }

    return {
      pendingSync,
      lastSyncAt,
      syncLagSeconds: lastSyncAt
        ? Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000)
        : null,
    };
  });
}
