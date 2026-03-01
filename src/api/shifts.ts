import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";

/** SQLite datetime('now') returns UTC without suffix — append 'Z' so clients parse correctly */
function utc(dt: unknown): string | null {
  if (!dt || typeof dt !== "string") return null;
  return dt.endsWith("Z") ? dt : dt + "Z";
}

export function registerShiftRoutes(app: FastifyInstance) {
  // Clock in
  app.post("/api/shifts/clock-in", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO shift_logs (id, tenant_id, location_id, user_id, terminal_id, clock_in_at, status, sync_status)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 'ACTIVE', 'PENDING')
      `).run(id, config.tenantId ?? "", config.locationId ?? "", body.userId, body.terminalId ?? null);

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
      // End any open breaks and calculate total break minutes
      txDb.prepare(`
        UPDATE shift_breaks SET ended_at = datetime('now')
        WHERE shift_log_id = ? AND ended_at IS NULL
      `).run(id);

      const breakRow = txDb.prepare(`
        SELECT COALESCE(SUM(
          CAST((julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 1440 AS INTEGER)
        ), 0) as total_break_minutes
        FROM shift_breaks WHERE shift_log_id = ?
      `).get(id) as { total_break_minutes: number } | undefined;

      txDb.prepare(`
        UPDATE shift_logs SET clock_out_at = datetime('now'), status = 'COMPLETED',
          break_minutes = ?, sync_status = 'PENDING'
        WHERE id = ?
      `).run(breakRow?.total_break_minutes ?? 0, id);

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
        INSERT INTO shift_breaks (id, shift_log_id, type, started_at)
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
        UPDATE shift_breaks SET ended_at = datetime('now')
        WHERE shift_log_id = ? AND ended_at IS NULL
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
    const rows = db.prepare(`
      SELECT s.id, s.user_id, s.terminal_id, s.clock_in_at, s.status, s.break_minutes,
        (SELECT u.name FROM users u WHERE u.id = s.user_id) as user_name,
        (SELECT json_group_array(json_object('id', b.id, 'type', b.type, 'startTime', b.started_at, 'endTime', b.ended_at))
          FROM shift_breaks b WHERE b.shift_log_id = s.id) as breaks
      FROM shift_logs s WHERE s.location_id = ? AND s.status IN ('ACTIVE', 'ON_BREAK')
      ORDER BY s.clock_in_at DESC
    `).all(config.locationId ?? "") as Record<string, unknown>[];

    // Map to camelCase for Flutter client, include active break details
    return rows.map((r) => {
      const shift: Record<string, unknown> = {
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        terminalId: r.terminal_id,
        clockIn: utc(r.clock_in_at),
        status: r.status,
        breakMinutes: r.break_minutes,
        onBreak: r.status === "ON_BREAK",
        breaks: r.breaks,
      };

      if (r.status === "ON_BREAK") {
        const activeBreak = db.prepare(`
          SELECT id, type, started_at FROM shift_breaks
          WHERE shift_log_id = ? AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1
        `).get(r.id) as Record<string, unknown> | undefined;

        if (activeBreak) {
          shift.currentBreakStart = utc(activeBreak.started_at);
          shift.currentBreakType = activeBreak.type;
          shift.currentBreakMaxMinutes = activeBreak.type === "LUNCH" ? 30 : 15;
        }
      }

      return shift;
    });
  });

  // Shift history for a user
  app.get("/api/shifts/history/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const { limit } = req.query as Record<string, string>;
    const db = getDb();
    const rows = db.prepare(`
      SELECT s.id, s.user_id, s.terminal_id, s.clock_in_at, s.clock_out_at, s.status, s.break_minutes,
        (SELECT json_group_array(json_object('id', b.id, 'type', b.type, 'startTime', b.started_at, 'endTime', b.ended_at))
          FROM shift_breaks b WHERE b.shift_log_id = s.id) as breaks
      FROM shift_logs s WHERE s.user_id = ? AND s.location_id = ?
      ORDER BY s.clock_in_at DESC LIMIT ?
    `).all(userId, config.locationId ?? "", clampLimit(limit, 5, 100)) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      terminalId: r.terminal_id,
      clockIn: utc(r.clock_in_at),
      clockOut: utc(r.clock_out_at),
      status: r.status,
      breakMinutes: r.break_minutes,
      breaks: r.breaks,
    }));
  });

  // Get shift by user
  app.get("/api/shifts/user/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();
    const row = db.prepare(`
      SELECT id, user_id, terminal_id, clock_in_at, clock_out_at, status, break_minutes
      FROM shift_logs WHERE user_id = ? AND location_id = ? AND status IN ('ACTIVE', 'ON_BREAK')
      ORDER BY clock_in_at DESC LIMIT 1
    `).get(userId, config.locationId ?? "") as Record<string, unknown> | undefined;

    if (!row) return null;

    // Calculate break minutes dynamically from shift_breaks (stored column only updated on clock-out)
    const breakRow = db.prepare(`
      SELECT COALESCE(SUM(
        CAST((julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 1440 AS INTEGER)
      ), 0) as total_break_minutes
      FROM shift_breaks WHERE shift_log_id = ?
    `).get(row.id) as { total_break_minutes: number } | undefined;
    const dynamicBreakMinutes = breakRow?.total_break_minutes ?? 0;

    // Count breaks/lunches taken for remaining tallies
    const breakCounts = db.prepare(`
      SELECT type, COUNT(*) as cnt FROM shift_breaks
      WHERE shift_log_id = ? GROUP BY type
    `).all(row.id) as Array<{ type: string; cnt: number }>;

    let breaksTaken = 0;
    let lunchesTaken = 0;
    for (const bc of breakCounts) {
      if (bc.type === "LUNCH") lunchesTaken = bc.cnt;
      else breaksTaken = bc.cnt;
    }

    const result: Record<string, unknown> = {
      id: row.id,
      userId: row.user_id,
      terminalId: row.terminal_id,
      clockIn: utc(row.clock_in_at),
      clockOut: utc(row.clock_out_at),
      status: row.status,
      breakMinutes: dynamicBreakMinutes,
      onBreak: row.status === "ON_BREAK",
      breaksRemaining: Math.max(0, 2 - breaksTaken),
      lunchesRemaining: Math.max(0, 1 - lunchesTaken),
    };

    // If on break, include current break details for the timer
    if (row.status === "ON_BREAK") {
      const activeBreak = db.prepare(`
        SELECT id, type, started_at FROM shift_breaks
        WHERE shift_log_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      `).get(row.id) as Record<string, unknown> | undefined;

      if (activeBreak) {
        result.currentBreakStart = utc(activeBreak.started_at);
        result.currentBreakType = activeBreak.type;
        result.currentBreakMaxMinutes = activeBreak.type === "LUNCH" ? 30 : 15;
      }
    }

    return result;
  });
}
