import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { getCloudClient } from "./cloud-client.js";

interface SyncState {
  entity_type: string;
  last_synced_at: string | null;
  last_sync_cursor: string | null;
  record_count: number;
}

interface PullResult {
  entity: string;
  pulled: number;
  errors: string[];
}

/** Standard paginated response from cloud sync endpoints */
interface PaginatedResponse {
  items: Array<Record<string, unknown>>;
  deletedIds?: string[];
  hasMore?: boolean;
  nextCursor?: string;
  version?: string;
  totalCount?: number;
}

/**
 * Convert camelCase string to snake_case.
 * e.g. "tenantId" → "tenant_id", "isActive" → "is_active"
 */
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert all keys of an object from camelCase to snake_case.
 */
function convertKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[camelToSnake(key)] = value;
  }
  return result;
}

/**
 * Extract items from a paginated cloud response.
 * Cloud endpoints return { items: [...], hasMore, nextCursor, ... }
 */
function extractItems(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as PaginatedResponse).items;
    return Array.isArray(items) ? items : [];
  }
  return [];
}

/**
 * Transform cloud response items: convert camelCase keys to snake_case
 * and apply optional field renames/transforms.
 */
function transformItems(
  items: Array<Record<string, unknown>>,
  fieldMap?: Record<string, string | ((item: Record<string, unknown>) => unknown)>,
): Array<Record<string, unknown>> {
  return items.map((item) => {
    // First convert all keys to snake_case
    const converted = convertKeys(item);

    // Apply custom field mappings (renames or transforms)
    if (fieldMap) {
      for (const [targetCol, sourceOrFn] of Object.entries(fieldMap)) {
        if (typeof sourceOrFn === "function") {
          converted[targetCol] = sourceOrFn(item);
        } else {
          // sourceOrFn is the camelCase source field name
          const snakeSource = camelToSnake(sourceOrFn);
          if (snakeSource in converted) {
            converted[targetCol] = converted[snakeSource];
            if (targetCol !== snakeSource) delete converted[snakeSource];
          } else if (sourceOrFn in item) {
            converted[targetCol] = item[sourceOrFn];
          }
        }
      }
    }

    // Convert booleans to integers for SQLite
    for (const [key, val] of Object.entries(converted)) {
      if (typeof val === "boolean") {
        converted[key] = val ? 1 : 0;
      }
      // Stringify arrays/objects for TEXT columns
      if (val !== null && typeof val === "object") {
        converted[key] = JSON.stringify(val);
      }
    }

    return converted;
  });
}

/**
 * Pull sync engine — downloads reference data from cloud PostgreSQL into local SQLite.
 * Uses cursor-based incremental sync (updatedAt > lastSyncedAt).
 */
export class PullSyncEngine {
  private cloudClient = getCloudClient();
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Start periodic pull sync
   */
  start(intervalMs = 60_000) {
    if (this.intervalId) return;

    console.log(`[PullSync] Starting periodic sync every ${intervalMs / 1000}s`);

    // Run immediately, then on interval
    this.runFullSync().catch((err) => console.error("[PullSync] Initial sync failed:", err));

    this.intervalId = setInterval(() => {
      this.runFullSync().catch((err) => console.error("[PullSync] Periodic sync failed:", err));
    }, intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[PullSync] Stopped");
    }
  }

  /**
   * Run full incremental sync for all entity types
   */
  async runFullSync(): Promise<PullResult[]> {
    if (this.running) {
      console.log("[PullSync] Already running, skipping");
      return [];
    }

    if (!this.cloudClient.isConfigured()) {
      console.log("[PullSync] Cloud client not configured, skipping");
      return [];
    }

    this.running = true;
    const results: PullResult[] = [];

    try {
      console.log("[PullSync] Starting full sync...");

      // Pull in dependency order — referenced tables first
      const entities = [
        { name: "categories", pull: () => this.pullCategories() },
        { name: "products", pull: () => this.pullProducts() },
        { name: "product_variants", pull: () => this.pullProductVariants() },
        { name: "tax_types", pull: () => this.pullTaxTypes() },
        { name: "location_taxes", pull: () => this.pullLocationTaxes() },
        { name: "location_category_taxes", pull: () => this.pullLocationCategoryTaxes() },
        { name: "customers", pull: () => this.pullCustomers() },
        { name: "modifier_groups", pull: () => this.pullModifierGroups() },
        { name: "modifiers", pull: () => this.pullModifiers() },
        { name: "product_modifier_groups", pull: () => this.pullProductModifierGroups() },
        { name: "discount_templates", pull: () => this.pullDiscountTemplates() },
        { name: "gift_cards", pull: () => this.pullGiftCards() },
        { name: "coupon_codes", pull: () => this.pullCouponCodes() },
        { name: "deals", pull: () => this.pullDeals() },
        { name: "deal_items", pull: () => this.pullDealItems() },
        { name: "deal_time_restrictions", pull: () => this.pullDealTimeRestrictions() },
        { name: "deal_size_prices", pull: () => this.pullDealSizePrices() },
        { name: "users", pull: () => this.pullUsers() },
        { name: "location_settings", pull: () => this.pullLocationSettings() },
        { name: "terminal_settings", pull: () => this.pullTerminalSettings() },
        { name: "floors", pull: () => this.pullFloors() },
        { name: "areas", pull: () => this.pullAreas() },
        { name: "tables", pull: () => this.pullTables() },
        { name: "courses", pull: () => this.pullCourses() },
        { name: "note_presets", pull: () => this.pullNotePresets() },
        { name: "location_product_overrides", pull: () => this.pullLocationProductOverrides() },
        { name: "pizza_size_prices", pull: () => this.pullPizzaSizePrices() },
        { name: "pizza_topping_prices", pull: () => this.pullPizzaToppingPrices() },
        { name: "pizza_crust_prices", pull: () => this.pullPizzaCrustPrices() },
        { name: "pizza_sauce_prices", pull: () => this.pullPizzaSaucePrices() },
        { name: "pizza_cheese_prices", pull: () => this.pullPizzaCheesesPrices() },
        { name: "pizza_size_order_type_prices", pull: () => this.pullPizzaSizeOrderTypePrices() },
        { name: "pizza_location_config", pull: () => this.pullPizzaLocationConfig() },
        { name: "roles", pull: () => this.pullRoles() },
        { name: "inventory_levels", pull: () => this.pullInventoryLevels() },
        { name: "post_codes", pull: () => this.pullPostCodes() },
        { name: "customer_addresses", pull: () => this.pullCustomerAddresses() },
        { name: "category_schedules", pull: () => this.pullCategorySchedules() },
        { name: "price_schedules", pull: () => this.pullPriceSchedules() },
        { name: "deal_size_order_type_prices", pull: () => this.pullDealSizeOrderTypePrices() },
        { name: "location_business_hours", pull: () => this.pullLocationBusinessHours() },
        { name: "web_order_settings", pull: () => this.pullWebOrderSettings() },
        { name: "caller_id_config", pull: () => this.pullCallerIdConfig() },
        { name: "caller_id_lines", pull: () => this.pullCallerIdLines() },
        { name: "cash_drawers", pull: () => this.pullCashDrawers() },
        { name: "cash_drawer_transactions", pull: () => this.pullCashDrawerTransactions() },
        { name: "staff_banks", pull: () => this.pullStaffBanks() },
        { name: "staff_bank_transactions", pull: () => this.pullStaffBankTransactions() },
        { name: "store_credits", pull: () => this.pullStoreCredits() },
        { name: "kitchen_orders", pull: () => this.pullKitchenOrders() },
        { name: "kitchen_order_items", pull: () => this.pullKitchenOrderItems() },
        { name: "sales", pull: () => this.pullSales() },
        { name: "sale_items", pull: () => this.pullSaleItems() },
      ];

      for (const entity of entities) {
        try {
          const result = await entity.pull();
          results.push(result);
          if (result.pulled > 0) {
            console.log(`[PullSync] ${entity.name}: ${result.pulled} records`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          results.push({ entity: entity.name, pulled: 0, errors: [msg] });
          console.error(`[PullSync] ${entity.name} failed: ${msg}`);
        }
      }

      const totalPulled = results.reduce((sum, r) => sum + r.pulled, 0);
      console.log(`[PullSync] Completed. ${totalPulled} total records synced.`);
    } finally {
      this.running = false;
    }

    return results;
  }

  // --- Helper: Get sync state for an entity ---
  private getSyncState(entityType: string): SyncState {
    const db = getDb();
    const row = db.prepare("SELECT * FROM sync_state WHERE entity_type = ?").get(entityType) as SyncState | undefined;
    return row ?? { entity_type: entityType, last_synced_at: null, last_sync_cursor: null, record_count: 0 };
  }

  // --- Helper: Update sync state after successful pull ---
  private updateSyncState(entityType: string, recordCount: number) {
    const db = getDb();
    db.prepare(`
      INSERT INTO sync_state (entity_type, last_synced_at, record_count, status, updated_at)
      VALUES (?, datetime('now'), ?, 'SUCCESS', datetime('now'))
      ON CONFLICT(entity_type) DO UPDATE SET
        last_synced_at = datetime('now'),
        record_count = ?,
        status = 'SUCCESS',
        updated_at = datetime('now')
    `).run(entityType, recordCount, recordCount);
  }

  // --- Helper: Generic upsert for reference data ---
  private upsertRows(tableName: string, rows: Array<Record<string, unknown>>, columns: string[]) {
    if (rows.length === 0) return 0;

    const db = getDb();
    const placeholders = columns.map(() => "?").join(", ");
    const updateCols = columns.filter((c) => c !== "id").map((c) => `"${c}" = excluded."${c}"`).join(", ");

    const stmt = db.prepare(`
      INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updateCols}
    `);

    const insertMany = db.transaction((items: Array<Record<string, unknown>>) => {
      let count = 0;
      for (const item of items) {
        const values = columns.map((col) => {
          const val = item[col];
          if (val === undefined || val === null) return null;
          if (typeof val === "object") return JSON.stringify(val);
          return val;
        });
        try {
          stmt.run(...values);
          count++;
        } catch (err) {
          // Log per-row errors but continue
          const msg = err instanceof Error ? err.message : "Unknown";
          console.error(`[PullSync] ${tableName} upsert error: ${msg}`);
        }
      }
      return count;
    });

    return insertMany(rows);
  }

  /**
   * Full replace for tables that always pull ALL records (no cursor).
   * Deletes all existing rows then inserts fresh data in a single transaction.
   * Used for pizza price tables where cloud returns duplicate IDs across syncs.
   */
  private replaceTable(tableName: string, rows: Array<Record<string, unknown>>, columns: string[]) {
    if (rows.length === 0) return;

    const db = getDb();
    const placeholders = columns.map(() => "?").join(", ");
    const colNames = columns.map(c => `"${c}"`).join(", ");
    const insertStmt = db.prepare(`INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`);

    db.transaction(() => {
      db.prepare(`DELETE FROM "${tableName}"`).run();
      for (const item of rows) {
        const values = columns.map((col) => {
          const val = item[col];
          if (val === undefined || val === null) return null;
          if (typeof val === "object") return JSON.stringify(val);
          return val;
        });
        try {
          insertStmt.run(...values);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          console.error(`[PullSync] ${tableName} insert error: ${msg}`);
        }
      }
    })();
  }

  /**
   * Fetch paginated items from a cloud endpoint.
   * Extracts items, converts camelCase → snake_case, applies field mappings.
   */
  private async fetchAndTransform(
    path: string,
    params: Record<string, string>,
    fieldMap?: Record<string, string | ((item: Record<string, unknown>) => unknown)>,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await this.cloudClient.get<PaginatedResponse>(path, params);
    if (!res.ok) {
      if (res.status === 404) return []; // Endpoint doesn't exist yet
      throw new Error(res.error ?? `HTTP ${res.status}`);
    }
    const items = extractItems(res.data);
    return transformItems(items, fieldMap);
  }

  // ===================================================================
  // Pull implementations for each entity type
  // ===================================================================

  private async pullCategories(): Promise<PullResult> {
    const state = this.getSyncState("categories");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const rows = await this.fetchAndTransform("/api/hub/sync/categories", params, {
      // cloud "imageUrl" → snake "image_url" (handled automatically)
      // description is not sent by cloud, defaults to null
    });

    const count = this.upsertRows("categories", rows, [
      "id", "tenant_id", "name", "parent_id", "sort_order", "color", "image_url", "is_active",
    ]);

    this.updateSyncState("categories", count);
    return { entity: "categories", pulled: count, errors: [] };
  }

  private async pullProducts(): Promise<PullResult> {
    const state = this.getSyncState("products");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/products", params);
    if (!res.ok) return { entity: "products", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);

    // Map cloud fields → SQLite columns
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      name: item.name,
      sku: item.sku ?? null,
      barcode: item.barcode ?? null,
      category_id: item.categoryId ?? null,
      description: item.description ?? null,
      base_price: item.price ?? 0,
      cost_price: item.cost ?? 0,
      tax_type_ids: item.taxTypeIds ? JSON.stringify(item.taxTypeIds) : "[]",
      product_type: item.productType ?? "STANDARD",
      is_active: item.isActive ? 1 : 0,
      track_inventory: item.trackInventory ? 1 : 0,
      image_url: item.imageUrl ?? null,
      sort_order: item.sortOrder ?? 0,
      metadata: item.metadata ? JSON.stringify(item.metadata) : "{}",
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("products", rows, [
      "id", "tenant_id", "name", "sku", "barcode", "category_id", "description",
      "base_price", "cost_price", "tax_type_ids", "product_type",
      "is_active", "track_inventory", "image_url", "sort_order", "metadata",
      "created_at", "updated_at",
    ]);

    // Also extract and upsert product_order_type_prices from embedded data
    const otpRows: Array<Record<string, unknown>> = [];
    for (const item of rawItems) {
      const otps = item.orderTypePrices as Array<{ orderType: string; price: number }> | undefined;
      if (otps && Array.isArray(otps)) {
        for (const otp of otps) {
          otpRows.push({
            id: `${item.id}_${otp.orderType}`,
            tenant_id: item.tenantId,
            product_id: item.id,
            order_type: otp.orderType,
            price: otp.price,
          });
        }
      }
    }
    if (otpRows.length > 0) {
      this.upsertRows("product_order_type_prices", otpRows, [
        "id", "tenant_id", "product_id", "order_type", "price",
      ]);
    }

    // Also extract and upsert pizza_product_configs from embedded data
    const pizzaConfigRows: Array<Record<string, unknown>> = [];
    for (const item of rawItems) {
      const ppc = item.pizzaProductConfig as Record<string, unknown> | null | undefined;
      if (ppc && typeof ppc === "object" && ppc.id) {
        pizzaConfigRows.push({
          id: ppc.id,
          tenant_id: item.tenantId,
          product_id: item.id,
          default_size_id: ppc.defaultSizeId ?? null,
          default_crust_id: ppc.defaultCrustId ?? null,
          default_sauces: ppc.defaultSauces ? JSON.stringify(ppc.defaultSauces) : "[]",
          default_cheeses: ppc.defaultCheeses ? JSON.stringify(ppc.defaultCheeses) : "[]",
          default_toppings: ppc.defaultToppings ? JSON.stringify(ppc.defaultToppings) : "[]",
          free_toppings_count: ppc.freeToppingsCount ?? 0,
          max_toppings: ppc.maxToppings ?? null,
          allow_half_and_half: ppc.allowHalfHalf != null ? (ppc.allowHalfHalf ? 1 : 0) : 1,
          half_and_half_upcharge: ppc.halfAndHalfUpcharge ?? 0,
          is_active: ppc.isActive != null ? (ppc.isActive ? 1 : 0) : 1,
        });
      }
    }
    if (pizzaConfigRows.length > 0) {
      this.upsertRows("pizza_product_configs", pizzaConfigRows, [
        "id", "tenant_id", "product_id", "default_size_id", "default_crust_id",
        "default_sauces", "default_cheeses", "default_toppings",
        "free_toppings_count", "max_toppings", "allow_half_and_half",
        "half_and_half_upcharge", "is_active",
      ]);
    }

    this.updateSyncState("products", count);
    return { entity: "products", pulled: count, errors: [] };
  }

  private async pullProductVariants(): Promise<PullResult> {
    const state = this.getSyncState("product_variants");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const rawItems = await this.fetchAndTransform("/api/hub/sync/product-variants", params);

    // Remap cost → cost_price
    const rows = rawItems.map((item) => ({
      ...item,
      cost_price: item.cost ?? item.cost_price ?? 0,
      is_active: item.is_active ?? 1,
    }));

    const count = this.upsertRows("product_variants", rows, [
      "id", "tenant_id", "product_id", "name", "sku", "barcode", "price", "cost_price",
      "sort_order", "is_active", "created_at", "updated_at",
    ]);

    this.updateSyncState("product_variants", count);
    return { entity: "product_variants", pulled: count, errors: [] };
  }

  private async pullTaxTypes(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/tax-types", params);

    const count = this.upsertRows("tax_types", rows, [
      "id", "tenant_id", "name", "rate", "code", "is_active",
      "created_at", "updated_at",
    ]);

    this.updateSyncState("tax_types", count);
    return { entity: "tax_types", pulled: count, errors: [] };
  }

  private async pullLocationTaxes(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/location-taxes", params);

    const count = this.upsertRows("location_taxes", rows, [
      "id", "location_id", "tax_type_id", "rate", "is_active",
    ]);

    this.updateSyncState("location_taxes", count);
    return { entity: "location_taxes", pulled: count, errors: [] };
  }

  private async pullLocationCategoryTaxes(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/location-category-taxes", params);

    const count = this.upsertRows("location_category_taxes", rows, [
      "id", "location_id", "category_id", "tax_type_id",
    ]);

    this.updateSyncState("location_category_taxes", count);
    return { entity: "location_category_taxes", pulled: count, errors: [] };
  }

  private async pullCustomers(): Promise<PullResult> {
    const state = this.getSyncState("customers");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const rows = await this.fetchAndTransform("/api/hub/sync/customers", params);

    const count = this.upsertRows("customers", rows, [
      "id", "tenant_id", "first_name", "last_name", "email", "phone",
      "address", "city", "province", "postal_code", "notes", "created_at", "updated_at",
    ]);

    this.updateSyncState("customers", count);
    return { entity: "customers", pulled: count, errors: [] };
  }

  private async pullModifierGroups(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/modifier-groups", params);

    const count = this.upsertRows("modifier_groups", rows, [
      "id", "tenant_id", "name", "selection_type", "min_qty", "max_qty",
      "free_selections", "allow_quantity", "created_at", "updated_at",
    ]);

    this.updateSyncState("modifier_groups", count);
    return { entity: "modifier_groups", pulled: count, errors: [] };
  }

  private async pullModifiers(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/modifiers", params);

    const count = this.upsertRows("modifiers", rows, [
      "id", "modifier_group_id", "name", "price_type", "price_adjustment",
      "is_default", "linked_product_id", "sort_order", "is_active",
      "created_at", "updated_at",
    ]);

    this.updateSyncState("modifiers", count);
    return { entity: "modifiers", pulled: count, errors: [] };
  }

  private async pullProductModifierGroups(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/product-modifier-groups", params);

    const count = this.upsertRows("product_modifier_groups", rows, [
      "id", "product_id", "modifier_group_id", "priority", "is_required", "free_selections_override",
    ]);

    this.updateSyncState("product_modifier_groups", count);
    return { entity: "product_modifier_groups", pulled: count, errors: [] };
  }

  private async pullDiscountTemplates(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/discount-templates", params);
    if (!res.ok) return { entity: "discount_templates", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      name: item.name,
      type: item.discountType ?? item.type,
      value: item.discountValue ?? item.value ?? 0,
      scope: item.appliesTo ?? "ITEM",
      is_active: item.isActive ? 1 : 0,
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("discount_templates", rows, [
      "id", "tenant_id", "name", "type", "value", "scope", "is_active",
      "created_at", "updated_at",
    ]);

    this.updateSyncState("discount_templates", count);
    return { entity: "discount_templates", pulled: count, errors: [] };
  }

  private async pullGiftCards(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/gift-cards", params);
    if (!res.ok) return { entity: "gift_cards", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      code: item.code,
      initial_balance: item.initialAmount ?? item.originalBalance ?? 0,
      current_balance: item.currentBalance ?? item.balance ?? 0,
      is_active: item.isActive ? 1 : 0,
      expires_at: item.expiresAt ?? null,
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("gift_cards", rows, [
      "id", "tenant_id", "code", "initial_balance", "current_balance",
      "is_active", "expires_at", "created_at", "updated_at",
    ]);

    this.updateSyncState("gift_cards", count);
    return { entity: "gift_cards", pulled: count, errors: [] };
  }

  private async pullCouponCodes(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/coupons", params);
    if (!res.ok) return { entity: "coupon_codes", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      code: item.code,
      name: item.description ?? null,
      discount_type: item.discountType,
      discount_value: item.discountValue ?? 0,
      min_order_amount: item.minPurchase ?? 0,
      max_uses: item.maxUses ?? null,
      current_uses: item.usedCount ?? 0,
      is_active: item.isActive ? 1 : 0,
      starts_at: item.startDate ?? null,
      expires_at: item.endDate ?? null,
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("coupon_codes", rows, [
      "id", "tenant_id", "code", "name", "discount_type", "discount_value",
      "min_order_amount", "max_uses", "current_uses", "is_active",
      "starts_at", "expires_at", "created_at", "updated_at",
    ]);

    this.updateSyncState("coupon_codes", count);
    return { entity: "coupon_codes", pulled: count, errors: [] };
  }

  private async pullDeals(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/deals", params);
    if (!res.ok) return { entity: "deals", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      config_id: item.configId ?? null,
      name: item.name,
      code: item.code ?? null,
      description: item.description ?? null,
      deal_type: item.dealType ?? (item.config as string) ?? "FIXED_PRICE",
      base_price: item.basePrice != null ? Number(item.basePrice) : null,
      pricing_mode: item.pricingMode ?? "FIXED",
      topping_charge_target: item.toppingChargeTarget ?? "ALL",
      is_active: item.isActive ? 1 : 0,
      min_order_amount: item.minOrderAmount ?? 0,
      max_uses_total: item.maxUsesTotal ?? null,
      max_uses_per_customer: item.maxUsesPerCustomer ?? null,
      max_uses_per_order: item.maxUsesPerOrder ?? 1,
      current_uses: item.currentUses ?? 0,
      order_types: item.orderTypes ? JSON.stringify(item.orderTypes) : "[]",
      location_ids: item.locationIds ? JSON.stringify(item.locationIds) : "[]",
      free_toppings: item.freeToppings ?? 0,
      free_premium_toppings: item.freePremiumToppings ?? 0,
      topping_type: item.toppingType ?? null,
      free_toppings_scope: item.freeToppingsScope ?? "PER_ITEM",
      free_crust: item.freeCrust ? 1 : 0,
      category_id: item.categoryId ?? null,
      config: item.config ? JSON.stringify(item.config) : "{}",
      can_stack: item.canStack ? 1 : 0,
      allow_discount: item.allowDiscount != null ? (item.allowDiscount ? 1 : 0) : 1,
      allow_coupon: item.allowCoupon != null ? (item.allowCoupon ? 1 : 0) : 1,
      starts_at: item.startDate ?? null,
      expires_at: item.endDate ?? null,
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("deals", rows, [
      "id", "tenant_id", "config_id", "name", "code", "description", "deal_type",
      "base_price", "pricing_mode", "topping_charge_target",
      "is_active", "min_order_amount", "max_uses_total", "max_uses_per_customer",
      "max_uses_per_order", "current_uses", "order_types", "location_ids",
      "free_toppings", "free_premium_toppings", "topping_type", "free_toppings_scope",
      "free_crust", "category_id", "config",
      "can_stack", "allow_discount", "allow_coupon", "starts_at", "expires_at",
      "created_at", "updated_at",
    ]);

    this.updateSyncState("deals", count);
    return { entity: "deals", pulled: count, errors: [] };
  }

  private async pullDealItems(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/deal-items", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "deal_items", pulled: 0, errors: [] };
      return { entity: "deal_items", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      deal_id: item.dealId,
      product_id: item.productId ?? null,
      product_ids: item.productIds ? JSON.stringify(item.productIds) : "[]",
      category_id: item.categoryId ?? null,
      variant_id: item.variantId ?? null,
      product_type: item.productType ?? null,
      name: item.name ?? null,
      role: item.role ?? "QUALIFIER",
      quantity: item.minQuantity ?? 1,
      quantity_per_item: item.quantityPerItem ?? 1,
      min_quantity: item.minQuantity ?? 1,
      max_quantity: item.maxQuantity ?? null,
      discount_type: item.discountType ?? null,
      discount_value: item.discountValue ?? 0,
      sort_order: item.displayOrder ?? 0,
      allow_pizza: item.productType === "PIZZA" ? 1 : 0,
      allow_variant_selection: 0,
      can_swap: item.canSwap ? 1 : 0,
      swap_product_ids: item.swapProductIds ? JSON.stringify(item.swapProductIds) : "[]",
    }));

    const count = this.upsertRows("deal_items", rows, [
      "id", "tenant_id", "deal_id", "product_id", "product_ids", "category_id",
      "variant_id", "product_type", "name", "role", "quantity", "quantity_per_item",
      "min_quantity", "max_quantity", "discount_type", "discount_value",
      "sort_order", "allow_pizza", "allow_variant_selection",
      "can_swap", "swap_product_ids",
    ]);

    this.updateSyncState("deal_items", count);
    return { entity: "deal_items", pulled: count, errors: [] };
  }

  private async pullDealTimeRestrictions(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/deal-time-restrictions", params);

    const count = this.upsertRows("deal_time_restrictions", rows, [
      "id", "deal_id", "day_of_week", "start_time", "end_time",
    ]);

    this.updateSyncState("deal_time_restrictions", count);
    return { entity: "deal_time_restrictions", pulled: count, errors: [] };
  }

  private async pullDealSizePrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/deal-size-prices", params);

    // Map cloud sizeId → SQLite size_id
    const count = this.upsertRows("deal_size_prices", rows, [
      "id", "deal_id", "size_id", "price",
    ]);

    this.updateSyncState("deal_size_prices", count);
    return { entity: "deal_size_prices", pulled: count, errors: [] };
  }

  private async pullUsers(): Promise<PullResult> {
    const state = this.getSyncState("users");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/users", params);
    if (!res.ok) return { entity: "users", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      name: item.name,
      email: item.email ?? null,
      pin_hash: item.pinHash ?? null,
      role: item.roleName ?? "cashier",
      permissions: item.permissions ? JSON.stringify(item.permissions) : "[]",
      max_discount: item.maxDiscountPercent ?? 0,
      is_active: item.isActive ? 1 : 0,
      image_url: item.imageUrl ?? null,
      created_at: item.createdAt ?? null,
      updated_at: item.updatedAt ?? null,
    }));

    const count = this.upsertRows("users", rows, [
      "id", "tenant_id", "name", "email", "pin_hash", "role", "permissions",
      "max_discount", "is_active", "created_at", "updated_at",
    ]);

    this.updateSyncState("users", count);
    return { entity: "users", pulled: count, errors: [] };
  }

  private async pullLocationSettings(): Promise<PullResult> {
    const res = await this.cloudClient.get<Record<string, unknown>>("/api/hub/sync/location-settings", {});
    if (!res.ok) return { entity: "location_settings", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const data = res.data;
    if (!data || !data.id) return { entity: "location_settings", pulled: 0, errors: [] };

    // Location settings is a single row keyed by location_id
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO location_settings (
        location_id, name, restaurant_mode,
        order_type_dine_in, order_type_take_out, order_type_delivery, order_type_drive_through, order_type_third_party,
        enable_floor_plan, enable_tips, enable_reservations, enable_waitlist,
        allow_check_in_without_order, allow_per_guest_ordering,
        post_order_action, hold_table_action, allow_price_override,
        address, phone, email,
        timezone, currency, tax_rate, dark_mode, default_drawer_float,
        kitchen_print_price, kitchen_print_mode,
        kitchen_show_modifiers, kitchen_show_notes, kitchen_show_total,
        kitchen_show_customer_name, kitchen_show_table_number, kitchen_large_font, kitchen_show_order_age,
        drawer_open_on_cash, drawer_open_on_pay_in_out, drawer_manual_open,
        receipt_red_void, receipt_red_modifiers, receipt_red_notes, receipt_red_modified,
        delivery_fee_tax_type_ids,
        auto_gratuity_enabled, auto_gratuity_threshold, auto_gratuity_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.name ?? null,
      data.restaurantMode ? 1 : 0,
      data.orderTypeDineIn ? 1 : 0,
      data.orderTypeTakeOut ? 1 : 0,
      data.orderTypeDelivery ? 1 : 0,
      data.orderTypeDriveThrough ? 1 : 0,
      data.orderTypeThirdParty ? 1 : 0,
      data.enableFloorPlan ? 1 : 0,
      data.enableTips ? 1 : 0,
      data.enableReservations ? 1 : 0,
      data.enableWaitlist ? 1 : 0,
      data.allowCheckInWithoutOrder ? 1 : 0,
      data.allowPerGuestOrdering ? 1 : 0,
      data.postOrderAction ?? "STAY_ON_ORDER_ENTRY",
      data.holdTableAction ?? "STAY_ON_ORDER_ENTRY",
      data.allowPriceOverride ? 1 : 0,
      data.address ?? null,
      data.phone ?? null,
      data.email ?? null,
      data.timezone ?? "America/Toronto",
      data.currency ?? "CAD",
      data.taxRate ?? 0,
      data.darkMode ? 1 : 0,
      data.defaultDrawerFloat ?? 100,
      data.kitchenPrintPrice ? 1 : 0,
      data.kitchenPrintMode ?? "NEW_ONLY",
      data.kitchenShowModifiers !== false ? 1 : 0,
      data.kitchenShowNotes !== false ? 1 : 0,
      data.kitchenShowTotal ? 1 : 0,
      data.kitchenShowCustomerName !== false ? 1 : 0,
      data.kitchenShowTableNumber !== false ? 1 : 0,
      data.kitchenLargeFont ? 1 : 0,
      data.kitchenShowOrderAge !== false ? 1 : 0,
      data.drawerOpenOnCash !== false ? 1 : 0,
      data.drawerOpenOnPayInOut !== false ? 1 : 0,
      data.drawerManualOpen !== false ? 1 : 0,
      data.receiptRedVoid !== false ? 1 : 0,
      data.receiptRedModifiers !== false ? 1 : 0,
      data.receiptRedNotes !== false ? 1 : 0,
      data.receiptRedModified !== false ? 1 : 0,
      JSON.stringify(data.deliveryFeeTaxTypeIds ?? []),
      data.autoGratuityEnabled ? 1 : 0,
      data.autoGratuityMinGuests ?? 8,
      data.autoGratuityPercent ?? 18,
    );

    this.updateSyncState("location_settings", 1);
    return { entity: "location_settings", pulled: 1, errors: [] };
  }

  private async pullTerminalSettings(): Promise<PullResult> {
    // Pull settings for each registered terminal at this location
    const db = getDb();
    const terminals = db.prepare("SELECT id FROM terminals WHERE location_id = ?")
      .all(config.locationId ?? "") as Array<{ id: string }>;

    if (terminals.length === 0) {
      return { entity: "terminal_settings", pulled: 0, errors: [] };
    }

    let pulled = 0;
    const errors: string[] = [];

    for (const terminal of terminals) {
      const res = await this.cloudClient.get<Record<string, unknown>>(
        "/api/hub/sync/terminal-settings",
        { terminalId: terminal.id },
      );
      if (!res.ok) {
        errors.push(`Terminal ${terminal.id}: ${res.error ?? `HTTP ${res.status}`}`);
        continue;
      }

      const data = res.data;
      if (!data || !data.id) continue;

      db.prepare(`
        INSERT OR REPLACE INTO terminal_settings (
          terminal_id, name, dark_mode, cart_position, restaurant_mode,
          auto_print_receipt,
          auto_logout_after_send_order, auto_logout_after_payment, auto_logout_timeout,
          block_clock_out_with_open_orders, allow_shared_cash_drawer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.id,
        data.name ?? null,
        data.darkMode ? 1 : 0,
        (data.cartPosition as string)?.toLowerCase() ?? "right",
        data.restaurantMode ? 1 : 0,
        data.autoPrintReceipt !== false ? 1 : 0,
        data.autoLogoutAfterSendOrder ? 1 : 0,
        data.autoLogoutAfterPayment ? 1 : 0,
        data.autoLogoutTimeout ?? null,
        data.blockClockOutWithOpenOrders ? 1 : 0,
        data.allowSharedCashDrawer ? 1 : 0,
      );
      pulled++;
    }

    this.updateSyncState("terminal_settings", pulled);
    return { entity: "terminal_settings", pulled, errors };
  }

  private async pullFloors(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/floors", params);
    if (!res.ok) return { entity: "floors", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      location_id: item.locationId ?? config.locationId,
      name: item.name,
      sort_order: item.sortOrder ?? item.displayOrder ?? 0,
      background_image: item.backgroundImage ?? null,
      is_active: item.isActive ? 1 : 0,
    }));

    const count = this.upsertRows("floors", rows, [
      "id", "tenant_id", "location_id", "name", "sort_order", "background_image", "is_active",
    ]);

    this.updateSyncState("floors", count);
    return { entity: "floors", pulled: count, errors: [] };
  }

  private async pullAreas(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/areas", params);
    if (!res.ok) return { entity: "areas", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      floor_id: item.floorId,
      name: item.name,
      sort_order: item.displayOrder ?? 0,
    }));

    const count = this.upsertRows("areas", rows, [
      "id", "tenant_id", "floor_id", "name", "sort_order",
    ]);

    this.updateSyncState("areas", count);
    return { entity: "areas", pulled: count, errors: [] };
  }

  private async pullTables(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/tables", params);
    if (!res.ok) return { entity: "tables", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      floor_id: item.floorId ?? null,
      area_id: item.areaId ?? null,
      name: item.displayName ?? item.name ?? `Table ${item.tableNumber}`,
      capacity: item.seatingCapacity ?? item.capacity ?? 4,
      shape: item.shape ?? "SQUARE",
      x_position: item.positionX ?? 0,
      y_position: item.positionY ?? 0,
      width: item.width ?? 100,
      height: item.height ?? 100,
      rotation: item.rotation ?? 0,
      is_active: item.isActive ? 1 : 0,
    }));

    const count = this.upsertRows("tables", rows, [
      "id", "tenant_id", "floor_id", "area_id", "name", "capacity", "shape",
      "x_position", "y_position", "width", "height", "rotation", "is_active",
    ]);

    this.updateSyncState("tables", count);
    return { entity: "tables", pulled: count, errors: [] };
  }

  private async pullCourses(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/courses", params);
    if (!res.ok) return { entity: "courses", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      location_id: item.locationId ?? config.locationId,
      name: item.name,
      sort_order: item.displayOrder ?? 0,
      auto_fire: item.autoFireMinutes ?? 0,
    }));

    const count = this.upsertRows("courses", rows, [
      "id", "tenant_id", "location_id", "name", "sort_order", "auto_fire",
    ]);

    this.updateSyncState("courses", count);
    return { entity: "courses", pulled: count, errors: [] };
  }

  private async pullNotePresets(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/note-presets", params);

    const count = this.upsertRows("note_presets", rows, [
      "id", "location_id", "text", "sort_order", "usage_count",
    ]);

    this.updateSyncState("note_presets", count);
    return { entity: "note_presets", pulled: count, errors: [] };
  }

  private async pullLocationProductOverrides(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const rows = await this.fetchAndTransform("/api/hub/sync/location-product-overrides", params);

    const count = this.upsertRows("location_product_overrides", rows, [
      "id", "tenant_id", "location_id", "product_id", "variant_id", "kit_id",
      "price", "cost_price", "is_available", "tax_type_ids",
    ]);

    this.updateSyncState("location_product_overrides", count);
    return { entity: "location_product_overrides", pulled: count, errors: [] };
  }

  // ===================================================================
  // Pizza module sync — individual endpoints
  // ===================================================================

  private async pullPizzaSizePrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-size-prices", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_size_prices", pulled: 0, errors: [] };
      return { entity: "pizza_size_prices", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      size_id: item.sizeId ?? item.pizzaSizeId,
      product_id: item.productId ?? item.pizzaProductId ?? null,
      base_price: item.basePrice ?? item.price ?? 0,
      is_available: item.isAvailable != null ? (item.isAvailable ? 1 : 0) : 1,
    }));

    const count = this.upsertRows("pizza_size_prices", rows, [
      "id", "tenant_id", "size_id", "product_id", "base_price", "is_available",
    ]);

    this.updateSyncState("pizza_size_prices", count);
    return { entity: "pizza_size_prices", pulled: count, errors: [] };
  }

  private async pullPizzaToppingPrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-topping-prices", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_topping_prices", pulled: 0, errors: [] };
      return { entity: "pizza_topping_prices", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      topping_id: item.toppingId ?? item.pizzaToppingId,
      size_id: item.sizeId ?? item.pizzaSizeId,
      product_id: item.productId ?? null,
      light_price: item.lightPrice ?? 0,
      regular_price: item.regularPrice ?? item.priceSingle ?? 0,
      extra_price: item.extraPrice ?? item.priceDouble ?? 0,
    }));

    // Full replace — price tables pull ALL records, no cursor. Clear before insert to prevent duplicates.
    this.replaceTable("pizza_topping_prices", rows, [
      "id", "tenant_id", "topping_id", "size_id", "product_id",
      "light_price", "regular_price", "extra_price",
    ]);

    this.updateSyncState("pizza_topping_prices", rows.length);
    return { entity: "pizza_topping_prices", pulled: rows.length, errors: [] };
  }

  private async pullPizzaCrustPrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-crust-prices", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_crust_prices", pulled: 0, errors: [] };
      return { entity: "pizza_crust_prices", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      crust_id: item.crustId ?? item.pizzaCrustId,
      size_id: item.sizeId ?? item.pizzaSizeId,
      product_id: item.productId ?? null,
      upcharge: item.upcharge ?? item.price ?? 0,
    }));

    this.replaceTable("pizza_crust_prices", rows, [
      "id", "tenant_id", "crust_id", "size_id", "product_id", "upcharge",
    ]);

    this.updateSyncState("pizza_crust_prices", rows.length);
    return { entity: "pizza_crust_prices", pulled: rows.length, errors: [] };
  }

  private async pullPizzaSaucePrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-sauce-prices", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_sauce_prices", pulled: 0, errors: [] };
      return { entity: "pizza_sauce_prices", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      sauce_id: item.sauceId ?? item.pizzaSauceId,
      size_id: item.sizeId ?? item.pizzaSizeId,
      product_id: item.productId ?? null,
      light_price: item.lightPrice ?? 0,
      regular_price: item.regularPrice ?? item.price ?? 0,
      extra_price: item.extraPrice ?? 0,
    }));

    this.replaceTable("pizza_sauce_prices", rows, [
      "id", "tenant_id", "sauce_id", "size_id", "product_id",
      "light_price", "regular_price", "extra_price",
    ]);

    this.updateSyncState("pizza_sauce_prices", rows.length);
    return { entity: "pizza_sauce_prices", pulled: rows.length, errors: [] };
  }

  private async pullPizzaCheesesPrices(): Promise<PullResult> {
    const params: Record<string, string> = {};
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-cheese-prices", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_cheese_prices", pulled: 0, errors: [] };
      return { entity: "pizza_cheese_prices", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      cheese_id: item.cheeseId ?? item.pizzaCheeseId,
      size_id: item.sizeId ?? item.pizzaSizeId,
      product_id: item.productId ?? null,
      light_price: item.lightPrice ?? 0,
      regular_price: item.regularPrice ?? item.price ?? 0,
      extra_price: item.extraPrice ?? 0,
    }));

    this.replaceTable("pizza_cheese_prices", rows, [
      "id", "tenant_id", "cheese_id", "size_id", "product_id",
      "light_price", "regular_price", "extra_price",
    ]);

    this.updateSyncState("pizza_cheese_prices", count);
    return { entity: "pizza_cheese_prices", pulled: count, errors: [] };
  }

  // ===================================================================
  // NEW: 21 additional entities to match hub v1 parity
  // ===================================================================

  private async pullPizzaSizeOrderTypePrices(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/pizza-size-order-type-prices", {});
    const count = this.upsertRows("pizza_size_order_type_prices", rows, [
      "id", "size_price_id", "order_type", "price",
    ]);
    this.updateSyncState("pizza_size_order_type_prices", count);
    return { entity: "pizza_size_order_type_prices", pulled: count, errors: [] };
  }

  private async pullPizzaLocationConfig(): Promise<PullResult> {
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/pizza-location-config", {});
    if (!res.ok) {
      if (res.status === 404) return { entity: "pizza_location_config", pulled: 0, errors: [] };
      return { entity: "pizza_location_config", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }
    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      location_id: item.locationId,
      config_id: item.configId,
      is_enabled: item.isEnabled != null ? (item.isEnabled ? 1 : 0) : null,
      half_and_half_enabled: item.halfAndHalfEnabled != null ? (item.halfAndHalfEnabled ? 1 : 0) : null,
      data: item.data ? (typeof item.data === "string" ? item.data : JSON.stringify(item.data)) : null,
    }));
    const count = this.upsertRows("pizza_location_config", rows, [
      "id", "tenant_id", "location_id", "config_id", "is_enabled", "half_and_half_enabled", "data",
    ]);
    this.updateSyncState("pizza_location_config", count);

    // Parse the `data` JSON blob and populate individual pizza entity tables
    // (sizes, crusts, sauces, cheeses, toppings, toppingCategories)
    for (const item of rawItems) {
      const tenantId = item.tenantId;
      const configId = item.configId;
      const dataStr = typeof item.data === "string" ? item.data : JSON.stringify(item.data ?? "");
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // Pizza sizes
      if (Array.isArray(parsed.sizes)) {
        const sizeRows = parsed.sizes.map((s: any) => ({
          id: s.id,
          tenant_id: tenantId,
          config_id: configId,
          name: s.name ?? "",
          code: s.code ?? null,
          sort_order: s.displayOrder ?? 0,
          is_default: s.isDefault ? 1 : 0,
          is_active: s.isActive != null ? (s.isActive ? 1 : 0) : 1,
          topping_price: s.toppingPrice ?? 0,
          half_topping_price: s.halfToppingPrice ?? null,
        }));
        this.upsertRows("pizza_sizes", sizeRows, [
          "id", "tenant_id", "config_id", "name", "code", "sort_order", "is_default", "is_active",
          "topping_price", "half_topping_price",
        ]);
      }

      // Pizza crusts
      if (Array.isArray(parsed.crusts)) {
        const crustRows = parsed.crusts.map((c: any) => ({
          id: c.id,
          tenant_id: tenantId,
          config_id: configId,
          name: c.name ?? "",
          sort_order: c.displayOrder ?? 0,
          is_default: c.isDefault ? 1 : 0,
          is_active: c.isActive != null ? (c.isActive ? 1 : 0) : 1,
        }));
        this.upsertRows("pizza_crusts", crustRows, [
          "id", "tenant_id", "config_id", "name", "sort_order", "is_default", "is_active",
        ]);
      }

      // Pizza sauces
      if (Array.isArray(parsed.sauces)) {
        const sauceRows = parsed.sauces.map((s: any) => ({
          id: s.id,
          tenant_id: tenantId,
          config_id: configId,
          name: s.name ?? "",
          sort_order: s.displayOrder ?? 0,
          is_default: s.isDefault ? 1 : 0,
          is_active: s.isActive != null ? (s.isActive ? 1 : 0) : 1,
        }));
        this.upsertRows("pizza_sauces", sauceRows, [
          "id", "tenant_id", "config_id", "name", "sort_order", "is_default", "is_active",
        ]);
      }

      // Pizza cheeses
      if (Array.isArray(parsed.cheeses)) {
        const cheeseRows = parsed.cheeses.map((c: any) => ({
          id: c.id,
          tenant_id: tenantId,
          config_id: configId,
          name: c.name ?? "",
          sort_order: c.displayOrder ?? 0,
          is_default: c.isDefault ? 1 : 0,
          is_active: c.isActive != null ? (c.isActive ? 1 : 0) : 1,
        }));
        this.upsertRows("pizza_cheeses", cheeseRows, [
          "id", "tenant_id", "config_id", "name", "sort_order", "is_default", "is_active",
        ]);
      }

      // Pizza topping categories
      if (Array.isArray(parsed.toppingCategories)) {
        const catRows = parsed.toppingCategories.map((tc: any) => ({
          id: tc.id,
          tenant_id: tenantId,
          config_id: configId,
          name: tc.name ?? "",
          sort_order: tc.displayOrder ?? 0,
          is_premium: tc.isPremium ? 1 : 0,
          is_active: tc.isActive != null ? (tc.isActive ? 1 : 0) : 1,
        }));
        this.upsertRows("pizza_topping_categories", catRows, [
          "id", "tenant_id", "config_id", "name", "sort_order", "is_premium", "is_active",
        ]);
      }

      // Pizza toppings
      if (Array.isArray(parsed.toppings)) {
        const toppingRows = parsed.toppings.map((t: any) => ({
          id: t.id,
          tenant_id: tenantId,
          config_id: configId,
          name: t.name ?? "",
          category_id: t.categoryId ?? null,
          sort_order: t.displayOrder ?? 0,
          is_default: t.isDefault ? 1 : 0,
          is_premium: t.isPremium ? 1 : 0,
          is_active: t.isActive != null ? (t.isActive ? 1 : 0) : 1,
          price_multiplier: t.priceMultiplier ?? 1.0,
        }));
        this.upsertRows("pizza_toppings", toppingRows, [
          "id", "tenant_id", "config_id", "name", "category_id", "sort_order", "is_default", "is_premium", "is_active",
          "price_multiplier",
        ]);
      }
    }

    return { entity: "pizza_location_config", pulled: count, errors: [] };
  }

  private async pullRoles(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/roles", {});
    // Ensure permissions is JSON string
    for (const row of rows) {
      if (row.permissions && typeof row.permissions !== "string") {
        row.permissions = JSON.stringify(row.permissions);
      }
    }
    const count = this.upsertRows("roles", rows, [
      "id", "tenant_id", "name", "permissions",
    ]);
    this.updateSyncState("roles", count);
    return { entity: "roles", pulled: count, errors: [] };
  }

  private async pullInventoryLevels(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/inventory-levels", {});
    const count = this.upsertRows("inventory_levels", rows, [
      "id", "tenant_id", "product_variant_id", "location_id", "quantity",
      "reserved_quantity", "low_stock_threshold", "reorder_point", "reorder_quantity",
    ]);
    this.updateSyncState("inventory_levels", count);
    return { entity: "inventory_levels", pulled: count, errors: [] };
  }

  private async pullPostCodes(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/post-codes", {});
    const count = this.upsertRows("post_codes", rows, [
      "id", "tenant_id", "code", "delivery_charge", "driver_compensation", "is_active",
    ]);
    this.updateSyncState("post_codes", count);
    return { entity: "post_codes", pulled: count, errors: [] };
  }

  private async pullCustomerAddresses(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/customer-addresses", {});
    const count = this.upsertRows("customer_addresses", rows, [
      "id", "customer_id", "tenant_id", "label", "unit_number", "address",
      "address_notes", "buzzer_number", "city", "province", "postal_code",
      "delivery_charge", "driver_compensation", "is_default", "is_active",
    ]);
    this.updateSyncState("customer_addresses", count);
    return { entity: "customer_addresses", pulled: count, errors: [] };
  }

  private async pullCategorySchedules(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/category-schedules", {});
    const count = this.upsertRows("category_schedules", rows, [
      "id", "tenant_id", "location_id", "category_id", "name",
      "day_of_week", "start_time", "end_time", "effective_date", "expiry_date",
      "is_active", "priority",
    ]);
    this.updateSyncState("category_schedules", count);
    return { entity: "category_schedules", pulled: count, errors: [] };
  }

  private async pullPriceSchedules(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/price-schedules", {});
    const count = this.upsertRows("price_schedules", rows, [
      "id", "tenant_id", "location_id", "product_id", "product_variant_id", "name",
      "price_type", "price_value", "day_of_week", "start_time", "end_time",
      "effective_date", "expiry_date", "is_active", "priority",
    ]);
    this.updateSyncState("price_schedules", count);
    return { entity: "price_schedules", pulled: count, errors: [] };
  }

  private async pullDealSizeOrderTypePrices(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/deal-size-order-type-prices", {});
    const count = this.upsertRows("deal_size_order_type_prices", rows, [
      "id", "size_price_id", "order_type", "price",
    ]);
    this.updateSyncState("deal_size_order_type_prices", count);
    return { entity: "deal_size_order_type_prices", pulled: count, errors: [] };
  }

  private async pullLocationBusinessHours(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/location-business-hours", {});
    const count = this.upsertRows("location_business_hours", rows, [
      "id", "location_id", "day_of_week", "open_time", "close_time", "is_closed",
    ]);
    this.updateSyncState("location_business_hours", count);
    return { entity: "location_business_hours", pulled: count, errors: [] };
  }

  private async pullWebOrderSettings(): Promise<PullResult> {
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/web-order-settings", {});
    if (!res.ok) {
      if (res.status === 404) return { entity: "web_order_settings", pulled: 0, errors: [] };
      return { entity: "web_order_settings", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }
    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      location_id: item.locationId,
      alert_enabled: item.alertEnabled ? 1 : 0,
      alert_sound: item.alertSound ?? null,
      alert_volume: item.alertVolume ?? 80,
      alert_repeat_interval: item.alertRepeatInterval ?? 30,
      alert_max_repeats: item.alertMaxRepeats ?? 5,
      prep_time_take_out: item.prepTimeTakeOut ?? 20,
      prep_time_delivery: item.prepTimeDelivery ?? 30,
      prep_time_buffer: item.prepTimeBuffer ?? 5,
      auto_accept_enabled: item.autoAcceptEnabled ? 1 : 0,
      auto_accept_max_amount: item.autoAcceptMaxAmount ?? null,
      require_decline_reason: item.requireDeclineReason ? 1 : 0,
      decline_reasons: item.declineReasons ? JSON.stringify(item.declineReasons) : null,
      accept_orders_enabled: item.acceptOrdersEnabled != null ? (item.acceptOrdersEnabled ? 1 : 0) : 1,
      operating_hours: item.operatingHours ? JSON.stringify(item.operatingHours) : null,
    }));
    const count = this.upsertRows("web_order_settings", rows, [
      "id", "location_id", "alert_enabled", "alert_sound", "alert_volume",
      "alert_repeat_interval", "alert_max_repeats", "prep_time_take_out",
      "prep_time_delivery", "prep_time_buffer", "auto_accept_enabled",
      "auto_accept_max_amount", "require_decline_reason", "decline_reasons",
      "accept_orders_enabled", "operating_hours",
    ]);
    this.updateSyncState("web_order_settings", count);
    return { entity: "web_order_settings", pulled: count, errors: [] };
  }

  private async pullCashDrawers(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/cash-drawers", {});
    const count = this.upsertRows("cash_drawers", rows, [
      "id", "tenant_id", "terminal_id", "user_id", "status",
      "opening_balance", "closing_balance", "expected_balance", "difference",
      "notes", "opened_at", "closed_at", "closed_by_id",
    ]);
    this.updateSyncState("cash_drawers", count);
    return { entity: "cash_drawers", pulled: count, errors: [] };
  }

  private async pullCashDrawerTransactions(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/cash-drawer-transactions", {});
    const count = this.upsertRows("cash_drawer_transactions", rows, [
      "id", "cash_drawer_id", "type", "amount", "reference", "reason", "user_id", "created_at",
    ]);
    this.updateSyncState("cash_drawer_transactions", count);
    return { entity: "cash_drawer_transactions", pulled: count, errors: [] };
  }

  private async pullStaffBanks(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/staff-banks", {});
    const count = this.upsertRows("staff_banks", rows, [
      "id", "tenant_id", "user_id", "location_id", "bank_type", "status",
      "opening_balance", "closing_balance", "expected_balance", "difference",
      "notes", "opened_at", "closed_at", "closed_by_id",
      "card_total", "tips_collected", "tips_paid_out",
    ]);
    this.updateSyncState("staff_banks", count);
    return { entity: "staff_banks", pulled: count, errors: [] };
  }

  private async pullStaffBankTransactions(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/staff-bank-transactions", {});
    const count = this.upsertRows("staff_bank_transactions", rows, [
      "id", "staff_bank_id", "type", "amount", "reference", "reason", "user_id", "created_at",
    ]);
    this.updateSyncState("staff_bank_transactions", count);
    return { entity: "staff_bank_transactions", pulled: count, errors: [] };
  }

  private async pullStoreCredits(): Promise<PullResult> {
    const rows = await this.fetchAndTransform("/api/hub/sync/store-credits", {});
    const count = this.upsertRows("store_credits", rows, [
      "id", "tenant_id", "customer_id", "code", "initial_amount", "current_balance",
      "status", "reason", "refund_id", "expires_at", "created_by_id", "created_at",
    ]);
    this.updateSyncState("store_credits", count);
    return { entity: "store_credits", pulled: count, errors: [] };
  }

  private async pullKitchenOrders(): Promise<PullResult> {
    const state = this.getSyncState("kitchen_orders");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/kitchen-orders", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "kitchen_orders", pulled: 0, errors: [] };
      return { entity: "kitchen_orders", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => {
      // Bundle extra fields into data JSON
      const dataObj: Record<string, unknown> = {};
      for (const key of ["orderSource", "subtotal", "taxBreakdown", "total", "discountTotal",
        "couponDiscount", "gratuity", "customerId", "customerName", "customerPhone", "data"]) {
        if (item[key] != null) dataObj[key] = item[key];
      }

      return {
        id: item.id,
        tenant_id: item.tenantId,
        location_id: item.locationId,
        order_number: String(item.orderNumber ?? ""),
        table_session_id: item.tableSessionId ?? null,
        table_number: item.tableNumber ?? null,
        order_type: item.orderType ?? "DINE_IN",
        status: item.status ?? "PENDING",
        priority: item.priority ?? "NORMAL",
        notes: item.notes ?? null,
        created_by: item.serverId ?? null,
        created_at: item.createdAt ? Math.floor(new Date(item.createdAt as string).getTime() / 1000) : null,
        prep_started_at: item.prepStartedAt ? Math.floor(new Date(item.prepStartedAt as string).getTime() / 1000) : null,
        ready_at: item.readyAt ? Math.floor(new Date(item.readyAt as string).getTime() / 1000) : null,
        completed_at: item.completedAt ? Math.floor(new Date(item.completedAt as string).getTime() / 1000) : null,
        data: Object.keys(dataObj).length > 0 ? JSON.stringify(dataObj) : null,
        split_group_id: item.splitGroupId ?? null,
        parent_order_id: item.parentOrderId ?? null,
        is_split_child: item.isSplitChild ? 1 : 0,
        split_index: item.splitIndex ?? null,
        combined_from_ids: item.combinedFromIds ? JSON.stringify(item.combinedFromIds) : null,
        combined_from_numbers: item.combinedFromNumbers ? JSON.stringify(item.combinedFromNumbers) : null,
        is_combined: item.isCombined ? 1 : 0,
      };
    });

    const db = getDb();
    const count = this.upsertRows("kitchen_orders", rows, [
      "id", "tenant_id", "location_id", "order_number", "table_session_id", "table_number",
      "order_type", "status", "priority", "notes", "created_by",
      "created_at", "prep_started_at", "ready_at", "completed_at", "data",
      "split_group_id", "parent_order_id", "is_split_child", "split_index",
      "combined_from_ids", "combined_from_numbers", "is_combined",
    ]);

    // Handle deletions
    const deletedIds = (res.data as PaginatedResponse)?.deletedIds;
    if (deletedIds && deletedIds.length > 0) {
      for (const delId of deletedIds) {
        db.prepare("DELETE FROM kitchen_order_items WHERE kitchen_order_id = ?").run(delId);
        db.prepare("DELETE FROM kitchen_orders WHERE id = ?").run(delId);
      }
    }

    this.updateSyncState("kitchen_orders", count);
    return { entity: "kitchen_orders", pulled: count, errors: [] };
  }

  private async pullKitchenOrderItems(): Promise<PullResult> {
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/kitchen-order-items", {});
    if (!res.ok) {
      if (res.status === 404) return { entity: "kitchen_order_items", pulled: 0, errors: [] };
      return { entity: "kitchen_order_items", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      kitchen_order_id: item.kitchenOrderId,
      product_id: item.productId ?? null,
      product_name: item.productName ?? "",
      variant_id: item.variantId ?? null,
      variant_name: item.variantName ?? null,
      quantity: item.quantity ?? 1,
      course_id: item.courseId ?? null,
      status: item.status ?? "PENDING",
      notes: item.notes ?? null,
      modifiers: item.modifiers ? (typeof item.modifiers === "string" ? item.modifiers : JSON.stringify(item.modifiers)) : null,
      metadata: item.metadata ? (typeof item.metadata === "string" ? item.metadata : JSON.stringify(item.metadata)) : null,
      unit_price: item.unitPrice ?? null,
      discount: item.discount ?? 0,
      discount_type: item.discountType ?? null,
      tax: item.tax ?? 0,
      tax_rate: item.taxRate ?? 0,
      tax_type_ids: item.taxTypeIds ? (typeof item.taxTypeIds === "string" ? item.taxTypeIds : JSON.stringify(item.taxTypeIds)) : "[]",
      fired_at: item.firedAt ? Math.floor(new Date(item.firedAt as string).getTime() / 1000) : null,
      ready_at: item.readyAt ? Math.floor(new Date(item.readyAt as string).getTime() / 1000) : null,
      served_at: item.servedAt ? Math.floor(new Date(item.servedAt as string).getTime() / 1000) : null,
      voided_at: item.voidedAt ? Math.floor(new Date(item.voidedAt as string).getTime() / 1000) : null,
      void_reason: item.voidReason ?? null,
    }));

    const count = this.upsertRows("kitchen_order_items", rows, [
      "id", "kitchen_order_id", "product_id", "product_name", "variant_id", "variant_name",
      "quantity", "course_id", "status", "notes", "modifiers", "metadata",
      "unit_price", "discount", "discount_type", "tax", "tax_rate", "tax_type_ids",
      "fired_at", "ready_at", "served_at", "voided_at", "void_reason",
    ]);
    this.updateSyncState("kitchen_order_items", count);
    return { entity: "kitchen_order_items", pulled: count, errors: [] };
  }

  private async pullSales(): Promise<PullResult> {
    const state = this.getSyncState("sales");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/sales", params);
    if (!res.ok) {
      if (res.status === 404) return { entity: "sales", pulled: 0, errors: [] };
      return { entity: "sales", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      tenant_id: item.tenantId,
      location_id: item.locationId,
      terminal_id: item.terminalId ?? null,
      receipt_number: item.receiptNumber ?? null,
      order_type: item.orderType ?? "DINE_IN",
      customer_id: item.customerId ?? null,
      customer_name: item.customerName ?? null,
      table_session_id: item.tableSessionId ?? null,
      table_number: item.tableNumber ?? null,
      subtotal: item.subtotal ?? 0,
      discount_total: item.discountTotal ?? 0,
      tax_total: item.taxTotal ?? 0,
      tax_breakdown: item.taxBreakdown ? (typeof item.taxBreakdown === "string" ? item.taxBreakdown : JSON.stringify(item.taxBreakdown)) : "[]",
      delivery_charge: item.deliveryCharge ?? 0,
      driver_compensation: item.driverCompensation ?? 0,
      coupon_code_id: item.couponCodeId ?? null,
      total: item.total ?? 0,
      gratuity: item.gratuity ?? 0,
      amount_paid: item.amountPaid ?? 0,
      change_given: item.changeGiven ?? 0,
      status: item.status ?? "COMPLETED",
      cashier_id: item.cashierId ?? null,
      cashier_name: item.cashierName ?? null,
      created_at: item.createdAt ? Math.floor(new Date(item.createdAt as string).getTime() / 1000) : null,
      voided_at: item.voidedAt ? Math.floor(new Date(item.voidedAt as string).getTime() / 1000) : null,
      void_reason: item.voidReason ?? null,
      data: item.data ? (typeof item.data === "string" ? item.data : JSON.stringify(item.data)) : null,
      sync_status: "SYNCED",
    }));

    const db = getDb();
    const count = this.upsertRows("sales", rows, [
      "id", "tenant_id", "location_id", "terminal_id", "receipt_number", "order_type",
      "customer_id", "customer_name", "table_session_id", "table_number",
      "subtotal", "discount_total", "tax_total", "tax_breakdown",
      "delivery_charge", "driver_compensation", "coupon_code_id",
      "total", "gratuity", "amount_paid", "change_given",
      "status", "cashier_id", "cashier_name",
      "created_at", "voided_at", "void_reason", "data", "sync_status",
    ]);

    // Handle deletions
    const deletedIds = (res.data as PaginatedResponse)?.deletedIds;
    if (deletedIds && deletedIds.length > 0) {
      for (const delId of deletedIds) {
        db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(delId);
        db.prepare("DELETE FROM sales WHERE id = ?").run(delId);
      }
    }

    this.updateSyncState("sales", count);
    return { entity: "sales", pulled: count, errors: [] };
  }

  private async pullSaleItems(): Promise<PullResult> {
    const res = await this.cloudClient.get<PaginatedResponse>("/api/hub/sync/sale-items", {});
    if (!res.ok) {
      if (res.status === 404) return { entity: "sale_items", pulled: 0, errors: [] };
      return { entity: "sale_items", pulled: 0, errors: [res.error ?? `HTTP ${res.status}`] };
    }

    const rawItems = extractItems(res.data);
    const rows = rawItems.map((item) => ({
      id: item.id,
      sale_id: item.saleId,
      product_id: item.productId ?? null,
      product_name: item.productName ?? "",
      variant_id: item.variantId ?? null,
      variant_name: item.variantName ?? null,
      quantity: item.quantity ?? 1,
      unit_price: item.unitPrice ?? 0,
      discount: item.discount ?? 0,
      discount_type: item.discountType ?? null,
      tax: item.taxAmount ?? item.tax ?? 0,
      tax_rate: item.taxRate ?? 0,
      tax_type_ids: item.taxTypeIds ? (typeof item.taxTypeIds === "string" ? item.taxTypeIds : JSON.stringify(item.taxTypeIds)) : "[]",
      total: item.total ?? 0,
      notes: item.notes ?? null,
      modifiers: item.modifiers ? (typeof item.modifiers === "string" ? item.modifiers : JSON.stringify(item.modifiers)) : null,
      metadata: item.metadata ? (typeof item.metadata === "string" ? item.metadata : JSON.stringify(item.metadata)) : null,
      weight: item.weight ?? null,
      weight_unit: item.weightUnit ?? null,
      product_kit_id: item.productKitId ?? null,
    }));

    const count = this.upsertRows("sale_items", rows, [
      "id", "sale_id", "product_id", "product_name", "variant_id", "variant_name",
      "quantity", "unit_price", "discount", "discount_type",
      "tax", "tax_rate", "tax_type_ids", "total",
      "notes", "modifiers", "metadata", "weight", "weight_unit", "product_kit_id",
    ]);
    this.updateSyncState("sale_items", count);
    return { entity: "sale_items", pulled: count, errors: [] };
  }

  // --- Caller ID Config (synced from cloud) ---
  private async pullCallerIdConfig(): Promise<PullResult> {
    const state = this.getSyncState("caller_id_config");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const rows = await this.fetchAndTransform("/api/hub/sync/caller-id-config", params);

    const count = this.upsertRows("caller_id_config", rows, [
      "id", "location_id", "tenant_id", "enabled",
      "hardware_type", "line_count", "connection_mode",
      "udp_port", "udp_listener_host", "cloud_relay_url", "cloud_relay_token",
      "push_method", "polling_interval",
      "auto_lookup_customer", "log_all_calls",
      "show_caller_animation", "popup_on_incoming", "play_ring_sound",
      "created_at", "updated_at",
    ]);
    this.updateSyncState("caller_id_config", count);
    return { entity: "caller_id_config", pulled: count, errors: [] };
  }

  // --- Caller ID Lines (synced from cloud) ---
  private async pullCallerIdLines(): Promise<PullResult> {
    const state = this.getSyncState("caller_id_lines");
    const params: Record<string, string> = {};
    if (state.last_synced_at) params.sinceVersion = state.last_synced_at;

    const rows = await this.fetchAndTransform("/api/hub/sync/caller-id-lines", params);

    const count = this.upsertRows("caller_id_lines", rows, [
      "id", "config_id", "line_number", "label", "enabled",
      "default_order_type", "ring_sound", "priority", "color",
      "created_at", "updated_at",
    ]);
    this.updateSyncState("caller_id_lines", count);
    return { entity: "caller_id_lines", pulled: count, errors: [] };
  }
}
