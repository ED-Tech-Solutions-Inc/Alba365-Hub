import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { getConnectedClients } from "../realtime/websocket.js";

export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "pos-hub-v2",
      timestamp: new Date().toISOString(),
      locationId: config.locationId ?? null,
      version: "0.1.0",
    };
  });

  app.get("/health/detailed", async () => {
    const db = getDb();
    const productCount = (db.prepare("SELECT COUNT(*) as count FROM products").get() as { count: number } | undefined)?.count ?? 0;
    const saleCount = (db.prepare("SELECT COUNT(*) as count FROM sales").get() as { count: number } | undefined)?.count ?? 0;
    const pendingOutbox = (db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'PENDING'").get() as { count: number } | undefined)?.count ?? 0;

    return {
      status: "ok",
      uptime: process.uptime(),
      database: {
        products: productCount,
        sales: saleCount,
        pendingSync: pendingOutbox,
      },
      config: {
        locationId: config.locationId,
        tenantId: config.tenantId,
        cloudConfigured: !!config.cloudApiUrl,
        syncPullInterval: config.syncPullInterval,
        syncPushInterval: config.syncPushInterval,
      },
    };
  });

  app.get("/ready", async (_req, reply) => {
    try {
      getDb();
      return { ready: true };
    } catch {
      reply.status(503);
      return { ready: false };
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/hub/diagnostics", async () => {
    const db = getDb();

    // Database health
    let dbStatus: "ok" | "error" = "ok";
    let dbLatencyMs: number | undefined;
    let dbSizeBytes: number | undefined;

    try {
      const start = performance.now();
      db.prepare("SELECT 1").get();
      dbLatencyMs = Math.round(performance.now() - start);
    } catch {
      dbStatus = "error";
    }

    try {
      const sizeRow = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number } | undefined;
      dbSizeBytes = sizeRow?.size;
    } catch { /* ignore */ }

    // Connected terminals — prefer live WebSocket data, enrich with DB info
    const wsClients = getConnectedClients();
    const terminalList: Array<{ clientId: string; terminalId: string; terminalName?: string; ipAddress?: string; connectedAt: string }> = [];

    // Build a map of DB terminal info for enrichment
    const terminalInfoMap = new Map<string, { name: string; ip_address: string | null }>();
    try {
      const rows = db.prepare("SELECT id, name, ip_address FROM terminals WHERE status = 'ONLINE'").all() as Array<{
        id: string; name: string; ip_address: string | null;
      }>;
      for (const row of rows) {
        terminalInfoMap.set(row.id, { name: row.name, ip_address: row.ip_address });
      }
    } catch { /* terminals table may not exist */ }

    for (const ws of wsClients) {
      const dbInfo = ws.terminalId ? terminalInfoMap.get(ws.terminalId) : undefined;
      terminalList.push({
        clientId: ws.id,
        terminalId: ws.terminalId ?? ws.id,
        terminalName: dbInfo?.name,
        ipAddress: dbInfo?.ip_address ?? undefined,
        connectedAt: ws.connectedAt,
      });
    }

    const terminalCount = terminalList.length;

    // Push sync status
    let pushSync = null;
    try {
      const pendingRow = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'PENDING'").get() as { count: number } | undefined;
      const failedRow = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'FAILED'").get() as { count: number } | undefined;
      const processingRow = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'PROCESSING'").get() as { count: number } | undefined;
      const deadRow = db.prepare("SELECT COUNT(*) as count FROM outbox_queue WHERE status = 'DEAD_LETTER'").get() as { count: number } | undefined;

      // Get last push timestamp and last error
      const lastSyncedRow = db.prepare("SELECT processed_at FROM outbox_queue WHERE status = 'SYNCED' ORDER BY processed_at DESC LIMIT 1").get() as { processed_at: string | null } | undefined;
      const lastErrorRow = db.prepare("SELECT last_error FROM outbox_queue WHERE status IN ('FAILED', 'DEAD_LETTER') AND last_error IS NOT NULL ORDER BY processed_at DESC LIMIT 1").get() as { last_error: string | null } | undefined;

      pushSync = {
        isProcessing: (processingRow?.count ?? 0) > 0,
        pendingCount: pendingRow?.count ?? 0,
        processingCount: processingRow?.count ?? 0,
        failedCount: failedRow?.count ?? 0,
        deadLetterCount: deadRow?.count ?? 0,
        lastPushAt: lastSyncedRow?.processed_at ? lastSyncedRow.processed_at.replace(" ", "T") + "Z" : null,
        lastError: lastErrorRow?.last_error ?? null,
        conflictCount: 0,
      };
    } catch { /* outbox_queue may not exist */ }

    // Pull sync status
    let pullSync = null;
    let pullSyncSummary = null;
    try {
      const syncRows = db.prepare("SELECT entity_type, last_synced_at, record_count, status FROM sync_state").all() as Array<{
        entity_type: string; last_synced_at: string | null; record_count: number; status: string | null;
      }>;
      if (syncRows.length > 0) {
        pullSync = syncRows.map(s => ({
          entityType: s.entity_type,
          lastSyncAt: s.last_synced_at ? s.last_synced_at.replace(" ", "T") + "Z" : null,
          itemCount: s.record_count ?? 0,
          status: (s.status === "SYNCING" ? "syncing" : s.status === "ERROR" ? "error" : "idle") as "idle" | "syncing" | "error",
        }));

        // Try to get item counts per entity
        for (const entry of pullSync) {
          try {
            const tableName = entry.entityType.replace(/-/g, "_");
            const countRow = db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number } | undefined;
            entry.itemCount = countRow?.count ?? 0;
          } catch { /* table may not exist */ }
        }

        const totalEntities = pullSync.length;
        const syncedEntities = pullSync.filter(s => s.lastSyncAt !== null).length;
        const totalRecords = pullSync.reduce((sum, s) => sum + s.itemCount, 0);

        const syncTimes = pullSync
          .map(s => s.lastSyncAt)
          .filter((t): t is string => t !== null)
          .sort();
        const syncingCount = pullSync.filter(s => s.status === "syncing").length;
        const errorCount = pullSync.filter(s => s.status === "error").length;

        pullSyncSummary = {
          totalEntities,
          syncedEntities,
          totalRecords,
          syncingCount,
          errorCount,
          progressPercent: totalEntities > 0 ? Math.round((syncedEntities / totalEntities) * 100) : 0,
          oldestSyncAt: syncTimes.length > 0 ? syncTimes[0] : null,
          newestSyncAt: syncTimes.length > 0 ? syncTimes[syncTimes.length - 1] : null,
        };
      }
    } catch { /* sync_state may not exist */ }

    // Overall status
    let overallStatus: "healthy" | "degraded" | "error" = "healthy";
    if (dbStatus === "error") {
      overallStatus = "error";
    } else if (pushSync && (pushSync.failedCount > 0 || pushSync.deadLetterCount > 0)) {
      overallStatus = "degraded";
    } else if (!config.cloudApiUrl) {
      overallStatus = "degraded";
    }

    // Return same shape as v1 hub diagnostics
    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      hub: {
        isPrimary: config.isPrimary,
        epoch: config.hubEpoch,
        locationId: config.locationId ?? null,
        tenantId: config.tenantId ?? null,
        cloudConfigured: !!config.cloudApiUrl && !!config.cloudApiKey,
        cloudUrl: config.cloudApiUrl ?? null,
        replicationEnabled: config.replicationEnabled,
        primaryHubUrl: config.primaryHubUrl ?? null,
      },
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        sizeBytes: dbSizeBytes,
      },
      connectedTerminals: {
        count: terminalCount,
        terminals: terminalList,
      },
      sync: {
        pull: pullSync,
        pullSummary: pullSyncSummary,
        push: pushSync,
      },
      replication: null,
    };
  });
}
