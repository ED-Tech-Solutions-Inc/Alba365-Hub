import type { FastifyInstance } from "fastify";
import { getDb, generateId } from "../db/index.js";
import { config } from "../config.js";

interface WaitingQueueRow {
  id: string;
  tenant_id: string;
  location_id: string;
  customer_name: string;
  phone: string | null;
  party_size: number;
  status: string;
  notes: string | null;
  quoted_wait_minutes: number | null;
  table_id: string | null;
  session_id: string | null;
  created_at: number;
  seated_at: number | null;
  cancelled_at: number | null;
}

function mapRow(row: WaitingQueueRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    locationId: row.location_id,
    customerName: row.customer_name,
    phone: row.phone,
    partySize: row.party_size,
    status: row.status,
    notes: row.notes,
    quotedWaitMinutes: row.quoted_wait_minutes,
    tableId: row.table_id,
    sessionId: row.session_id,
    addedAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : null,
    seatedAt: row.seated_at ? new Date(row.seated_at * 1000).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at * 1000).toISOString() : null,
  };
}

export function registerWaitingQueueRoutes(app: FastifyInstance) {
  // Get active waiting queue
  app.get("/api/waiting-queue", async () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM waiting_queue
         WHERE location_id = ? AND status IN ('WAITING', 'NOTIFIED', 'READY')
         ORDER BY created_at ASC`
      )
      .all(config.locationId ?? "") as WaitingQueueRow[];

    return rows.map(mapRow);
  });

  // Add to waitlist
  app.post<{
    Body: {
      customerName: string;
      phone?: string;
      partySize?: number;
      notes?: string;
      quotedWaitMinutes?: number;
    };
  }>("/api/waiting-queue", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const customerName = body.customerName as string | undefined;
    if (!customerName) {
      return reply.status(400).send({ error: "customerName is required" });
    }

    const db = getDb();
    const id = generateId();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO waiting_queue (id, tenant_id, location_id, customer_name, phone, party_size, status, notes, quoted_wait_minutes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?)`
    ).run(
      id,
      config.tenantId ?? "",
      config.locationId ?? "",
      customerName,
      (body.phone as string) || null,
      (body.partySize as number) || 1,
      (body.notes as string) || null,
      (body.quotedWaitMinutes as number) || null,
      now
    );

    const row = db.prepare("SELECT * FROM waiting_queue WHERE id = ?").get(id) as WaitingQueueRow;
    return mapRow(row);
  });

  // Update waitlist entry (seat or cancel)
  app.patch<{
    Params: { id: string };
    Body: { status?: string; tableId?: string };
  }>("/api/waiting-queue/:id", async (request, reply) => {
    const { id } = request.params;
    const body = (request.body || {}) as Record<string, unknown>;
    const db = getDb();

    const row = db.prepare("SELECT * FROM waiting_queue WHERE id = ?").get(id) as WaitingQueueRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: "Waitlist entry not found" });
    }

    const now = Math.floor(Date.now() / 1000);
    const status = body.status as string | undefined;

    if (status === "SEATED" && body.tableId) {
      db.prepare("UPDATE waiting_queue SET status = ?, table_id = ?, seated_at = ? WHERE id = ?").run(
        "SEATED",
        body.tableId as string,
        now,
        id
      );
    } else if (status === "CANCELLED") {
      db.prepare("UPDATE waiting_queue SET status = ?, cancelled_at = ? WHERE id = ?").run("CANCELLED", now, id);
    } else if (status) {
      db.prepare("UPDATE waiting_queue SET status = ? WHERE id = ?").run(status, id);
    }

    const updated = db.prepare("SELECT * FROM waiting_queue WHERE id = ?").get(id) as WaitingQueueRow;
    return mapRow(updated);
  });

  // Delete waitlist entry
  app.delete<{ Params: { id: string } }>("/api/waiting-queue/:id", async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const row = db.prepare("SELECT * FROM waiting_queue WHERE id = ?").get(id) as WaitingQueueRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: "Waitlist entry not found" });
    }

    db.prepare("DELETE FROM waiting_queue WHERE id = ?").run(id);
    return { success: true };
  });
}
