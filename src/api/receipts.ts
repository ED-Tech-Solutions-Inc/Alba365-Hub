import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerReceiptRoutes(app: FastifyInstance) {
  // Get location settings (needed for receipts, business name, address, etc.)
  app.get("/api/location-settings", async () => {
    const db = getDb();
    const settings = db.prepare("SELECT * FROM location_settings WHERE location_id = ?")
      .get(config.locationId ?? "");
    return settings ?? {};
  });

  // Get printers for this terminal
  app.get("/api/printers", async () => {
    const db = getDb();

    // Return all location printers — terminal-printer mapping is done client-side
    // based on terminal settings from bootstrap
    return db.prepare(`
      SELECT * FROM location_settings WHERE location_id = ? AND key LIKE 'printer_%'
    `).all(config.locationId ?? "");
  });

  // Get business hours
  app.get("/api/business-hours", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM location_business_hours WHERE location_id = ? ORDER BY day_of_week")
      .all(config.locationId ?? "");
  });

  // Get note presets (quick notes for orders/items)
  app.get("/api/note-presets", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM note_presets WHERE location_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.locationId ?? "");
  });

  // Get post codes (delivery zones)
  app.get("/api/post-codes", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM post_codes WHERE location_id = ?")
      .all(config.locationId ?? "");
  });
}
