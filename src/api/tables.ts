import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerTableRoutes(app: FastifyInstance) {
  // Get floors with areas and tables
  app.get("/api/floors", async () => {
    const db = getDb();
    const floors = db.prepare("SELECT * FROM floors WHERE location_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.locationId ?? "");

    const getAreas = db.prepare("SELECT * FROM areas WHERE floor_id = ? ORDER BY sort_order");
    const getTables = db.prepare("SELECT * FROM tables WHERE area_id = ? ORDER BY sort_order");

    return (floors as Array<Record<string, unknown>>).map((floor) => {
      const areas = (getAreas.all(floor.id as string) as Array<Record<string, unknown>>).map((area) => ({
        ...area,
        tables: getTables.all(area.id as string),
      }));
      return { ...floor, areas };
    });
  });

  // Get all tables (flat list)
  app.get("/api/tables", async () => {
    const db = getDb();
    return db.prepare(`
      SELECT t.*, a.name as area_name, f.name as floor_name
      FROM tables t
      JOIN areas a ON a.id = t.area_id
      JOIN floors f ON f.id = a.floor_id
      WHERE f.location_id = ? AND t.is_active = 1
      ORDER BY f.sort_order, a.sort_order, t.sort_order
    `).all(config.locationId ?? "");
  });

  // Open table session
  app.post("/api/table-sessions", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO table_sessions (id, table_id, server_id, server_name, guest_count, status, started_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', datetime('now'))
      `).run(id, body.tableId, body.serverId ?? null, body.serverName ?? null, body.guestCount ?? 1);

      // Update table status
      db.prepare("UPDATE tables SET status = 'OCCUPIED', current_session_id = ? WHERE id = ?")
        .run(id, body.tableId);

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('table_session', ?, 'create', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { id, status: "ACTIVE" };
  });

  // Get active table session
  app.get("/api/table-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const session = db.prepare("SELECT * FROM table_sessions WHERE id = ?").get(id);
    if (!session) {
      reply.status(404);
      return { error: "Table session not found" };
    }

    const checks = db.prepare("SELECT * FROM guest_checks WHERE table_session_id = ?").all(id);
    return { ...(session as Record<string, unknown>), guestChecks: checks };
  });

  // Close table session
  app.post("/api/table-sessions/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const session = db.prepare("SELECT table_id FROM table_sessions WHERE id = ?").get(id) as { table_id: string } | undefined;
    if (!session) {
      reply.status(404);
      return { error: "Session not found" };
    }

    transaction((txDb) => {
      txDb.prepare("UPDATE table_sessions SET status = 'CLOSED', ended_at = datetime('now') WHERE id = ?").run(id);
      txDb.prepare("UPDATE tables SET status = 'AVAILABLE', current_session_id = NULL WHERE id = ?").run(session.table_id);

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('table_session', ?, 'close', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, tableId: session.table_id }));
    });

    return { success: true };
  });

  // Get courses
  app.get("/api/courses", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM courses WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.tenantId ?? "");
  });
}
