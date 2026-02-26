import type { FastifyInstance } from "fastify";
import { getDb, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerOrderRoutes(app: FastifyInstance) {
  // List orders (sales) with filters — defaults to today, limit 100
  app.get("/api/orders", async (req) => {
    const db = getDb();
    const {
      dateFrom,
      dateTo,
      orderType,
      status,
      search,
      limit,
    } = req.query as Record<string, string>;

    let sql = `
      SELECT s.*
      FROM sales s
      WHERE s.location_id = ?
    `;
    const params: unknown[] = [config.locationId ?? ""];

    // Date range filter — default to today if no date params provided
    if (dateFrom && dateTo) {
      sql += " AND s.created_at >= ? AND s.created_at < datetime(?, '+1 day')";
      params.push(dateFrom, dateTo);
    } else if (dateFrom) {
      sql += " AND s.created_at >= ?";
      params.push(dateFrom);
    } else if (dateTo) {
      sql += " AND s.created_at < datetime(?, '+1 day')";
      params.push(dateTo);
    } else {
      // Default: today's orders
      sql += " AND date(s.created_at) = date('now')";
    }

    if (orderType) {
      sql += " AND s.order_type = ?";
      params.push(orderType);
    }

    if (status) {
      sql += " AND s.status = ?";
      params.push(status);
    }

    if (search) {
      sql += " AND (s.receipt_number LIKE ? OR s.customer_name LIKE ?)";
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    sql += " ORDER BY s.created_at DESC LIMIT ?";
    params.push(clampLimit(limit, 100));

    const sales = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    // Attach items and payments for each sale
    const getItems = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?");
    const getPayments = db.prepare("SELECT * FROM payments WHERE sale_id = ?");

    return sales.map((sale) => ({
      ...sale,
      items: getItems.all(sale.id as string),
      payments: getPayments.all(sale.id as string),
    }));
  });

  // Get full order detail: sale + items + payments
  app.get("/api/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) {
      reply.status(404);
      return { error: "Order not found" };
    }

    const items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(id);
    const payments = db.prepare("SELECT * FROM payments WHERE sale_id = ?").all(id);

    return { ...(sale as Record<string, unknown>), items, payments };
  });

  // Void an order: set status=VOIDED, voidReason, voidedAt, queue outbox
  app.patch("/api/orders/:id/void", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason, userId } = req.body as { reason?: string; userId?: string };
    const db = getDb();

    const sale = db.prepare("SELECT status FROM sales WHERE id = ?").get(id) as { status: string } | undefined;
    if (!sale) {
      reply.status(404);
      return { error: "Order not found" };
    }
    if (sale.status === "VOIDED") {
      reply.status(400);
      return { error: "Order already voided" };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE sales
        SET status = 'VOIDED', voided_at = datetime('now'), void_reason = ?, sync_status = 'PENDING'
        WHERE id = ?
      `).run(reason ?? null, id);

      // Queue void for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('sale', ?, 'void', ?, 10, datetime('now'))
      `).run(id, JSON.stringify({ saleId: id, reason, userId }));
    });

    return { success: true, id, status: "VOIDED" };
  });

  // Quick stats: today's total count, total revenue, avg order value, orders by type
  app.get("/api/orders/summary", async () => {
    const locationId = config.locationId ?? "";

    // Wrap in read transaction for snapshot consistency across all 3 queries
    return transaction((db) => {
      // Aggregate stats for today's completed orders
      const stats = db.prepare(`
        SELECT
          COUNT(*) as totalCount,
          COALESCE(SUM(total), 0) as totalRevenue,
          COALESCE(AVG(total), 0) as avgOrderValue
        FROM sales
        WHERE location_id = ?
          AND date(created_at) = date('now')
          AND status = 'COMPLETED'
      `).get(locationId) as { totalCount: number; totalRevenue: number; avgOrderValue: number } | undefined;

      // Orders by type for today
      const byType = db.prepare(`
        SELECT
          order_type as orderType,
          COUNT(*) as count,
          COALESCE(SUM(total), 0) as revenue
        FROM sales
        WHERE location_id = ?
          AND date(created_at) = date('now')
          AND status = 'COMPLETED'
        GROUP BY order_type
        ORDER BY count DESC
      `).all(locationId) as Array<{ orderType: string; count: number; revenue: number }>;

      // Voided orders count for today
      const voided = db.prepare(`
        SELECT COUNT(*) as count
        FROM sales
        WHERE location_id = ?
          AND date(created_at) = date('now')
          AND status = 'VOIDED'
      `).get(locationId) as { count: number } | undefined;

      return {
        totalCount: stats?.totalCount ?? 0,
        totalRevenue: stats?.totalRevenue ?? 0,
        avgOrderValue: Math.round((stats?.avgOrderValue ?? 0) * 100) / 100,
        voidedCount: voided?.count ?? 0,
        byType,
      };
    });
  });
}
