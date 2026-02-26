import type { FastifyInstance } from "fastify";
import { getDb, generateId, clampLimit, transaction } from "../db/index.js";
import { config } from "../config.js";
import bcrypt from "bcryptjs";

export function registerUserRoutes(app: FastifyInstance) {
  // List all users (staff) for this location
  app.get("/api/users", async () => {
    const db = getDb();
    const users = db.prepare(`
      SELECT id, name, email, role, permissions, max_discount, is_active, created_at, updated_at
      FROM users WHERE tenant_id = ?
      ORDER BY name ASC
    `).all(config.tenantId ?? "");
    return users;
  });

  // Change user PIN
  app.post("/api/users/:userId/change-pin", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { newPin } = req.body as { newPin: string };
    const db = getDb();

    const user = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?")
      .get(userId, config.tenantId ?? "");
    if (!user) {
      reply.status(404);
      return { error: "User not found" };
    }

    const pinHash = bcrypt.hashSync(newPin, 12);

    transaction((txDb) => {
      txDb.prepare("UPDATE users SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .run(pinHash, userId);

      // Queue for sync so cloud gets the updated PIN
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('user', ?, 'update_pin', ?, 5, datetime('now'))
      `).run(userId, JSON.stringify({ userId, pinHash }));
    });

    return { success: true };
  });

  // Toggle user active/inactive
  app.post("/api/users/:userId/toggle-active", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const db = getDb();

    const user = db.prepare("SELECT id, is_active FROM users WHERE id = ? AND tenant_id = ?")
      .get(userId, config.tenantId ?? "") as { id: string; is_active: number } | undefined;
    if (!user) {
      reply.status(404);
      return { error: "User not found" };
    }

    const newStatus = user.is_active ? 0 : 1;

    transaction((txDb) => {
      txDb.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newStatus, userId);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('user', ?, 'toggle_active', ?, 5, datetime('now'))
      `).run(userId, JSON.stringify({ userId, isActive: !!newStatus }));
    });

    return { success: true, isActive: !!newStatus };
  });

  // Record staff payout (tips, compensation)
  app.post("/api/users/:staffId/payout", async (req) => {
    const { staffId } = req.params as { staffId: string };
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const tips = (body.tips as number) ?? 0;
    const compensation = (body.compensation as number) ?? 0;
    const method = (body.method as string) ?? "CASH";

    // Record as a staff bank transaction if a staff bank exists
    const bank = db.prepare(`
      SELECT id FROM staff_banks WHERE user_id = ? AND location_id = ? AND status = 'OPEN'
      ORDER BY opened_at DESC LIMIT 1
    `).get(staffId, config.locationId ?? "") as { id: string } | undefined;

    if (bank) {
      const amount = tips + compensation;
      const txnId = generateId();

      transaction((txDb) => {
        txDb.prepare(`
          INSERT INTO staff_bank_transactions (id, staff_bank_id, type, amount, reference, reason, user_id, created_at)
          VALUES (?, ?, 'PAYOUT', ?, ?, ?, ?, strftime('%s', 'now'))
        `).run(
          txnId, bank.id, amount,
          method, `Tips: ${tips}, Compensation: ${compensation}`, staffId,
        );

        // Queue for cloud sync
        txDb.prepare(`
          INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
          VALUES ('staff_bank_transaction', ?, 'create', ?, 5, datetime('now'))
        `).run(txnId, JSON.stringify({ id: txnId, staffBankId: bank.id, staffId, tips, compensation, method }));
      });
    }

    return { success: true, tips, compensation, method };
  });

  // Get unpaid delivery balances
  app.get("/api/users/delivery-balances", async () => {
    const db = getDb();
    // Sum delivery compensation from sales not yet paid out
    const balances = db.prepare(`
      SELECT s.server_id as userId, u.name as userName,
        SUM(CASE WHEN s.order_type = 'DELIVERY' THEN COALESCE(s.gratuity, 0) ELSE 0 END) as unpaidTips,
        COUNT(CASE WHEN s.order_type = 'DELIVERY' THEN 1 END) as deliveryCount
      FROM sales s
      LEFT JOIN users u ON u.id = s.server_id
      WHERE s.location_id = ? AND s.order_type = 'DELIVERY' AND s.server_id IS NOT NULL
      GROUP BY s.server_id
      HAVING unpaidTips > 0
    `).all(config.locationId ?? "");
    return balances;
  });

  // Recent payout history
  app.get("/api/users/payout-history", async (req) => {
    const { limit } = req.query as Record<string, string>;
    const db = getDb();
    const payouts = db.prepare(`
      SELECT t.*, u.name as userName
      FROM staff_bank_transactions t
      LEFT JOIN staff_banks b ON b.id = t.staff_bank_id
      LEFT JOIN users u ON u.id = t.user_id
      WHERE b.location_id = ? AND t.type = 'PAYOUT'
      ORDER BY t.created_at DESC LIMIT ?
    `).all(config.locationId ?? "", clampLimit(limit, 20, 200));
    return payouts;
  });

  // Get current user's assignment (role + permissions)
  app.get("/api/users/my-assignment", async (req) => {
    const { userId } = req.query as Record<string, string>;
    const db = getDb();
    const user = db.prepare(`
      SELECT u.id, u.name, u.role, u.permissions, u.max_discount, u.is_active,
        r.name as roleName, r.permissions as rolePermissions
      FROM users u
      LEFT JOIN roles r ON r.name = u.role AND r.tenant_id = u.tenant_id
      WHERE u.id = ? AND u.tenant_id = ?
    `).get(userId, config.tenantId ?? "");
    return user ?? { error: "User not found" };
  });
}
