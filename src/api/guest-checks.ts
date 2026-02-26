import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerGuestCheckRoutes(app: FastifyInstance) {
  // Create guest check
  app.post("/api/guest-checks", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO guest_checks (
          id, tenant_id, location_id, table_session_id, guest_number,
          subtotal, discount_total, tax_total, total, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', datetime('now'))
      `).run(
        id, config.tenantId ?? "", config.locationId ?? "",
        body.tableSessionId, body.guestNumber ?? 1,
        body.subtotal ?? 0, body.discountTotal ?? 0,
        body.taxTotal ?? 0, body.total ?? 0,
      );

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('guest_check', ?, 'create', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { id, status: "OPEN" };
  });

  // Get guest checks for a table session
  app.get("/api/guest-checks", async (req) => {
    const { tableSessionId } = req.query as { tableSessionId?: string };
    const db = getDb();

    if (!tableSessionId) {
      return db.prepare(
        "SELECT * FROM guest_checks WHERE location_id = ? AND status = 'OPEN' ORDER BY created_at DESC"
      ).all(config.locationId ?? "");
    }

    const checks = db.prepare(
      "SELECT * FROM guest_checks WHERE table_session_id = ? ORDER BY guest_number"
    ).all(tableSessionId);

    // Attach items for each check
    const getItems = db.prepare("SELECT * FROM guest_check_items WHERE guest_check_id = ?");
    return (checks as Array<Record<string, unknown>>).map((check) => ({
      ...check,
      items: getItems.all(check.id as string),
    }));
  });

  // Update guest check
  app.patch("/api/guest-checks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const check = db.prepare("SELECT id FROM guest_checks WHERE id = ?").get(id);
    if (!check) {
      reply.status(404);
      return { error: "Guest check not found" };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE guest_checks SET
          subtotal = COALESCE(?, subtotal),
          discount_total = COALESCE(?, discount_total),
          tax_total = COALESCE(?, tax_total),
          total = COALESCE(?, total),
          status = COALESCE(?, status),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        body.subtotal ?? null, body.discountTotal ?? null,
        body.taxTotal ?? null, body.total ?? null,
        body.status ?? null, id,
      );

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('guest_check', ?, 'update', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { success: true };
  });

  // Add item to guest check
  app.post("/api/guest-checks/:id/items", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const itemId = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO guest_check_items (
          id, guest_check_id, sale_item_id, product_name, quantity, unit_price, total
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        itemId, id, body.saleItemId ?? null,
        body.productName, body.quantity ?? 1,
        body.unitPrice ?? 0, body.total ?? 0,
      );

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('guest_check_item', ?, 'create', ?, 5, datetime('now'))
      `).run(itemId, JSON.stringify({ id: itemId, guestCheckId: id, ...body }));
    });

    return { id: itemId, success: true };
  });
}
