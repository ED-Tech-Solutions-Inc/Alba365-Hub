import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerTaxRoutes(app: FastifyInstance) {
  app.get("/api/taxes", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM tax_types WHERE tenant_id = ? AND is_active = 1")
      .all(config.tenantId ?? "");
  });

  app.get("/api/location-taxes", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM location_taxes WHERE location_id = ? AND is_active = 1")
      .all(config.locationId ?? "");
  });

  app.get("/api/location-category-taxes", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM location_category_taxes WHERE location_id = ?")
      .all(config.locationId ?? "");
  });
}
