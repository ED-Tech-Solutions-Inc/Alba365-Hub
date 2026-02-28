import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerCashDrawerRoutes(app: FastifyInstance) {
  // Get active cash drawer for this terminal
  app.get("/api/cash-drawers/active", async (req) => {
    const db = getDb();
    const terminalId = (req.query as Record<string, string>).terminalId;

    const drawer = db.prepare(`
      SELECT * FROM cash_drawers WHERE terminal_id = ? AND status IN ('OPEN', 'COUNTING')
      ORDER BY opened_at DESC LIMIT 1
    `).get(terminalId ?? "");

    if (!drawer) return null;

    const drawerId = (drawer as Record<string, unknown>).id as string;
    const transactions = db.prepare(
      "SELECT * FROM cash_drawer_transactions WHERE cash_drawer_id = ? ORDER BY created_at DESC"
    ).all(drawerId);

    // Compute aggregates for Flutter client (matches web POS field names)
    let payIns = 0;
    let payOuts = 0;
    for (const txn of transactions as Array<Record<string, unknown>>) {
      const amount = (txn.amount as number) || 0;
      if (txn.type === "PAY_IN") payIns += amount;
      else if (txn.type === "PAY_OUT") payOuts += amount;
    }

    // Also alias opening_balance as opening_amount for client compatibility
    const d = drawer as Record<string, unknown>;
    return {
      ...d,
      opening_amount: d.opening_balance,
      pay_ins: payIns,
      pay_outs: payOuts,
      transactions,
    };
  });

  // Open cash drawer
  app.post("/api/cash-drawers/open", async (req) => {
    const body = req.body as Record<string, unknown>;

    return transaction((db) => {
      const id = generateId();
      db.prepare(`
        INSERT INTO cash_drawers (id, tenant_id, terminal_id, user_id, opening_balance, status, opened_at)
        VALUES (?, ?, ?, ?, ?, 'OPEN', datetime('now'))
      `).run(id, config.tenantId ?? "", body.terminalId, body.userId, body.openingAmount ?? 0);

      // Queue for sync
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('cash_drawer', ?, 'create', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ ...body, id, tenantId: config.tenantId }));

      return { id, status: "OPEN", user_id: body.userId, opened_by_name: body.userName };
    });
  });

  // Close cash drawer
  app.post("/api/cash-drawers/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const drawer = db.prepare("SELECT status FROM cash_drawers WHERE id = ?").get(id);
    if (!drawer) {
      reply.status(404);
      return { error: "Cash drawer not found" };
    }

    transaction((txDb) => {
      txDb.prepare(`
        UPDATE cash_drawers SET status = 'CLOSED', closed_by_id = ?,
          closing_balance = ?, expected_balance = ?, difference = ?, closed_at = datetime('now'), sync_status = 'PENDING'
        WHERE id = ?
      `).run(body.userId, body.closingAmount, body.expectedAmount, body.difference, id);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('cash_drawer', ?, 'close', ?, 5, datetime('now'))
      `).run(id, JSON.stringify({ id, ...body }));
    });

    return { success: true };
  });

  // Pay in/out transaction
  app.post("/api/cash-drawers/:id/transaction", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const drawer = db.prepare("SELECT status FROM cash_drawers WHERE id = ?").get(id) as { status: string } | undefined;
    if (!drawer || drawer.status !== "OPEN") {
      reply.status(400);
      return { error: "Cash drawer not open" };
    }

    const txnId = generateId();

    transaction((txDb) => {
      txDb.prepare(`
        INSERT INTO cash_drawer_transactions (id, cash_drawer_id, type, amount, reason, performed_by_id, performed_by_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(txnId, id, body.type, body.amount, body.reason ?? null, body.userId, body.userName);

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('cash_drawer_transaction', ?, 'create', ?, 5, datetime('now'))
      `).run(txnId, JSON.stringify({ id: txnId, cashDrawerId: id, ...body }));
    });

    return { id: txnId, success: true };
  });
}
