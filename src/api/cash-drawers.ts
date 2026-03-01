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
        INSERT INTO cash_drawer_transactions (id, cash_drawer_id, type, amount, reason, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(txnId, id, body.type, body.amount, body.reason ?? null, body.userId);

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('cash_drawer_transaction', ?, 'create', ?, 5, datetime('now'))
      `).run(txnId, JSON.stringify({ id: txnId, cashDrawerId: id, ...body }));
    });

    return { id: txnId, success: true };
  });

  // Cash drawer history (list drawers by location + optional status filter)
  app.get("/api/cash-drawers/history", async (req) => {
    const { locationId, status } = req.query as Record<string, string>;
    const db = getDb();
    const loc = locationId || config.locationId || "";

    let sql = `
      SELECT d.id, d.tenant_id, d.terminal_id, d.user_id, d.status,
        d.opening_balance, d.closing_balance, d.expected_balance, d.difference,
        d.notes, d.opened_at, d.closed_at, d.closed_by_id,
        u.name as user_name,
        t.name as terminal_name
      FROM cash_drawers d
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN terminals t ON t.id = d.terminal_id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    // Filter by location via terminal (cash drawers don't have location_id directly)
    // But they do have tenant_id so use that + optional status
    if (status) {
      sql += " AND d.status = ?";
      params.push(status);
    }

    sql += " ORDER BY d.opened_at DESC LIMIT 50";

    const drawers = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    // For each open drawer, compute cash sales, pay-ins, pay-outs
    return drawers.map((d) => {
      const drawerId = d.id as string;
      const txns = db.prepare(
        "SELECT type, amount FROM cash_drawer_transactions WHERE cash_drawer_id = ?"
      ).all(drawerId) as Array<Record<string, unknown>>;

      let cashSales = 0;
      let payIn = 0;
      let payOut = 0;
      for (const txn of txns) {
        const amount = (txn.amount as number) || 0;
        if (txn.type === "SALE") cashSales += amount;
        else if (txn.type === "PAY_IN") payIn += amount;
        else if (txn.type === "PAY_OUT") payOut += amount;
      }

      return {
        id: d.id,
        userId: d.user_id,
        openedBy: d.user_name ?? "Unknown",
        terminalName: d.terminal_name ?? "",
        status: d.status,
        openingAmount: d.opening_balance,
        closingBalance: d.closing_balance,
        expectedBalance: d.expected_balance,
        difference: d.difference,
        cashSales,
        payIn,
        payOut,
        openedAt: d.opened_at,
        closedAt: d.closed_at,
      };
    });
  });
}
