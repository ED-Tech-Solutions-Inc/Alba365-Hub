import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";

/**
 * Bootstrap endpoint — returns ALL data needed for Flutter POS boot in a single request.
 * Replaces 10+ individual API calls, cutting boot time to one round-trip.
 */
export function registerBootstrapRoutes(app: FastifyInstance) {
  app.get("/api/bootstrap", async (req) => {
    const db = getDb();
    const tenantId = config.tenantId ?? "";
    const locationId = config.locationId ?? "";
    const { terminalId } = req.query as Record<string, string>;

    // All queries run against local SQLite — instant, no network
    const products = db.prepare("SELECT *, base_price AS price, is_weighable AS is_weight_based, weight_unit, pricing_strategy, CASE WHEN product_type = 'PIZZA' THEN 1 ELSE 0 END AS is_pizza FROM products WHERE tenant_id = ? AND is_active = 1 ORDER BY name").all(tenantId);
    const productVariants = db.prepare("SELECT * FROM product_variants WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const productOrderTypePrices = db.prepare("SELECT * FROM product_order_type_prices WHERE tenant_id = ?").all(tenantId);
    const variantOrderTypePrices = db.prepare("SELECT * FROM variant_order_type_prices WHERE tenant_id = ?").all(tenantId);
    const categories = db.prepare("SELECT * FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order").all(tenantId);
    const taxTypes = db.prepare("SELECT * FROM tax_types WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const locationTaxes = db.prepare("SELECT * FROM location_taxes WHERE location_id = ? AND is_active = 1").all(locationId);
    const locationCategoryTaxes = db.prepare("SELECT * FROM location_category_taxes WHERE location_id = ?").all(locationId);
    const customers = db.prepare("SELECT * FROM customers WHERE tenant_id = ?").all(tenantId);
    const discountTemplates = db.prepare("SELECT * FROM discount_templates WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const deals = db.prepare("SELECT * FROM deals WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const dealItems = db.prepare("SELECT di.* FROM deal_items di JOIN deals d ON d.id = di.deal_id WHERE di.tenant_id = ? AND d.is_active = 1").all(tenantId);
    const dealTimeRestrictions = db.prepare("SELECT dtr.* FROM deal_time_restrictions dtr JOIN deals d ON d.id = dtr.deal_id WHERE d.tenant_id = ? AND d.is_active = 1").all(tenantId);
    const dealSizePrices = db.prepare("SELECT dsp.* FROM deal_size_prices dsp JOIN deals d ON d.id = dsp.deal_id WHERE d.tenant_id = ? AND d.is_active = 1").all(tenantId);
    const dealSizeOrderTypePrices = db.prepare(`
      SELECT dsop.* FROM deal_size_order_type_prices dsop
      JOIN deal_size_prices dsp ON dsp.id = dsop.size_price_id
      JOIN deals d ON d.id = dsp.deal_id
      WHERE d.tenant_id = ? AND d.is_active = 1
    `).all(tenantId);
    const giftCards = db.prepare("SELECT id, code, current_balance, is_active, expires_at FROM gift_cards WHERE tenant_id = ? AND is_active = 1 AND current_balance > 0").all(tenantId);
    const couponCodes = db.prepare("SELECT * FROM coupon_codes WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const modifierGroups = db.prepare("SELECT *, min_qty AS min_selections, max_qty AS max_selections FROM modifier_groups WHERE tenant_id = ?").all(tenantId);
    const modifiers = db.prepare(`
      SELECT m.*, m.price_adjustment AS price FROM modifiers m
      JOIN modifier_groups mg ON mg.id = m.modifier_group_id
      WHERE mg.tenant_id = ? AND m.is_active = 1
    `).all(tenantId);
    const productModifierGroups = db.prepare(`
      SELECT pmg.product_id, pmg.modifier_group_id, pmg.priority,
             MAX(pmg.is_required) AS is_required, pmg.free_selections_override
      FROM product_modifier_groups pmg
      JOIN products p ON p.id = pmg.product_id
      WHERE p.tenant_id = ?
      GROUP BY pmg.product_id, pmg.modifier_group_id
    `).all(tenantId);
    const productKits = db.prepare("SELECT * FROM product_kits WHERE tenant_id = ? AND is_active = 1").all(tenantId);
    const productKitItems = db.prepare(`
      SELECT pki.* FROM product_kit_items pki
      JOIN product_kits pk ON pk.id = pki.kit_id
      WHERE pk.tenant_id = ? AND pk.is_active = 1
    `).all(tenantId);
    const locationProductOverrides = db.prepare("SELECT * FROM location_product_overrides WHERE location_id = ?").all(locationId);
    const notePresets = db.prepare("SELECT * FROM note_presets WHERE location_id = ? ORDER BY sort_order").all(locationId);
    const postCodes = db.prepare("SELECT * FROM post_codes WHERE tenant_id = ?").all(tenantId);

    // Location settings
    const locationSettings = db.prepare("SELECT * FROM location_settings WHERE location_id = ?").get(locationId);
    const businessHours = db.prepare("SELECT * FROM location_business_hours WHERE location_id = ?").all(locationId);

    // Restaurant tables & floors
    const floors = db.prepare("SELECT * FROM floors WHERE location_id = ? AND is_active = 1").all(locationId);
    const areas = db.prepare(`
      SELECT a.* FROM areas a
      JOIN floors f ON f.id = a.floor_id
      WHERE f.location_id = ? AND f.is_active = 1
    `).all(locationId);
    const tables = db.prepare(`
      SELECT t.* FROM tables t
      JOIN areas a ON a.id = t.area_id
      JOIN floors f ON f.id = a.floor_id
      WHERE f.location_id = ? AND f.is_active = 1 AND t.is_active = 1
    `).all(locationId);
    const courses = db.prepare("SELECT * FROM courses WHERE location_id = ? ORDER BY sort_order").all(locationId);

    // Pizza module
    const pizzaLocationConfig = db.prepare("SELECT * FROM pizza_location_config WHERE location_id = ?").get(locationId);
    let pizzaConfig = null;
    if (pizzaLocationConfig) {
      const plc = pizzaLocationConfig as { config_id: string; tenant_id: string };
      pizzaConfig = {
        locationConfig: pizzaLocationConfig,
        sizes: db.prepare("SELECT * FROM pizza_sizes WHERE config_id = ? AND is_active = 1 ORDER BY sort_order").all(plc.config_id),
        crusts: db.prepare("SELECT * FROM pizza_crusts WHERE config_id = ? AND is_active = 1 ORDER BY sort_order").all(plc.config_id),
        sauces: db.prepare("SELECT * FROM pizza_sauces WHERE config_id = ? AND is_active = 1 ORDER BY sort_order").all(plc.config_id),
        cheeses: db.prepare("SELECT * FROM pizza_cheeses WHERE config_id = ? AND is_active = 1 ORDER BY sort_order").all(plc.config_id),
        toppings: db.prepare("SELECT * FROM pizza_toppings WHERE config_id = ? AND is_active = 1 ORDER BY sort_order").all(plc.config_id),
        toppingCategories: db.prepare("SELECT * FROM pizza_topping_categories WHERE config_id = ? ORDER BY sort_order").all(plc.config_id),
        sizePrices: db.prepare("SELECT * FROM pizza_size_prices WHERE tenant_id = ?").all(plc.tenant_id),
        toppingPrices: db.prepare("SELECT * FROM pizza_topping_prices WHERE tenant_id = ?").all(plc.tenant_id),
        crustPrices: db.prepare("SELECT * FROM pizza_crust_prices WHERE tenant_id = ?").all(plc.tenant_id),
        saucePrices: db.prepare("SELECT * FROM pizza_sauce_prices WHERE tenant_id = ?").all(plc.tenant_id),
        cheesePrices: db.prepare("SELECT * FROM pizza_cheese_prices WHERE tenant_id = ?").all(plc.tenant_id),
        productConfigs: db.prepare("SELECT * FROM pizza_product_configs WHERE tenant_id = ?").all(plc.tenant_id),
      };
    }

    // Category schedules & price schedules
    const categorySchedules = db.prepare("SELECT * FROM category_schedules WHERE location_id = ?").all(locationId);
    const priceSchedules = db.prepare("SELECT * FROM price_schedules WHERE location_id = ?").all(locationId);

    // Users (staff for this location)
    const users = db.prepare("SELECT id, name, email, role, permissions, max_discount FROM users WHERE tenant_id = ? AND is_active = 1").all(tenantId);

    // Terminal settings (for the specific terminal requesting bootstrap)
    const terminalSettings = terminalId
      ? db.prepare("SELECT * FROM terminal_settings WHERE terminal_id = ?").get(terminalId)
      : null;

    return {
      products,
      productVariants,
      productOrderTypePrices,
      variantOrderTypePrices,
      categories,
      taxTypes,
      locationTaxes,
      locationCategoryTaxes,
      customers,
      discountTemplates,
      deals,
      dealItems,
      dealTimeRestrictions,
      dealSizePrices,
      dealSizeOrderTypePrices,
      giftCards,
      couponCodes,
      modifierGroups,
      modifiers,
      productModifierGroups,
      productKits,
      productKitItems,
      locationProductOverrides,
      notePresets,
      postCodes,
      locationSettings,
      businessHours,
      floors,
      areas,
      tables,
      courses,
      pizzaConfig,
      categorySchedules,
      priceSchedules,
      users,
      terminalSettings,
      // Metadata
      _meta: {
        hubVersion: "0.1.0",
        locationId,
        tenantId,
        generatedAt: new Date().toISOString(),
      },
    };
  });
}
