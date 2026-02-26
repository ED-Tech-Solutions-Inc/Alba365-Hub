import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, clampOffset } from "../db/index.js";
import { config } from "../config.js";

export function registerAuditLogRoutes(app: FastifyInstance) {
  // Log an audit event
  app.post("/api/audit-logs", async (req) => {
    const body = req.body as Record<string, unknown>;
    const db = getDb();
    const id = generateId();

    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, location_id, user_id, action, entity_type, entity_id, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      config.tenantId ?? "",
      config.locationId ?? "",
      body.userId ?? null,
      body.action ?? "",
      body.entityType ?? null,
      body.entityId ?? null,
      JSON.stringify(body.details ?? {}),
      body.ipAddress ?? null,
    );

    return { id, success: true };
  });

  // List audit logs
  app.get("/api/audit-logs", async (req) => {
    const db = getDb();
    const { action, userId, limit, offset } = req.query as Record<string, string>;

    let sql = "SELECT * FROM audit_logs WHERE location_id = ?";
    const params: unknown[] = [config.locationId ?? ""];

    if (action) {
      sql += " AND action = ?";
      params.push(action);
    }
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(clampLimit(limit), clampOffset(offset));

    return db.prepare(sql).all(...params);
  });
}
