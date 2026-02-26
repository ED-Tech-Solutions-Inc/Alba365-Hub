import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

export function registerPizzaRoutes(app: FastifyInstance) {
  // Get full pizza configuration (module config + location config + all reference data)
  app.get("/api/pizza/config", async () => {
    const db = getDb();

    const moduleConfig = db.prepare("SELECT * FROM pizza_module_config WHERE tenant_id = ?").get(config.tenantId ?? "");
    const locationConfig = db.prepare("SELECT * FROM pizza_location_config WHERE location_id = ?").get(config.locationId ?? "");
    const sizes = db.prepare("SELECT * FROM pizza_sizes WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(config.tenantId ?? "");
    const crusts = db.prepare("SELECT * FROM pizza_crusts WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(config.tenantId ?? "");
    const sauces = db.prepare("SELECT * FROM pizza_sauces WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(config.tenantId ?? "");
    const cheeses = db.prepare("SELECT * FROM pizza_cheeses WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(config.tenantId ?? "");
    const toppings = db.prepare("SELECT * FROM pizza_toppings WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(config.tenantId ?? "");
    const toppingCategories = db.prepare("SELECT * FROM pizza_topping_categories WHERE tenant_id = ? ORDER BY sort_order").all(config.tenantId ?? "");

    // Pricing matrices
    const sizePrices = db.prepare("SELECT * FROM pizza_size_prices WHERE tenant_id = ?").all(config.tenantId ?? "");
    const toppingPrices = db.prepare("SELECT * FROM pizza_topping_prices WHERE tenant_id = ?").all(config.tenantId ?? "");
    const crustPrices = db.prepare("SELECT * FROM pizza_crust_prices WHERE tenant_id = ?").all(config.tenantId ?? "");
    const saucePrices = db.prepare("SELECT * FROM pizza_sauce_prices WHERE tenant_id = ?").all(config.tenantId ?? "");
    const cheesePrices = db.prepare("SELECT * FROM pizza_cheese_prices WHERE tenant_id = ?").all(config.tenantId ?? "");

    return {
      moduleConfig: moduleConfig ?? null,
      locationConfig: locationConfig ?? null,
      sizes,
      crusts,
      sauces,
      cheeses,
      toppings,
      toppingCategories,
      sizePrices,
      toppingPrices,
      crustPrices,
      saucePrices,
      cheesePrices,
    };
  });

  // Individual endpoints for partial refreshes
  app.get("/api/pizza/sizes", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM pizza_sizes WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.tenantId ?? "");
  });

  app.get("/api/pizza/toppings", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM pizza_toppings WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order")
      .all(config.tenantId ?? "");
  });

  app.get("/api/pizza/topping-prices", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM pizza_topping_prices WHERE tenant_id = ?")
      .all(config.tenantId ?? "");
  });
}
