import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerShiftRoutes(app: FastifyInstance) {
  // Clock in
  app.post("/api/shifts/clock-in", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO shift_logs (id, location_id, user_id, user_name, terminal_id, clock_in, status, created_at, sync_status)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 'ACTIVE', datetime('now'), 'PENDING')
      `).run(id, config.locationId ?? "", body.userId, body.userName, body.terminalId ?? null);

      // Queue for sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('shift_log', ?, 'create', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { id, status: "ACTIVE", clockIn: new Date().toISOString() };
  });

  // Clock out
  app.post("/api/shifts/:id/clock-out", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const shift = db.prepare("SELECT status FROM shift_logs WHERE id = ?").get(id) as { status: string } | undefined;
    if (!shift) {
      reply.status(404);
      return { error: "Shift not found" };
    }
    if (shift.status !== "ACTIVE" && shift.status !== "ON_BREAK") {
      reply.status(400);
      return { error: "Shift not active" };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE shift_logs SET clock_out = datetime('now'), status = 'COMPLETED',
          tips = ?, cash_tips = ?, sync_status = 'PENDING'
        WHERE id = ?
      `).run(body.tips ?? 0, body.cashTips ?? 0, id);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('shift_log', ?, 'clock_out', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { success: true, clockOut: new Date().toISOString() };
  });

  // Start break
  app.post("/api/shifts/:id/start-break", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const breakId = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO shift_breaks (id, shift_log_id, type, start_time)
        VALUES (?, ?, ?, datetime('now'))
      `).run(breakId, id, body.type ?? "UNPAID");

      db.prepare("UPDATE shift_logs SET status = 'ON_BREAK' WHERE id = ?").run(id);

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('shift_break', ?, 'create', ?, 5, datetime('now'))
      `).run(breakId, JSON.stringify({ id: breakId, shiftLogId: id, type: body.type ?? "UNPAID" }));
    });

    return { breakId, status: "ON_BREAK" };
  });

  // End break
  app.post("/api/shifts/:id/end-break", async (req) => {
    const { id } = req.params as { id: string };

    transaction((db) => {
      db.prepare(`
        UPDATE shift_breaks SET end_time = datetime('now')
        WHERE shift_log_id = ? AND end_time IS NULL
      `).run(id);

      db.prepare("UPDATE shift_logs SET status = 'ACTIVE' WHERE id = ?").run(id);

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('shift_break', ?, 'end_break', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ shiftLogId: id }));
    });

    return { success: true, status: "ACTIVE" };
  });

  // Get active shifts for this location
  app.get("/api/shifts/active", async () => {
    const db = getDb();
    return db.prepare(`
      SELECT s.*, (SELECT json_group_array(json_object('id', b.id, 'type', b.type, 'startTime', b.start_time, 'endTime', b.end_time))
        FROM shift_breaks b WHERE b.shift_log_id = s.id) as breaks
      FROM shift_logs s WHERE s.location_id = ? AND s.status IN ('ACTIVE', 'ON_BREAK')
      ORDER BY s.clock_in DESC
    `).all(config.locationId ?? "");
  });

  // Shift history for a user
  app.get("/api/shifts/history/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const { limit } = req.query as Record<string, string>;
    const db = getDb();
    return db.prepare(`
      SELECT s.*, (SELECT json_group_array(json_object('id', b.id, 'type', b.type, 'startTime', b.start_time, 'endTime', b.end_time))
        FROM shift_breaks b WHERE b.shift_log_id = s.id) as breaks
      FROM shift_logs s WHERE s.user_id = ? AND s.location_id = ?
      ORDER BY s.clock_in DESC LIMIT ?
    `).all(userId, config.locationId ?? "", clampLimit(limit, 5, 100));
  });

  // Get shift by user
  app.get("/api/shifts/user/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();
    return db.prepare(`
      SELECT * FROM shift_logs WHERE user_id = ? AND location_id = ? AND status IN ('ACTIVE', 'ON_BREAK')
      ORDER BY clock_in DESC LIMIT 1
    `).get(userId, config.locationId ?? "");
  });
}
