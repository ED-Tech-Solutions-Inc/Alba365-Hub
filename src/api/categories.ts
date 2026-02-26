import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerCategoryRoutes(app: FastifyInstance) {
  app.get("/api/categories", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name")
      .all(config.tenantId ?? "");
  });

  app.get("/api/categories/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const category = db.prepare("SELECT * FROM categories WHERE id = ? AND tenant_id = ?").get(id, config.tenantId ?? "");
    if (!category) {
      reply.status(404);
      return { error: "Category not found" };
    }
    return category;
  });
}
