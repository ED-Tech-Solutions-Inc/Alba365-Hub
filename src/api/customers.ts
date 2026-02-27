import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerCustomerRoutes(app: FastifyInstance) {
  app.get("/api/customers", async (req) => {
    const db = getDb();
    const { search, limit } = req.query as Record<string, string>;
    const safeLimit = clampLimit(limit, 100);

    if (search) {
      const term = `%${search}%`;
      return db.prepare(`
        SELECT * FROM customers WHERE tenant_id = ?
        AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?)
        LIMIT ?
      `).all(config.tenantId ?? "", term, term, term, term, safeLimit);
    }

    return db.prepare("SELECT * FROM customers WHERE tenant_id = ? LIMIT ?")
      .all(config.tenantId ?? "", safeLimit);
  });

  app.get("/api/customers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const customer = db.prepare("SELECT * FROM customers WHERE id = ? AND tenant_id = ?").get(id, config.tenantId ?? "");
    if (!customer) {
      reply.status(404);
      return { error: "Customer not found" };
    }

    const addresses = db.prepare("SELECT * FROM customer_addresses WHERE customer_id = ?").all(id);

    // Enrichment: visit count, total spent, store credits
    const salesStats = db.prepare(`
      SELECT COUNT(*) as visit_count, COALESCE(SUM(total), 0) as total_spent
      FROM sales WHERE customer_id = ? AND status = 'COMPLETED'
    `).get(id) as { visit_count: number; total_spent: number };

    const storeCredits = db.prepare(`
      SELECT id, code, initial_amount, current_balance, status, created_at
      FROM store_credits WHERE customer_id = ? AND status = 'ACTIVE' AND current_balance > 0
    `).all(id);

    return {
      ...(customer as Record<string, unknown>),
      addresses,
      visitCount: salesStats.visit_count,
      totalSpent: salesStats.total_spent,
      storeCredits,
    };
  });

  app.post("/api/customers", async (req) => {
    const body = req.body as Record<string, unknown>;
    const id = generateId();

    transaction((db) => {
      db.prepare(`
        INSERT INTO customers (id, tenant_id, first_name, last_name, email, phone, address, city, province, postal_code, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        id, config.tenantId ?? "",
        body.firstName ?? null, body.lastName ?? null,
        body.email ?? null, body.phone ?? null,
        body.address ?? null, body.city ?? null,
        body.province ?? null, body.postalCode ?? null,
        body.notes ?? null,
      );

      // Queue for cloud sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('customer', ?, 'create', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { id, ...body };
  });

  // Update customer
  app.put("/api/customers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const existing = db.prepare("SELECT id FROM customers WHERE id = ? AND tenant_id = ?")
      .get(id, config.tenantId ?? "");
    if (!existing) {
      reply.status(404);
      return { error: "Customer not found" };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE customers SET
          first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          address = COALESCE(?, address),
          city = COALESCE(?, city),
          province = COALESCE(?, province),
          postal_code = COALESCE(?, postal_code),
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).run(
        body.firstName ?? null, body.lastName ?? null,
        body.email ?? null, body.phone ?? null,
        body.address ?? null, body.city ?? null,
        body.province ?? null, body.postalCode ?? null,
        body.notes ?? null,
        id, config.tenantId ?? "",
      );

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('customer', ?, 'update', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    return updated;
  });
}
