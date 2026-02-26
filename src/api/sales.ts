import type { FastifyInstance } from "fastify";
import { getDb, generateId, nextReceiptNumber, transaction, clampLimit } from "../db/index.js";
import { config } from "../config.js";

export function registerSaleRoutes(app: FastifyInstance) {
  // Create sale (the most critical endpoint)
  app.post("/api/sales", async (req) => {
    const body = req.body as Record<string, unknown>;

    return transaction((db) => {
      const saleId = generateId();
      const receiptNumber = nextReceiptNumber();

      // Insert sale
      db.prepare(`
        INSERT INTO sales (
          id, tenant_id, location_id, terminal_id, receipt_number,
          order_type, customer_id, customer_name, table_session_id, kitchen_order_id,
          subtotal, discount_total, coupon_discount, tax_total, tax_breakdown,
          delivery_charge, round_off, total, gratuity, amount_paid, change_given,
          status, cashier_id, cashier_name, notes, metadata, data_blob,
          created_at, sync_status
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          'COMPLETED', ?, ?, ?, ?, ?,
          datetime('now'), 'PENDING'
        )
      `).run(
        saleId, config.tenantId ?? "", config.locationId ?? "", body.terminalId ?? null, receiptNumber,
        body.orderType ?? "TAKE_OUT", body.customerId ?? null, body.customerName ?? null,
        body.tableSessionId ?? null, body.kitchenOrderId ?? null,
        body.subtotal ?? 0, body.discountTotal ?? 0, body.couponDiscount ?? 0,
        body.taxTotal ?? 0, JSON.stringify(body.taxBreakdown ?? []),
        body.deliveryCharge ?? 0, body.roundOff ?? 0, body.total ?? 0,
        body.gratuity ?? 0, body.amountPaid ?? 0, body.changeGiven ?? 0,
        body.cashierId ?? null, body.cashierName ?? null,
        body.notes ?? null, JSON.stringify(body.metadata ?? {}),
        JSON.stringify(body),
      );

      // Insert sale items
      const items = (body.items as Array<Record<string, unknown>>) ?? [];
      const insertItem = db.prepare(`
        INSERT INTO sale_items (id, sale_id, product_id, product_name, variant_id, variant_name,
          quantity, unit_price, discount, discount_type, tax, total, modifiers, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insertItem.run(
          generateId(), saleId,
          item.productId, item.productName,
          item.variantId ?? null, item.variantName ?? null,
          item.quantity ?? 1, item.unitPrice ?? 0,
          item.discount ?? 0, item.discountType ?? null,
          item.tax ?? 0, item.total ?? 0,
          JSON.stringify(item.modifiers ?? []),
          JSON.stringify(item.metadata ?? {}),
        );
      }

      // Insert payments
      const payments = (body.payments as Array<Record<string, unknown>>) ?? [];
      const insertPayment = db.prepare(`
        INSERT INTO payments (id, sale_id, method, amount, tip_amount, reference, card_last_four, card_brand, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const payment of payments) {
        insertPayment.run(
          generateId(), saleId,
          payment.method, payment.amount,
          payment.tipAmount ?? 0, payment.reference ?? null,
          payment.cardLastFour ?? null, payment.cardBrand ?? null,
        );
      }

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, correlation_id, priority, created_at)
        VALUES ('sale', ?, 'create', ?, ?, 10, datetime('now'))
      `).run(saleId, JSON.stringify(body), saleId);

      return {
        id: saleId,
        receiptNumber,
        status: "COMPLETED",
        total: body.total,
        createdAt: new Date().toISOString(),
      };
    });
  });

  // List sales
  app.get("/api/sales", async (req) => {
    const db = getDb();
    const { date, status, limit } = req.query as Record<string, string>;

    let sql = "SELECT * FROM sales WHERE location_id = ?";
    const params: unknown[] = [config.locationId ?? ""];

    if (date) {
      sql += " AND date(created_at) = ?";
      params.push(date);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(clampLimit(limit));

    return db.prepare(sql).all(...params);
  });

  // Get sale details
  app.get("/api/sales/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) {
      reply.status(404);
      return { error: "Sale not found" };
    }

    const items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(id);
    const payments = db.prepare("SELECT * FROM payments WHERE sale_id = ?").all(id);

    return { ...(sale as Record<string, unknown>), items, payments };
  });

  // Void sale
  app.post("/api/sales/:id/void", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason, userId } = req.body as { reason?: string; userId?: string };
    const db = getDb();

    const sale = db.prepare("SELECT status FROM sales WHERE id = ?").get(id) as { status: string } | undefined;
    if (!sale) {
      reply.status(404);
      return { error: "Sale not found" };
    }
    if (sale.status === "VOIDED") {
      reply.status(400);
      return { error: "Sale already voided" };
    }

    transaction((txDb) => {
      txDb.prepare("UPDATE sales SET status = 'VOIDED', voided_at = datetime('now'), void_reason = ?, sync_status = 'PENDING' WHERE id = ?")
        .run(reason ?? null, id);

      // Queue void for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('sale', ?, 'void', ?, 10, datetime('now'))
      `).run(id, JSON.stringify({ saleId: id, reason, userId }));
    });

    return { success: true };
  });
}
