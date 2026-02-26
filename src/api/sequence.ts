import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerSequenceRoutes(app: FastifyInstance) {
  // Get next order number (atomic increment)
  app.post("/api/sequence/next-order", async () => {
    const db = getDb();
    const locationId = config.locationId ?? "";

    // Atomic increment using INSERT OR REPLACE
    db.prepare(`
      INSERT INTO sequences (location_id, sequence_name, current_value)
      VALUES (?, 'order_number', 1)
      ON CONFLICT(location_id, sequence_name)
      DO UPDATE SET current_value = current_value + 1
    `).run(locationId);

    const row = db.prepare(
      "SELECT current_value FROM sequences WHERE location_id = ? AND sequence_name = 'order_number'"
    ).get(locationId) as { current_value: number } | undefined;

    return { orderNumber: row?.current_value ?? 1 };
  });

  // Get next receipt number
  app.post("/api/sequence/next-receipt", async () => {
    const db = getDb();
    const locationId = config.locationId ?? "";

    db.prepare(`
      INSERT INTO sequences (location_id, sequence_name, current_value)
      VALUES (?, 'receipt_number', 1)
      ON CONFLICT(location_id, sequence_name)
      DO UPDATE SET current_value = current_value + 1
    `).run(locationId);

    const row = db.prepare(
      "SELECT current_value FROM sequences WHERE location_id = ? AND sequence_name = 'receipt_number'"
    ).get(locationId) as { current_value: number } | undefined;

    return { receiptNumber: row?.current_value ?? 1 };
  });

  // Get current sequence value (no increment)
  app.get("/api/sequence/:name", async (req) => {
    const { name } = req.params as { name: string };
    const db = getDb();
    const locationId = config.locationId ?? "";

    const row = db.prepare(
      "SELECT current_value FROM sequences WHERE location_id = ? AND sequence_name = ?"
    ).get(locationId, name) as { current_value: number } | undefined;

    return { value: row?.current_value ?? 0 };
  });
}
