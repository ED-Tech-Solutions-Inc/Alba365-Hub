import type { FastifyInstance } from "fastify";
import { getDb, clampLimit, clampOffset } from "../db/index.js";
import { config } from "../config.js";

export function registerProductRoutes(app: FastifyInstance) {
  const tenantId = () => config.tenantId ?? "";

  app.get("/api/products", async (req) => {
    const db = getDb();
    const { categoryId, search, limit, offset } = req.query as Record<string, string>;

    let sql = "SELECT * FROM products WHERE tenant_id = ? AND is_active = 1";
    const params: unknown[] = [tenantId()];

    if (categoryId) {
      sql += " AND category_id = ?";
      params.push(categoryId);
    }
    if (search) {
      sql += " AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)";
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += " ORDER BY sort_order, name LIMIT ? OFFSET ?";
    params.push(clampLimit(limit, 500), clampOffset(offset));

    return db.prepare(sql).all(...params);
  });

  app.get("/api/products/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const product = db.prepare("SELECT * FROM products WHERE id = ? AND tenant_id = ?").get(id, tenantId());
    if (!product) {
      reply.status(404);
      return { error: "Product not found" };
    }

    // Include variants
    const variants = db.prepare("SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order").all(id);
    const modifierGroups = db.prepare(`
      SELECT mg.*, pmg.priority, pmg.is_required, pmg.free_selections_override
      FROM product_modifier_groups pmg
      JOIN modifier_groups mg ON mg.id = pmg.modifier_group_id
      WHERE pmg.product_id = ?
      ORDER BY pmg.priority
    `).all(id);

    return { ...(product as Record<string, unknown>), variants, modifierGroups };
  });

  app.get("/api/product-variants/:productId", async (req) => {
    const { productId } = req.params as { productId: string };
    const db = getDb();
    return db.prepare("SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order").all(productId);
  });
}
