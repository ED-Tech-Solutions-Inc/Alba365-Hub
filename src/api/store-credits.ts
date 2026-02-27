import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerStoreCreditRoutes(app: FastifyInstance) {
  // Lookup store credit by phone, email, or code
  app.get("/api/store-credits/lookup", async (req) => {
    const db = getDb();
    const { query } = req.query as Record<string, string>;

    if (!query || query.length < 2) {
      return { credits: [] };
    }

    const term = `%${query}%`;

    // Join store_credits with customers to allow lookup by phone/email/name
    const credits = db.prepare(`
      SELECT sc.*, c.first_name, c.last_name, c.phone, c.email
      FROM store_credits sc
      JOIN customers c ON sc.customer_id = c.id
      WHERE sc.tenant_id = ? AND sc.status = 'ACTIVE' AND sc.current_balance > 0
        AND (
          sc.code LIKE ?
          OR c.phone LIKE ?
          OR c.email LIKE ?
          OR c.first_name LIKE ?
          OR c.last_name LIKE ?
        )
      ORDER BY sc.created_at DESC
      LIMIT 20
    `).all(config.tenantId ?? "", term, term, term, term, term);

    return { credits };
  });

  // Get store credit by ID
  app.get("/api/store-credits/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const credit = db.prepare(`
      SELECT sc.*, c.first_name, c.last_name, c.phone, c.email
      FROM store_credits sc
      JOIN customers c ON sc.customer_id = c.id
      WHERE sc.id = ? AND sc.tenant_id = ?
    `).get(id, config.tenantId ?? "");

    if (!credit) {
      reply.status(404);
      return { error: "Store credit not found" };
    }

    return credit;
  });

  // Redeem store credit
  app.post("/api/store-credits/redeem", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const creditId = body.storeCreditId as string;
    const amount = body.amount as number;
    const saleId = body.saleId as string | undefined;

    if (!creditId || !amount || amount <= 0) {
      reply.status(400);
      return { error: "storeCreditId and positive amount required" };
    }

    const db = getDb();
    const credit = db.prepare(
      "SELECT id, current_balance, customer_id FROM store_credits WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'"
    ).get(creditId, config.tenantId ?? "") as { id: string; current_balance: number; customer_id: string } | undefined;

    if (!credit) {
      reply.status(404);
      return { error: "Store credit not found or inactive" };
    }

    if (amount > credit.current_balance) {
      reply.status(400);
      return { error: "Insufficient store credit balance" };
    }

    const newBalance = credit.current_balance - amount;
    const transactionId = generateId();

    transaction((txDb) => {
      txDb.prepare(
        "UPDATE store_credits SET current_balance = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newBalance, creditId);

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('store_credit', ?, 'redeem', ?, 10, datetime('now'))
      `).run(creditId, JSON.stringify({
        storeCreditId: creditId,
        customerId: credit.customer_id,
        amount,
        newBalance,
        saleId,
        transactionId,
      }));
    });

    return {
      id: transactionId,
      storeCreditId: creditId,
      amountRedeemed: amount,
      remainingBalance: newBalance,
    };
  });
}
