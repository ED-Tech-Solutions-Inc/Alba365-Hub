import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";
import { broadcast } from "../realtime/websocket.js";

export function registerKitchenOrderRoutes(app: FastifyInstance) {
  // Create kitchen order
  app.post("/api/kitchen-orders", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    const result = transaction((db) => {
      db.prepare(`
        INSERT INTO kitchen_orders (
          id, tenant_id, location_id, terminal_id, order_number,
          order_type, status, table_id, table_name, table_session_id,
          customer_id, customer_name, server_id, server_name,
          subtotal, discount_total, tax_total, total, gratuity,
          notes, course_id, items, metadata, created_at, sync_status
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, 'PENDING', ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, datetime('now'), 'PENDING'
        )
      `).run(
        id, config.tenantId ?? "", config.locationId ?? "", body.terminalId ?? null, body.orderNumber ?? null,
        body.orderType ?? "TAKE_OUT", body.tableId ?? null, body.tableName ?? null, body.tableSessionId ?? null,
        body.customerId ?? null, body.customerName ?? null, body.serverId ?? null, body.serverName ?? null,
        body.subtotal ?? 0, body.discountTotal ?? 0, body.taxTotal ?? 0, body.total ?? 0, body.gratuity ?? 0,
        body.notes ?? null, body.courseId ?? null, JSON.stringify(body.items ?? []),
        JSON.stringify(body.metadata ?? {}),
      );

      // Insert individual items
      const items = (body.items as Array<Record<string, unknown>>) ?? [];
      const insertItem = db.prepare(`
        INSERT INTO kitchen_order_items (
          id, kitchen_order_id, product_id, product_name, variant_id, variant_name,
          quantity, unit_price, status, course_id, seat_number, modifiers, notes, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insertItem.run(
          generateId(), id,
          item.productId, item.productName,
          item.variantId ?? null, item.variantName ?? null,
          item.quantity ?? 1, item.unitPrice ?? 0,
          item.courseId ?? null, item.seatNumber ?? null,
          JSON.stringify(item.modifiers ?? []),
          item.notes ?? null,
          JSON.stringify(item.metadata ?? {}),
        );
      }

      // Queue for sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('kitchen_order', ?, 'create', ?, 10, datetime('now'))
      `).run(id, JSON.stringify(body));

      return { id, status: "PENDING", createdAt: new Date().toISOString() };
    });

    // Broadcast to KDS terminals (outside transaction — fire-and-forget)
    broadcast("order:created", { id, orderNumber: body.orderNumber, orderType: body.orderType }, { role: "kds" });

    return result;
  });

  // List kitchen orders
  app.get("/api/kitchen-orders", async (req) => {
    const db = getDb();
    const { status, limit } = req.query as Record<string, string>;

    let sql = "SELECT * FROM kitchen_orders WHERE location_id = ?";
    const params: unknown[] = [config.locationId ?? ""];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    } else {
      sql += " AND status IN ('PENDING', 'PREPARING', 'READY')";
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(clampLimit(limit));

    const orders = db.prepare(sql).all(...params);

    // Attach items for each order
    const getItems = db.prepare("SELECT * FROM kitchen_order_items WHERE kitchen_order_id = ?");
    return (orders as Array<Record<string, unknown>>).map((order) => ({
      ...order,
      itemsList: getItems.all(order.id as string),
    }));
  });

  // Update status
  app.patch("/api/kitchen-orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const status = body.status as string;
    const cancelReason = (body.cancelReason ?? body.cancel_reason ?? body.voidReason ?? body.void_reason) as string | undefined;
    const db = getDb();

    const order = db.prepare("SELECT status FROM kitchen_orders WHERE id = ?").get(id);
    if (!order) {
      reply.status(404);
      return { error: "Kitchen order not found" };
    }

    const setClauses: string[] = ["status = ?", "updated_at = datetime('now')", "sync_status = 'PENDING'"];
    const setValues: unknown[] = [status];
    if (status === "PREPARING") setClauses.push("fired_at = datetime('now')");
    if (status === "COMPLETED") setClauses.push("completed_at = datetime('now')");
    if (status === "CANCELLED" && cancelReason) {
      setClauses.push("cancel_reason = ?");
      setValues.push(cancelReason);
      setClauses.push("cancelled_at = datetime('now')");
    }

    setValues.push(id);
    transaction((txDb) => {
      txDb.prepare(`UPDATE kitchen_orders SET ${setClauses.join(", ")} WHERE id = ?`).run(...setValues);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('kitchen_order', ?, 'update', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, status, cancelReason }));
    });

    // Broadcast status change to all terminals (outside transaction)
    broadcast("order:status", { id, status, cancelReason });

    return { success: true, status };
  });

  // Update kitchen order (edit order — add/remove/modify items)
  app.put("/api/kitchen-orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const order = db.prepare("SELECT id FROM kitchen_orders WHERE id = ?").get(id);
    if (!order) {
      reply.status(404);
      return { error: "Kitchen order not found" };
    }

    transaction((txDb) => {
      // Update order fields
      txDb.prepare(`
        UPDATE kitchen_orders SET
          order_type = COALESCE(?, order_type),
          customer_name = COALESCE(?, customer_name),
          server_name = COALESCE(?, server_name),
          notes = ?,
          subtotal = COALESCE(?, subtotal),
          discount_total = COALESCE(?, discount_total),
          tax_total = COALESCE(?, tax_total),
          total = COALESCE(?, total),
          status = 'PENDING',
          updated_at = datetime('now'),
          sync_status = 'PENDING'
        WHERE id = ?
      `).run(
        body.orderType ?? null, body.customerName ?? null,
        body.serverName ?? null, body.notes ?? null,
        body.subtotal ?? null, body.discountTotal ?? null,
        body.taxTotal ?? null, body.total ?? null,
        id,
      );

      // Handle new items
      const items = (body.items as Array<Record<string, unknown>>) ?? [];
      const insertItem = txDb.prepare(`
        INSERT INTO kitchen_order_items (
          id, kitchen_order_id, product_id, product_name, variant_id, variant_name,
          quantity, unit_price, status, course_id, seat_number, modifiers, notes, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
      `);

      const updateItem = txDb.prepare(`
        UPDATE kitchen_order_items SET
          quantity = ?, unit_price = ?, notes = ?, modifiers = ?,
          course_id = ?, metadata = ?
        WHERE id = ?
      `);

      for (const item of items) {
        if (item.isNew) {
          insertItem.run(
            generateId(), id,
            item.productId, item.productName,
            item.variantId ?? null, item.variantName ?? null,
            item.quantity ?? 1, item.unitPrice ?? 0,
            item.courseId ?? null, item.seatNumber ?? null,
            JSON.stringify(item.modifiers ?? []),
            item.notes ?? null,
            JSON.stringify(item.metadata ?? {}),
          );
        } else if (item.id) {
          updateItem.run(
            item.quantity ?? 1, item.unitPrice ?? 0,
            item.notes ?? null, JSON.stringify(item.modifiers ?? []),
            item.courseId ?? null, JSON.stringify(item.metadata ?? {}),
            item.id,
          );
        }
      }

      // Handle deleted items (void them)
      const deletedItems = (body.deletedItems as Array<Record<string, unknown>>) ?? [];
      for (const deleted of deletedItems) {
        if (deleted.id) {
          txDb.prepare(`
            UPDATE kitchen_order_items SET status = 'VOIDED', voided_at = datetime('now'), void_reason = ?
            WHERE kitchen_order_id = ? AND product_id = ? AND status != 'VOIDED'
          `).run(deleted.reason ?? "Removed from order", id, deleted.productId);
        }
      }

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('kitchen_order', ?, 'update', ?, 10, datetime('now'))
      `).run(id, JSON.stringify(body));
    });

    // Broadcast order edit to KDS terminals (outside transaction)
    broadcast("order:updated", { id }, { role: "kds" });

    return { success: true, id, status: "PENDING" };
  });

  // Bump kitchen order (KDS bump bar action)
  app.post("/api/kitchen-orders/:id/bump", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const order = db.prepare("SELECT status FROM kitchen_orders WHERE id = ?").get(id) as { status: string } | undefined;
    if (!order) {
      reply.status(404);
      return { error: "Kitchen order not found" };
    }

    // Bump advances status: PENDING→PREPARING→READY→COMPLETED
    const statusFlow: Record<string, string> = {
      PENDING: "PREPARING",
      PREPARING: "READY",
      READY: "COMPLETED",
    };
    const nextStatus = statusFlow[order.status];
    if (!nextStatus) {
      return { success: false, message: `Cannot bump from status ${order.status}` };
    }

    const bumpClauses: string[] = ["status = ?", "updated_at = datetime('now')", "sync_status = 'PENDING'"];
    const bumpValues: unknown[] = [nextStatus];
    if (nextStatus === "PREPARING") bumpClauses.push("fired_at = datetime('now')");
    if (nextStatus === "COMPLETED") bumpClauses.push("completed_at = datetime('now')");

    bumpValues.push(id);
    transaction((txDb) => {
      txDb.prepare(`UPDATE kitchen_orders SET ${bumpClauses.join(", ")} WHERE id = ?`).run(...bumpValues);

      // Also advance all items to match
      txDb.prepare(`UPDATE kitchen_order_items SET status = ? WHERE kitchen_order_id = ? AND status != 'VOIDED'`)
        .run(nextStatus, id);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('kitchen_order', ?, 'update', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, status: nextStatus }));
    });

    // Broadcast bump to all terminals (outside transaction)
    broadcast("order:status", { id, status: nextStatus, previousStatus: order.status });

    return { success: true, previousStatus: order.status, newStatus: nextStatus };
  });

  // Update item status
  app.post("/api/kitchen-orders/:orderId/items/:itemId/status", async (req, reply) => {
    const { orderId, itemId } = req.params as { orderId: string; itemId: string };
    const { status, voidReason } = req.body as { status: string; voidReason?: string };
    const db = getDb();

    const item = db.prepare("SELECT id FROM kitchen_order_items WHERE id = ? AND kitchen_order_id = ?").get(itemId, orderId);
    if (!item) {
      reply.status(404);
      return { error: "Item not found" };
    }

    if (status === "VOIDED") {
      db.prepare("UPDATE kitchen_order_items SET status = 'VOIDED', voided_at = datetime('now'), void_reason = ? WHERE id = ?")
        .run(voidReason ?? null, itemId);
    } else {
      db.prepare("UPDATE kitchen_order_items SET status = ? WHERE id = ?").run(status, itemId);
    }

    return { success: true };
  });
}
