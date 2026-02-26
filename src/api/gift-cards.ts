import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerGiftCardRoutes(app: FastifyInstance) {
  // Create (sell) a new gift card
  app.post("/api/gift-cards", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const amount = Number(body.amount ?? 0);
    if (amount <= 0) {
      reply.status(400);
      return { error: "Amount must be greater than 0" };
    }

    // Generate unique 16-char alphanumeric code (or use provided code)
    let code = (body.code as string | undefined);
    if (!code) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I/O/0/1 to avoid confusion
      code = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      // Format as XXXX-XXXX-XXXX-XXXX
      code = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
    }

    // Check uniqueness
    const exists = db.prepare("SELECT id FROM gift_cards WHERE code = ? AND tenant_id = ?")
      .get(code, config.tenantId ?? "");
    if (exists) {
      reply.status(409);
      return { error: "Gift card code already exists" };
    }

    const id = generateId();
    const expiresAt = body.expiresAt as string | null ?? null;

    transaction((txDb) => {
      txDb.prepare(`
        INSERT INTO gift_cards (id, tenant_id, code, initial_balance, current_balance, is_active, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
      `).run(id, config.tenantId ?? "", code, amount, amount, expiresAt);

      // Queue for cloud sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('gift_card', ?, 'create', ?, 10, datetime('now'))
      `).run(id, JSON.stringify({ id, code, amount, expiresAt }));
    });

    return { id, code, balance: amount, initialBalance: amount, status: "ACTIVE", expiresAt };
  });

  // Look up gift card by code
  app.get("/api/gift-cards/lookup", async (req, reply) => {
    const { code } = req.query as Record<string, string>;
    if (!code) {
      reply.status(400);
      return { error: "Code is required" };
    }

    const db = getDb();
    const card = db.prepare("SELECT * FROM gift_cards WHERE code = ? AND tenant_id = ?")
      .get(code, config.tenantId ?? "") as Record<string, unknown> | undefined;

    if (!card) {
      reply.status(404);
      return { error: "Gift card not found" };
    }

    // Return balance alias for Flutter client compatibility + status string
    return {
      ...card,
      balance: card.current_balance,
      status: card.is_active === 1 ? "ACTIVE" : "INACTIVE",
    };
  });

  // Redeem gift card (deduct balance)
  app.post("/api/gift-cards/redeem", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const db = getDb();

    const card = db.prepare("SELECT * FROM gift_cards WHERE code = ? AND tenant_id = ?")
      .get(body.code as string, config.tenantId ?? "") as Record<string, unknown> | undefined;

    if (!card) {
      reply.status(404);
      return { error: "Gift card not found" };
    }

    if (card.is_active !== 1) {
      reply.status(400);
      return { error: "Gift card is not active" };
    }

    const balance = Number(card.current_balance ?? 0);
    const amount = Number(body.amount ?? 0);

    if (amount > balance) {
      reply.status(400);
      return { error: "Insufficient balance", balance };
    }

    const newBalance = balance - amount;

    transaction((txDb) => {
      txDb.prepare("UPDATE gift_cards SET current_balance = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newBalance, card.id);

      // Queue for sync
      txDb.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('gift_card', ?, 'redeem', ?, 10, datetime('now'))
      `).run(card.id as string, JSON.stringify({ cardId: card.id, code: body.code, amount, newBalance, saleId: body.saleId }));
    });

    return { success: true, previousBalance: balance, newBalance, amountDeducted: amount };
  });

  // Check coupon code validity
  app.get("/api/coupons/validate", async (req, reply) => {
    const { code } = req.query as Record<string, string>;
    if (!code) {
      reply.status(400);
      return { error: "Code is required" };
    }

    const db = getDb();
    const coupon = db.prepare("SELECT * FROM coupon_codes WHERE code = ? AND tenant_id = ?")
      .get(code, config.tenantId ?? "") as Record<string, unknown> | undefined;

    if (!coupon) {
      reply.status(404);
      return { error: "Coupon not found" };
    }

    if (coupon.is_active !== 1) {
      reply.status(400);
      return { error: "Coupon is inactive" };
    }

    // Check usage limits
    const maxUses = Number(coupon.max_uses ?? 0);
    const currentUses = Number(coupon.current_uses ?? 0);
    if (maxUses > 0 && currentUses >= maxUses) {
      reply.status(400);
      return { error: "Coupon usage limit reached" };
    }

    return { valid: true, coupon };
  });
}
