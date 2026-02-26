import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerModifierRoutes(app: FastifyInstance) {
  // List all modifier groups with their modifiers
  app.get("/api/modifier-groups", async () => {
    const db = getDb();
    const groups = db.prepare("SELECT * FROM modifier_groups WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name")
      .all(config.tenantId ?? "");

    const getModifiers = db.prepare("SELECT * FROM modifiers WHERE modifier_group_id = ? AND is_active = 1 ORDER BY sort_order, name");

    return (groups as Array<Record<string, unknown>>).map((group) => ({
      ...group,
      modifiers: getModifiers.all(group.id as string),
    }));
  });

  // Get modifier group by ID
  app.get("/api/modifier-groups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const group = db.prepare("SELECT * FROM modifier_groups WHERE id = ? AND tenant_id = ?").get(id, config.tenantId ?? "");
    if (!group) {
      reply.status(404);
      return { error: "Modifier group not found" };
    }

    const modifiers = db.prepare("SELECT * FROM modifiers WHERE modifier_group_id = ? AND is_active = 1 ORDER BY sort_order, name").all(id);
    return { ...(group as Record<string, unknown>), modifiers };
  });

  // Get product modifier groups (which modifier groups apply to a product)
  app.get("/api/products/:productId/modifier-groups", async (req) => {
    const { productId } = req.params as { productId: string };
    const db = getDb();

    return db.prepare(`
      SELECT pmg.*, mg.name as group_name, mg.min_selections, mg.max_selections, mg.is_required
      FROM product_modifier_groups pmg
      JOIN modifier_groups mg ON mg.id = pmg.modifier_group_id
      WHERE pmg.product_id = ? AND mg.is_active = 1
      ORDER BY pmg.sort_order
    `).all(productId);
  });

  // Get product kits (combo items)
  app.get("/api/product-kits/:productId", async (req) => {
    const { productId } = req.params as { productId: string };
    const db = getDb();

    const kits = db.prepare("SELECT * FROM product_kits WHERE product_id = ?").all(productId);
    const getKitItems = db.prepare("SELECT * FROM product_kit_items WHERE product_kit_id = ? ORDER BY sort_order");

    return (kits as Array<Record<string, unknown>>).map((kit) => ({
      ...kit,
      items: getKitItems.all(kit.id as string),
    }));
  });
}
