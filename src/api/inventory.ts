import type { FastifyInstance } from "fastify";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

export function registerInventoryRoutes(app: FastifyInstance) {
  // Get inventory levels for this location
  app.get("/api/inventory", async (req) => {
    const db = getDb();
    const { productId } = req.query as Record<string, string>;

    if (productId) {
      return db.prepare("SELECT * FROM inventory_levels WHERE location_id = ? AND product_id = ?")
        .get(config.locationId ?? "", productId);
    }

    return db.prepare("SELECT * FROM inventory_levels WHERE location_id = ?")
      .all(config.locationId ?? "");
  });

  // Deduct inventory (after sale)
  app.post("/api/inventory/deduct", async (req) => {
    const body = req.body as { items: Array<{ productId: string; variantId?: string; quantity: number }>; saleId?: string };

    transaction((db) => {
      for (const item of body.items) {
        db.prepare(`
          UPDATE inventory_levels SET quantity = quantity - ?, updated_at = datetime('now')
          WHERE location_id = ? AND product_id = ? AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
        `).run(item.quantity, config.locationId ?? "", item.productId, item.variantId ?? null, item.variantId ?? null);
      }

      // Queue for cloud sync
      const deductId = generateId();
      db.prepare(`
        INSERT INTO outbox_queue (entity_type, entity_id, action, payload, priority, created_at)
        VALUES ('inventory', ?, 'deduct', ?, 5, datetime('now'))
      `).run(deductId, JSON.stringify({ items: body.items, saleId: body.saleId, locationId: config.locationId }));
    });

    return { success: true };
  });

  // Check stock availability
  app.post("/api/inventory/check", async (req) => {
    const body = req.body as { items: Array<{ productId: string; variantId?: string; quantity: number }> };
    const db = getDb();

    const results = body.items.map((item) => {
      const level = db.prepare(`
        SELECT quantity, track_inventory FROM inventory_levels
        WHERE location_id = ? AND product_id = ? AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
      `).get(config.locationId ?? "", item.productId, item.variantId ?? null, item.variantId ?? null) as
        { quantity: number; track_inventory: number } | undefined;

      if (!level || !level.track_inventory) {
        return { productId: item.productId, available: true, quantity: null };
      }

      return {
        productId: item.productId,
        available: level.quantity >= item.quantity,
        quantity: level.quantity,
      };
    });

    return results;
  });
}
