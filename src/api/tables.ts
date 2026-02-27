import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

interface TableRow {
  id: string;
  tenant_id: string;
  floor_id: string | null;
  area_id: string | null;
  name: string;
  display_name: string | null;
  table_number: string | null;
  capacity: number;
  shape: string;
  x_position: number;
  y_position: number;
  width: number;
  height: number;
  rotation: number;
  status: string;
  current_session_id: string | null;
  sort_order: number;
  is_active: number;
  area_name?: string;
  floor_name?: string;
}

function mapTableRow(row: TableRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    name: row.name,
    displayName: row.display_name || row.name,
    tableNumber: row.table_number || row.name,
    capacity: row.capacity ?? 4,
    shape: row.shape ?? "SQUARE",
    positionX: row.x_position ?? 0,
    positionY: row.y_position ?? 0,
    width: row.width ?? 100,
    height: row.height ?? 100,
    rotation: row.rotation ?? 0,
    status: row.status ?? "AVAILABLE",
    currentSessionId: row.current_session_id,
    sortOrder: row.sort_order ?? 0,
    isActive: row.is_active === 1,
    areaName: row.area_name ?? null,
    floorName: row.floor_name ?? null,
  };
}

export function registerTableRoutes(app: FastifyInstance) {
  // Get floors with areas and tables
  app.get("/api/floors", async () => {
    const db = getDb();
    const floors = db.prepare("SELECT * FROM floors WHERE location_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.locationId ?? "") as Array<Record<string, unknown>>;

    const getAreas = db.prepare("SELECT * FROM areas WHERE floor_id = ? ORDER BY sort_order");
    const getTablesStmt = db.prepare("SELECT * FROM tables WHERE area_id = ? ORDER BY sort_order");

    return floors.map((floor) => {
      const areas = (getAreas.all(floor.id as string) as Array<Record<string, unknown>>).map((area) => ({
        id: area.id,
        tenantId: area.tenant_id,
        floorId: area.floor_id,
        name: area.name,
        sortOrder: area.sort_order,
        tables: (getTablesStmt.all(area.id as string) as TableRow[]).map(mapTableRow),
      }));
      return {
        id: floor.id,
        tenantId: floor.tenant_id,
        locationId: floor.location_id,
        name: floor.name,
        sortOrder: floor.sort_order,
        backgroundImage: floor.background_image,
        isActive: floor.is_active === 1,
        areas,
      };
    });
  });

  // Get all tables (flat list)
  app.get("/api/tables", async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT t.*, a.name as area_name, f.name as floor_name
      FROM tables t
      LEFT JOIN areas a ON a.id = t.area_id
      LEFT JOIN floors f ON f.id = t.floor_id OR f.id = a.floor_id
      WHERE (f.location_id = ? OR t.tenant_id = ?) AND t.is_active = 1
      ORDER BY COALESCE(f.sort_order, 0), COALESCE(a.sort_order, 0), t.sort_order
    `).all(config.locationId ?? "", config.tenantId ?? "") as TableRow[];

    return rows.map(mapTableRow);
  });

  // Open table session
  app.post("/api/table-sessions", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO table_sessions (id, tenant_id, location_id, table_id, server_id, server_name, guest_count, status, notes, opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'))
      `).run(
        id,
        config.tenantId ?? "",
        config.locationId ?? "",
        body.tableId,
        body.serverId ?? null,
        body.serverName ?? null,
        body.guestCount ?? 1,
        body.notes ?? null,
      );

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
      txDb.prepare("UPDATE table_sessions SET status = 'CLOSED', closed_at = datetime('now') WHERE id = ?").run(id);
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
