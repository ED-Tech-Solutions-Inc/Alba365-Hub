import { getDb } from "../db/index.js";
import { getCloudClient } from "./cloud-client.js";

interface OutboxItem {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: string;
  correlation_id: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  status: string;
  created_at: string;
}

interface PushResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

/**
 * Push sync engine — sends locally created data (sales, kitchen orders, etc.)
 * from the SQLite outbox queue to the cloud API.
 */
export class PushSyncEngine {
  private cloudClient = getCloudClient();
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  // Entity type → cloud API path mapping
  private readonly pushEndpoints: Record<string, string> = {
    sale: "/api/hub/push/sale",
    kitchen_order: "/api/hub/push/kitchen-order",
    cash_drawer: "/api/hub/push/cash-drawer",
    shift_log: "/api/hub/push/shift",
    gift_card: "/api/hub/push/gift-card",
    refund: "/api/hub/push/refund",
    store_credit: "/api/hub/push/store-credit",
  };

  /**
   * Start periodic push sync
   */
  start(intervalMs = 5_000) {
    if (this.intervalId) return;

    console.log(`[PushSync] Starting periodic push every ${intervalMs / 1000}s`);

    this.intervalId = setInterval(() => {
      this.processOutbox().catch((err) => console.error("[PushSync] Error:", err));
    }, intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[PushSync] Stopped");
    }
  }

  /**
   * Process pending outbox items
   */
  async processOutbox(batchSize = 20): Promise<PushResult> {
    if (this.running) return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    if (!this.cloudClient.isConfigured()) return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };

    this.running = true;
    const result: PushResult = { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };

    try {
      const db = getDb();

      // Get pending items ordered by priority (higher first) then created_at
      const items = db.prepare(`
        SELECT * FROM outbox_queue
        WHERE status = 'PENDING' AND attempts < max_attempts
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
      `).all(batchSize) as OutboxItem[];

      if (items.length === 0) return result;

      for (const item of items) {
        result.processed++;

        try {
          // Mark as processing
          db.prepare("UPDATE outbox_queue SET status = 'PROCESSING', attempts = attempts + 1 WHERE id = ?")
            .run(item.id);

          const endpoint = this.pushEndpoints[item.entity_type];
          if (!endpoint) {
            console.warn(`[PushSync] No endpoint for entity_type: ${item.entity_type}`);
            db.prepare("UPDATE outbox_queue SET status = 'DEAD_LETTER', error = 'Unknown entity type' WHERE id = ?")
              .run(item.id);
            result.deadLettered++;
            continue;
          }

          // Parse payload
          let payload: unknown;
          try {
            payload = JSON.parse(item.payload);
          } catch {
            db.prepare("UPDATE outbox_queue SET status = 'DEAD_LETTER', error = 'Invalid JSON payload' WHERE id = ?")
              .run(item.id);
            result.deadLettered++;
            continue;
          }

          // Push to cloud
          const res = await this.cloudClient.post(endpoint, {
            entityType: item.entity_type,
            entityId: item.entity_id,
            action: item.action,
            payload,
            correlationId: item.correlation_id,
          });

          if (res.ok) {
            // Success — remove from outbox
            db.prepare("UPDATE outbox_queue SET status = 'SYNCED', synced_at = datetime('now') WHERE id = ?")
              .run(item.id);
            result.succeeded++;
          } else if (res.status === 409) {
            // Conflict (duplicate) — mark as synced (idempotent)
            db.prepare("UPDATE outbox_queue SET status = 'SYNCED', synced_at = datetime('now'), error = 'Duplicate (409)' WHERE id = ?")
              .run(item.id);
            result.succeeded++;
          } else if (res.status >= 400 && res.status < 500) {
            // Client error — dead letter (won't succeed on retry)
            db.prepare("UPDATE outbox_queue SET status = 'DEAD_LETTER', error = ? WHERE id = ?")
              .run(`HTTP ${res.status}: ${res.error ?? "Client error"}`, item.id);
            result.deadLettered++;
          } else {
            // Server error or network — back to pending for retry
            const newAttempts = item.attempts + 1;
            if (newAttempts >= item.max_attempts) {
              db.prepare("UPDATE outbox_queue SET status = 'DEAD_LETTER', error = ? WHERE id = ?")
                .run(`Max attempts reached. Last: HTTP ${res.status}`, item.id);
              result.deadLettered++;
            } else {
              db.prepare("UPDATE outbox_queue SET status = 'PENDING', error = ? WHERE id = ?")
                .run(`HTTP ${res.status}: ${res.error ?? "Server error"}`, item.id);
              result.failed++;
            }
          }
        } catch (err) {
          // Network error — back to pending
          const msg = err instanceof Error ? err.message : "Unknown error";
          db.prepare("UPDATE outbox_queue SET status = 'PENDING', error = ? WHERE id = ?")
            .run(msg, item.id);
          result.failed++;
        }
      }

      if (result.processed > 0) {
        console.log(`[PushSync] Processed ${result.processed}: ${result.succeeded} synced, ${result.failed} retry, ${result.deadLettered} dead`);
      }
    } finally {
      this.running = false;
    }

    return result;
  }

  /**
   * Get outbox stats
   */
  getStats() {
    const db = getDb();
    const stats = db.prepare(`
      SELECT status, COUNT(*) as count FROM outbox_queue GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    return stats.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Retry dead-lettered items
   */
  retryDeadLetters(entityType?: string) {
    const db = getDb();
    if (entityType) {
      return db.prepare("UPDATE outbox_queue SET status = 'PENDING', attempts = 0 WHERE status = 'DEAD_LETTER' AND entity_type = ?")
        .run(entityType).changes;
    }
    return db.prepare("UPDATE outbox_queue SET status = 'PENDING', attempts = 0 WHERE status = 'DEAD_LETTER'")
      .run().changes;
  }
}
