import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerDealRoutes(app: FastifyInstance) {
  // List active deals
  app.get("/api/deals", async () => {
    const db = getDb();
    const deals = db.prepare(`
      SELECT * FROM deals WHERE tenant_id = ? AND is_active = 1
      ORDER BY sort_order, name
    `).all(config.tenantId ?? "");

    // Attach items, time restrictions, and size prices for each deal
    const getItems = db.prepare("SELECT * FROM deal_items WHERE deal_id = ?");
    const getRestrictions = db.prepare("SELECT * FROM deal_time_restrictions WHERE deal_id = ?");
    const getSizePrices = db.prepare("SELECT * FROM deal_size_prices WHERE deal_id = ?");
    const getSizeOrderTypePrices = db.prepare("SELECT * FROM deal_size_order_type_prices WHERE deal_id = ?");

    return (deals as Array<Record<string, unknown>>).map((deal) => ({
      ...deal,
      items: getItems.all(deal.id as string),
      timeRestrictions: getRestrictions.all(deal.id as string),
      sizePrices: getSizePrices.all(deal.id as string),
      sizeOrderTypePrices: getSizeOrderTypePrices.all(deal.id as string),
    }));
  });

  // Get single deal with all related data
  app.get("/api/deals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const deal = db.prepare("SELECT * FROM deals WHERE id = ? AND tenant_id = ?").get(id, config.tenantId ?? "");
    if (!deal) {
      reply.status(404);
      return { error: "Deal not found" };
    }

    const items = db.prepare("SELECT * FROM deal_items WHERE deal_id = ?").all(id);
    const timeRestrictions = db.prepare("SELECT * FROM deal_time_restrictions WHERE deal_id = ?").all(id);
    const sizePrices = db.prepare("SELECT * FROM deal_size_prices WHERE deal_id = ?").all(id);
    const sizeOrderTypePrices = db.prepare("SELECT * FROM deal_size_order_type_prices WHERE deal_id = ?").all(id);

    return { ...(deal as Record<string, unknown>), items, timeRestrictions, sizePrices, sizeOrderTypePrices };
  });
}
