import type { FastifyInstance } from "fastify";
import { getDb, generateId } from "../db/index.js";
import { config } from "../config.js";

interface ReservationRow {
  id: string;
  tenant_id: string;
  location_id: string;
  customer_name: string;
  phone: string | null;
  party_size: number;
  reservation_date: string;
  reservation_time: string;
  status: string;
  notes: string | null;
  table_id: string | null;
  created_at: number;
  seated_at: number | null;
  cancelled_at: number | null;
}

function mapRow(row: ReservationRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    locationId: row.location_id,
    customerName: row.customer_name,
    phone: row.phone,
    partySize: row.party_size,
    reservationDate: row.reservation_date,
    reservationTime: row.reservation_time,
    status: row.status,
    notes: row.notes,
    tableId: row.table_id,
    createdAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : null,
    seatedAt: row.seated_at ? new Date(row.seated_at * 1000).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at * 1000).toISOString() : null,
  };
}

export function registerReservationRoutes(app: FastifyInstance) {
  // Get upcoming reservations (today and future, not cancelled/seated)
  app.get("/api/reservations", async () => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rows = db
      .prepare(
        `SELECT * FROM reservations
         WHERE location_id = ? AND status IN ('CONFIRMED', 'NOTIFIED')
         AND reservation_date >= ?
         ORDER BY reservation_date ASC, reservation_time ASC`
      )
      .all(config.locationId ?? "", today) as ReservationRow[];

    return rows.map(mapRow);
  });

  // Add reservation
  app.post<{
    Body: {
      customerName: string;
      phone?: string;
      partySize?: number;
      reservationDate: string;
      reservationTime: string;
      notes?: string;
      tableId?: string;
    };
  }>("/api/reservations", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const customerName = body.customerName as string | undefined;
    const reservationDate = body.reservationDate as string | undefined;
    const reservationTime = body.reservationTime as string | undefined;

    if (!customerName) {
      return reply.status(400).send({ error: "customerName is required" });
    }
    if (!reservationDate || !reservationTime) {
      return reply.status(400).send({ error: "reservationDate and reservationTime are required" });
    }

    const db = getDb();
    const id = generateId();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO reservations (id, tenant_id, location_id, customer_name, phone, party_size, reservation_date, reservation_time, status, notes, table_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)`
    ).run(
      id,
      config.tenantId ?? "",
      config.locationId ?? "",
      customerName,
      (body.phone as string) || null,
      (body.partySize as number) || 2,
      reservationDate,
      reservationTime,
      (body.notes as string) || null,
      (body.tableId as string) || null,
      now
    );

    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as ReservationRow;
    return mapRow(row);
  });

  // Update reservation (status change, seat, cancel)
  app.patch<{
    Params: { id: string };
    Body: { status?: string; tableId?: string };
  }>("/api/reservations/:id", async (request, reply) => {
    const { id } = request.params;
    const body = (request.body || {}) as Record<string, unknown>;
    const db = getDb();

    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as ReservationRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: "Reservation not found" });
    }

    const now = Math.floor(Date.now() / 1000);
    const status = body.status as string | undefined;

    if (status === "SEATED" && body.tableId) {
      db.prepare("UPDATE reservations SET status = ?, table_id = ?, seated_at = ? WHERE id = ?").run(
        "SEATED",
        body.tableId as string,
        now,
        id
      );
    } else if (status === "CANCELLED") {
      db.prepare("UPDATE reservations SET status = ?, cancelled_at = ? WHERE id = ?").run("CANCELLED", now, id);
    } else if (status) {
      db.prepare("UPDATE reservations SET status = ? WHERE id = ?").run(status, id);
    }

    const updated = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as ReservationRow;
    return mapRow(updated);
  });

  // Delete reservation
  app.delete<{ Params: { id: string } }>("/api/reservations/:id", async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as ReservationRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: "Reservation not found" });
    }

    db.prepare("DELETE FROM reservations WHERE id = ?").run(id);
    return { success: true };
  });
}
