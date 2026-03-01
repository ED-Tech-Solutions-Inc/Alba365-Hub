import type { FastifyInstance } from "fastify";
import { getDb, clampLimit } from "../db/index.js";
import { PullSyncEngine } from "../sync/pull-sync.js";
import { PushSyncEngine } from "../sync/push-sync.js";

let pullEngine: PullSyncEngine | null = null;
let pushEngine: PushSyncEngine | null = null;

export function startSyncEngines() {
  pullEngine = new PullSyncEngine();
  pushEngine = new PushSyncEngine();

  pullEngine.start(60_000); // Pull every 60s
  pushEngine.start(5_000);  // Push every 5s

  return { pullEngine, pushEngine };
}

export function stopSyncEngines() {
  pullEngine?.stop();
  pushEngine?.stop();
}

export function registerSyncRoutes(app: FastifyInstance) {
  // Trigger manual pull sync
  app.post("/api/sync/pull", async () => {
    if (!pullEngine) return { error: "Pull sync not initialized" };
    const results = await pullEngine.runFullSync();
    return { results };
  });

  // Trigger manual push sync
  app.post("/api/sync/push", async () => {
    if (!pushEngine) return { error: "Push sync not initialized" };
    const results = await pushEngine.processOutbox();
    return { results };
  });

  // Get sync status
  app.get("/api/sync/status", async () => {
    const db = getDb();

    const syncStates = db.prepare("SELECT * FROM sync_state ORDER BY entity_type").all();
    const outboxStats = pushEngine?.getStats() ?? {};
    const pendingCount = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'PENDING'")
      .get() as { count: number };
    const deadLetterCount = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'DEAD_LETTER'")
      .get() as { count: number };

    return {
      pullSync: {
        entities: syncStates,
      },
      pushSync: {
        outboxStats,
        pendingCount: pendingCount.count,
        deadLetterCount: deadLetterCount.count,
      },
    };
  });

  // Get outbox items (for debugging)
  app.get("/api/sync/outbox", async (req) => {
    const db = getDb();
    const { status = "PENDING", limit } = req.query as Record<string, string>;

    return db.prepare("SELECT * FROM outbox_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(status, clampLimit(limit));
  });

  // Retry dead-lettered items
  app.post("/api/sync/retry-dead-letters", async (req) => {
    if (!pushEngine) return { error: "Push sync not initialized" };
    const { entityType } = (req.body ?? {}) as { entityType?: string };
    const count = pushEngine.retryDeadLetters(entityType);
    return { retriedCount: count };
  });

  // Reset sync cursors for specific entities (forces full re-fetch)
  app.post("/api/sync/reset", async (req) => {
    const db = getDb();
    const { entities } = (req.query ?? {}) as { entities?: string };

    if (entities) {
      const entityList = entities.split(",").map((e) => e.trim());
      const stmt = db.prepare("DELETE FROM sync_state WHERE entity_type = ?");
      let cleared = 0;
      for (const entity of entityList) {
        const result = stmt.run(entity);
        cleared += result.changes;
      }
      return { cleared, entities: entityList };
    }

    // Reset all
    const result = db.prepare("DELETE FROM sync_state").run();
    return { cleared: result.changes, entities: "all" };
  });
}
