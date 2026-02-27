import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerRefundRoutes(app: FastifyInstance) {
  // Create refund
  app.post("/api/refunds", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const saleId = body.saleId as string;

    if (!saleId) {
      reply.status(400);
      return { error: "saleId is required" };
    }

    const db = getDb();
    const sale = db.prepare("SELECT id, status FROM sales WHERE id = ? AND location_id = ?")
      .get(saleId, config.locationId ?? "") as { id: string; status: string } | undefined;

    if (!sale) {
      reply.status(404);
      return { error: "Sale not found" };
    }
    if (sale.status === "VOIDED") {
      reply.status(400);
      return { error: "Cannot refund a voided sale" };
    }

    const refundId = generateId();
    const items = (body.items as Array<Record<string, unknown>>) ?? [];
    const refundTotal = (body.total as number) ?? items.reduce((sum: number, i) => sum + ((i.amount as number) ?? 0), 0);
    const refundMethod = (body.method as string) ?? "ORIGINAL";
    const reason = (body.reason as string) ?? "";
    const requestedById = (body.requestedById as string) ?? null;
    const requestedByName = (body.requestedByName as string) ?? null;

    // Check if refund exceeds threshold (requires manager approval)
    const settings = db.prepare("SELECT * FROM location_settings WHERE location_id = ?")
      .get(config.locationId ?? "") as Record<string, unknown> | undefined;
    const maxAutoApprove = (settings?.refund_auto_approve_limit as number) ?? 50;
    const needsApproval = refundTotal > maxAutoApprove;
    const initialStatus = needsApproval ? "PENDING_APPROVAL" : "APPROVED";

    transaction((txDb) => {
      txDb.prepare(`
        INSERT INTO refunds (
          id, tenant_id, location_id, sale_id,
          total, tax_refund, method, reason,
          status, requested_by_id, requested_by_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        refundId, config.tenantId ?? "", config.locationId ?? "", saleId,
        refundTotal, body.taxRefund ?? 0, refundMethod, reason,
        initialStatus, requestedById, requestedByName,
      );

      // Insert refund items
      const insertItem = txDb.prepare(`
        INSERT INTO refund_items (
          id, refund_id, sale_item_id, product_id, product_name,
          quantity, unit_price, amount, tax, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insertItem.run(
          generateId(), refundId,
          item.saleItemId ?? null, item.productId ?? null, item.productName ?? null,
          item.quantity ?? 1, item.unitPrice ?? 0, item.amount ?? 0,
          item.tax ?? 0, item.reason ?? reason,
        );
      }

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, correlation_id, priority, created_at)
        VALUES ('refund', ?, 'create', ?, ?, 10, datetime('now'))
      `).run(refundId, JSON.stringify({ ...body, refundId, status: initialStatus }), refundId);
    });

    return {
      id: refundId,
      saleId,
      total: refundTotal,
      status: initialStatus,
      needsApproval,
    };
  });

  // Get refund by ID
  app.get("/api/refunds/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const refund = db.prepare("SELECT * FROM refunds WHERE id = ? AND tenant_id = ?")
      .get(id, config.tenantId ?? "");
    if (!refund) {
      reply.status(404);
      return { error: "Refund not found" };
    }

    const items = db.prepare("SELECT * FROM refund_items WHERE refund_id = ?").all(id);
    return { ...(refund as Record<string, unknown>), items };
  });

  // List refunds for a sale
  app.get("/api/refunds", async (req) => {
    const db = getDb();
    const { saleId, status, limit } = req.query as Record<string, string>;

    let sql = "SELECT * FROM refunds WHERE tenant_id = ?";
    const params: unknown[] = [config.tenantId ?? ""];

    if (saleId) {
      sql += " AND sale_id = ?";
      params.push(saleId);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(clampLimit(limit));

    return db.prepare(sql).all(...params);
  });

  // Approve refund (manager action)
  app.patch("/api/refunds/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const refund = db.prepare("SELECT status FROM refunds WHERE id = ? AND tenant_id = ?")
      .get(id, config.tenantId ?? "") as { status: string } | undefined;

    if (!refund) {
      reply.status(404);
      return { error: "Refund not found" };
    }
    if (refund.status !== "PENDING_APPROVAL") {
      reply.status(400);
      return { error: `Cannot approve refund in status: ${refund.status}` };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE refunds SET status = 'APPROVED', approved_by_id = ?, approved_by_name = ?, approved_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(body.approvedById ?? null, body.approvedByName ?? null, id);

      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('refund', ?, 'approve', ?, 10, datetime('now'))
      `).run(id, JSON.stringify({ refundId: id, ...body }));
    });

    return { success: true, status: "APPROVED" };
  });

  // Complete refund (after processing payment)
  app.patch("/api/refunds/:id/complete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const refund = db.prepare("SELECT status, sale_id FROM refunds WHERE id = ? AND tenant_id = ?")
      .get(id, config.tenantId ?? "") as { status: string; sale_id: string } | undefined;

    if (!refund) {
      reply.status(404);
      return { error: "Refund not found" };
    }
    if (refund.status !== "APPROVED") {
      reply.status(400);
      return { error: `Cannot complete refund in status: ${refund.status}` };
    }

    transaction((txDb) => {
      txDb.prepare("UPDATE refunds SET status = 'COMPLETED', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(id);

      // Update the sale status to REFUNDED
      txDb.prepare("UPDATE sales SET status = 'REFUNDED', sync_status = 'PENDING', updated_at = datetime('now') WHERE id = ?")
        .run(refund.sale_id);

      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('refund', ?, 'complete', ?, 10, datetime('now'))
      `).run(id, JSON.stringify({ refundId: id, saleId: refund.sale_id }));
    });

    return { success: true, status: "COMPLETED" };
  });
}
