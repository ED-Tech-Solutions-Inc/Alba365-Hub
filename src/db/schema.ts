import type Database from "better-sqlite3";

/**
 * Hub v2 SQLite Schema
 * All tables that mirror the cloud Prisma schema for offline POS operation.
 * Tables are organized by domain: system, reference data, operational, transactional.
 */
export function initializeSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    -- ============================================================
    -- CALLER ID TABLES
    -- ============================================================

    CREATE TABLE IF NOT EXISTS caller_id_config (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      tenant_id TEXT,
      enabled INTEGER DEFAULT 0,
      hardware_type TEXT DEFAULT 'BASIC_ETHERNET',
      line_count INTEGER DEFAULT 2,
      connection_mode TEXT DEFAULT 'UDP',
      udp_port INTEGER DEFAULT 3520,
      udp_listener_host TEXT,
      cloud_relay_url TEXT,
      cloud_relay_token TEXT,
      push_method TEXT DEFAULT 'WEBSOCKET',
      polling_interval INTEGER DEFAULT 3,
      auto_lookup_customer INTEGER DEFAULT 1,
      log_all_calls INTEGER DEFAULT 0,
      show_caller_animation INTEGER DEFAULT 1,
      popup_on_incoming INTEGER DEFAULT 1,
      play_ring_sound INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_caller_id_config_location ON caller_id_config(location_id);

    CREATE TABLE IF NOT EXISTS caller_id_lines (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL REFERENCES caller_id_config(id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      default_order_type TEXT,
      ring_sound TEXT DEFAULT 'default',
      priority INTEGER DEFAULT 1,
      color TEXT DEFAULT '#3B82F6',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(config_id, line_number)
    );

    CREATE TABLE IF NOT EXISTS call_log (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      direction TEXT NOT NULL DEFAULT 'INBOUND',
      phone_number TEXT,
      caller_name TEXT,
      call_started_at TEXT NOT NULL DEFAULT (datetime('now')),
      call_ended_at TEXT,
      duration_seconds INTEGER,
      ring_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'RINGING',
      customer_id TEXT,
      order_id TEXT,
      order_type TEXT,
      handled_by_id TEXT,
      raw_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_call_log_location_status ON call_log(location_id, status);
    CREATE INDEX IF NOT EXISTS idx_call_log_phone ON call_log(phone_number);
    CREATE INDEX IF NOT EXISTS idx_call_log_location_created ON call_log(location_id, created_at);

    -- ============================================================
    -- SYSTEM TABLES
    -- ============================================================

    CREATE TABLE IF NOT EXISTS sync_state (
      entity_type TEXT PRIMARY KEY,
      last_synced_at TEXT,
      last_version TEXT,
      cursor TEXT,
      record_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'IDLE',
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS outbox_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'create',
      payload TEXT NOT NULL,
      correlation_id TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_queue(status);
    CREATE INDEX IF NOT EXISTS idx_outbox_entity ON outbox_queue(entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      local_data TEXT NOT NULL,
      cloud_data TEXT NOT NULL,
      local_version TEXT,
      cloud_version TEXT,
      resolution TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_sequence (
      date_key TEXT PRIMARY KEY,
      current_value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS resource_locks (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      locked_by TEXT NOT NULL,
      terminal_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(resource_type, resource_id)
    );

    -- ============================================================
    -- REFERENCE DATA (synced from cloud, read-only on hub)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      pin_hash TEXT,
      role TEXT DEFAULT 'cashier',
      permissions TEXT DEFAULT '[]',
      max_discount REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_pin ON users(pin_hash);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      sort_order INTEGER DEFAULT 0,
      color TEXT,
      image_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      category_id TEXT,
      description TEXT,
      base_price REAL NOT NULL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      tax_type_id TEXT,
      tax_type_ids TEXT DEFAULT '[]',
      product_type TEXT DEFAULT 'STANDARD',
      is_active INTEGER DEFAULT 1,
      is_weighable INTEGER DEFAULT 0,
      track_inventory INTEGER DEFAULT 0,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      price REAL NOT NULL,
      cost_price REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

    CREATE TABLE IF NOT EXISTS product_order_type_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS variant_order_type_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (variant_id) REFERENCES product_variants(id)
    );

    CREATE TABLE IF NOT EXISTS tax_types (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      rate REAL NOT NULL,
      code TEXT,
      is_active INTEGER DEFAULT 1,
      apply_to_all INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tax_types_tenant ON tax_types(tenant_id);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      notes TEXT,
      loyalty_points INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);

    CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      tenant_id TEXT,
      label TEXT,
      unit_number TEXT,
      address TEXT,
      address_notes TEXT,
      buzzer_number TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      delivery_instructions TEXT,
      delivery_charge REAL DEFAULT 0,
      driver_compensation REAL DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS discount_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      value REAL NOT NULL,
      scope TEXT DEFAULT 'ITEM',
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS gift_cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      initial_balance REAL NOT NULL,
      current_balance REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);

    CREATE TABLE IF NOT EXISTS coupon_codes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL,
      min_order_amount REAL DEFAULT 0,
      max_uses INTEGER,
      current_uses INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      starts_at TEXT,
      expires_at TEXT,
      order_types TEXT DEFAULT '[]',
      category_ids TEXT DEFAULT '[]',
      product_ids TEXT DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupon_codes(code);

    -- ============================================================
    -- MODIFIER SYSTEM
    -- ============================================================

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      selection_type TEXT DEFAULT 'MULTIPLE',
      min_qty INTEGER DEFAULT 0,
      max_qty INTEGER DEFAULT 0,
      free_selections INTEGER DEFAULT 0,
      allow_quantity INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS modifiers (
      id TEXT PRIMARY KEY,
      modifier_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price_type TEXT DEFAULT 'FIXED',
      price_adjustment REAL DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      linked_product_id TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id)
    );

    CREATE TABLE IF NOT EXISTS product_modifier_groups (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      modifier_group_id TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      is_required INTEGER DEFAULT 0,
      free_selections_override INTEGER,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id)
    );

    -- ============================================================
    -- PRODUCT KITS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS product_kits (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category_id TEXT,
      price REAL NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS product_kit_items (
      id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (kit_id) REFERENCES product_kits(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- ============================================================
    -- PIZZA MODULE
    -- ============================================================

    CREATE TABLE IF NOT EXISTS pizza_module_config (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pizza_location_config (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 1,
      half_and_half_enabled INTEGER DEFAULT 1,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS pizza_sizes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_crusts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_sauces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_cheeses (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_toppings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category_id TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_topping_categories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pizza_size_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      product_id TEXT,
      base_price REAL NOT NULL DEFAULT 0,
      is_available INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pizza_topping_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      topping_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      product_id TEXT,
      light_price REAL DEFAULT 0,
      regular_price REAL DEFAULT 0,
      extra_price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pizza_crust_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      crust_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      product_id TEXT,
      upcharge REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pizza_sauce_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      sauce_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      product_id TEXT,
      light_price REAL DEFAULT 0,
      regular_price REAL DEFAULT 0,
      extra_price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pizza_cheese_prices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      cheese_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      product_id TEXT,
      light_price REAL DEFAULT 0,
      regular_price REAL DEFAULT 0,
      extra_price REAL DEFAULT 0
    );

    -- ============================================================
    -- DEALS MODULE
    -- ============================================================

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      config_id TEXT,
      name TEXT NOT NULL,
      code TEXT,
      deal_type TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      min_order_amount REAL DEFAULT 0,
      max_uses_total INTEGER,
      max_uses_per_customer INTEGER,
      max_uses_per_order INTEGER DEFAULT 1,
      current_uses INTEGER DEFAULT 0,
      order_types TEXT DEFAULT '[]',
      location_ids TEXT DEFAULT '[]',
      free_toppings INTEGER DEFAULT 0,
      can_stack INTEGER DEFAULT 0,
      allow_discount INTEGER DEFAULT 1,
      allow_coupon INTEGER DEFAULT 1,
      starts_at TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deal_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      product_id TEXT,
      category_id TEXT,
      role TEXT NOT NULL DEFAULT 'QUALIFIER',
      quantity INTEGER DEFAULT 1,
      min_quantity INTEGER DEFAULT 1,
      discount_type TEXT,
      discount_value REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      allow_pizza INTEGER DEFAULT 0,
      allow_variant_selection INTEGER DEFAULT 0,
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );

    CREATE TABLE IF NOT EXISTS deal_time_restrictions (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );

    CREATE TABLE IF NOT EXISTS deal_size_prices (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      size_id TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );

    CREATE TABLE IF NOT EXISTS deal_size_order_type_prices (
      id TEXT PRIMARY KEY,
      size_price_id TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (size_price_id) REFERENCES deal_size_prices(id)
    );

    -- ============================================================
    -- LOCATION CONFIGURATION
    -- ============================================================

    CREATE TABLE IF NOT EXISTS location_settings (
      location_id TEXT PRIMARY KEY,
      name TEXT,
      restaurant_mode INTEGER DEFAULT 0,
      order_type_dine_in INTEGER DEFAULT 1,
      order_type_take_out INTEGER DEFAULT 1,
      order_type_delivery INTEGER DEFAULT 1,
      order_type_drive_through INTEGER DEFAULT 0,
      order_type_third_party INTEGER DEFAULT 0,
      enable_floor_plan INTEGER DEFAULT 0,
      enable_tips INTEGER DEFAULT 0,
      enable_reservations INTEGER DEFAULT 0,
      enable_waitlist INTEGER DEFAULT 0,
      allow_check_in_without_order INTEGER DEFAULT 0,
      allow_per_guest_ordering INTEGER DEFAULT 0,
      post_order_action TEXT DEFAULT 'STAY_ON_ORDER_ENTRY',
      hold_table_action TEXT DEFAULT 'STAY_ON_ORDER_ENTRY',
      allow_price_override INTEGER DEFAULT 0,
      address TEXT,
      phone TEXT,
      email TEXT,
      timezone TEXT DEFAULT 'America/Toronto',
      currency TEXT DEFAULT 'CAD',
      tax_rate REAL DEFAULT 0,
      dark_mode INTEGER DEFAULT 1,
      default_drawer_float REAL DEFAULT 100,
      -- Kitchen print settings
      kitchen_print_price INTEGER DEFAULT 0,
      kitchen_print_mode TEXT DEFAULT 'NEW_ONLY',
      kitchen_show_modifiers INTEGER DEFAULT 1,
      kitchen_show_notes INTEGER DEFAULT 1,
      kitchen_show_total INTEGER DEFAULT 0,
      kitchen_show_customer_name INTEGER DEFAULT 1,
      kitchen_show_table_number INTEGER DEFAULT 1,
      kitchen_large_font INTEGER DEFAULT 0,
      kitchen_show_order_age INTEGER DEFAULT 1,
      -- Cash drawer settings
      drawer_open_on_cash INTEGER DEFAULT 1,
      drawer_open_on_pay_in_out INTEGER DEFAULT 1,
      drawer_manual_open INTEGER DEFAULT 1,
      -- Receipt two-color settings
      receipt_red_void INTEGER DEFAULT 1,
      receipt_red_modifiers INTEGER DEFAULT 1,
      receipt_red_notes INTEGER DEFAULT 1,
      receipt_red_modified INTEGER DEFAULT 1,
      -- Delivery fee tax
      delivery_fee_tax_type_ids TEXT DEFAULT '[]',
      -- Auto-gratuity
      auto_gratuity_enabled INTEGER DEFAULT 0,
      auto_gratuity_threshold INTEGER DEFAULT 8,
      auto_gratuity_percentage REAL DEFAULT 18,
      delivery_charge REAL DEFAULT 0,
      tax_included INTEGER DEFAULT 0,
      receipt_header TEXT,
      receipt_footer TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS terminal_settings (
      terminal_id TEXT PRIMARY KEY,
      name TEXT,
      dark_mode INTEGER DEFAULT 1,
      cart_position TEXT DEFAULT 'right',
      restaurant_mode INTEGER DEFAULT 0,
      default_order_type TEXT DEFAULT 'TAKE_OUT',
      auto_print_receipt INTEGER DEFAULT 1,
      auto_print_kitchen INTEGER DEFAULT 1,
      auto_logout_after_send_order INTEGER DEFAULT 0,
      auto_logout_after_payment INTEGER DEFAULT 0,
      auto_logout_timeout INTEGER,
      block_clock_out_with_open_orders INTEGER DEFAULT 0,
      allow_shared_cash_drawer INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS location_taxes (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      tax_type_id TEXT NOT NULL,
      rate REAL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS location_category_taxes (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      tax_type_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location_product_overrides (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      product_id TEXT,
      variant_id TEXT,
      kit_id TEXT,
      price REAL,
      cost_price REAL,
      is_available INTEGER DEFAULT 1,
      tax_type_ids TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS location_business_hours (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      open_time TEXT,
      close_time TEXT,
      is_closed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS note_presets (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      usage_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS post_codes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      code TEXT NOT NULL,
      delivery_charge REAL DEFAULT 0,
      driver_compensation REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    -- ============================================================
    -- RESTAURANT TABLES & FLOOR PLANS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS floors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      background_image TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      floor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (floor_id) REFERENCES floors(id)
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      floor_id TEXT,
      area_id TEXT,
      name TEXT NOT NULL,
      capacity INTEGER DEFAULT 4,
      shape TEXT DEFAULT 'SQUARE',
      x_position REAL DEFAULT 0,
      y_position REAL DEFAULT 0,
      width REAL DEFAULT 100,
      height REAL DEFAULT 100,
      rotation REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (area_id) REFERENCES areas(id)
    );

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      auto_fire INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT,
      party_size INTEGER DEFAULT 2,
      reservation_date TEXT NOT NULL,
      reservation_time TEXT NOT NULL,
      status TEXT DEFAULT 'CONFIRMED',
      notes TEXT,
      table_id TEXT,
      created_at INTEGER NOT NULL,
      seated_at INTEGER,
      cancelled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS waiting_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT,
      party_size INTEGER DEFAULT 1,
      status TEXT DEFAULT 'WAITING',
      notes TEXT,
      quoted_wait_minutes INTEGER,
      table_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      seated_at INTEGER,
      cancelled_at INTEGER
    );

    -- ============================================================
    -- SCHEDULE & PRICING
    -- ============================================================

    CREATE TABLE IF NOT EXISTS category_schedules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      name TEXT,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      effective_date TEXT,
      expiry_date TEXT,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_schedules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_variant_id TEXT,
      name TEXT,
      price_type TEXT,
      price_value REAL NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      effective_date TEXT,
      expiry_date TEXT,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    -- ============================================================
    -- TRANSACTIONAL DATA (created locally, pushed to cloud)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS kitchen_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      terminal_id TEXT,
      order_number TEXT,
      order_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      table_id TEXT,
      table_name TEXT,
      table_number TEXT,
      table_session_id TEXT,
      customer_id TEXT,
      customer_name TEXT,
      server_id TEXT,
      server_name TEXT,
      subtotal REAL DEFAULT 0,
      discount_total REAL DEFAULT 0,
      tax_total REAL DEFAULT 0,
      total REAL DEFAULT 0,
      gratuity REAL DEFAULT 0,
      priority TEXT DEFAULT 'NORMAL',
      notes TEXT,
      course_id TEXT,
      created_by TEXT,
      items TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      fired_at TEXT,
      prep_started_at TEXT,
      ready_at TEXT,
      completed_at TEXT,
      split_group_id TEXT,
      parent_order_id TEXT,
      is_split_child INTEGER DEFAULT 0,
      split_index INTEGER,
      combined_from_ids TEXT,
      combined_from_numbers TEXT,
      is_combined INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'PENDING'
    );

    CREATE INDEX IF NOT EXISTS idx_ko_status ON kitchen_orders(status);
    CREATE INDEX IF NOT EXISTS idx_ko_location ON kitchen_orders(location_id);
    CREATE INDEX IF NOT EXISTS idx_ko_table ON kitchen_orders(table_session_id);

    CREATE TABLE IF NOT EXISTS kitchen_order_items (
      id TEXT PRIMARY KEY,
      kitchen_order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      variant_id TEXT,
      variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      discount_type TEXT,
      tax REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_type_ids TEXT DEFAULT '[]',
      status TEXT DEFAULT 'PENDING',
      course_id TEXT,
      seat_number INTEGER,
      modifiers TEXT DEFAULT '[]',
      notes TEXT,
      metadata TEXT DEFAULT '{}',
      fired_at TEXT,
      ready_at TEXT,
      served_at TEXT,
      voided_at TEXT,
      void_reason TEXT,
      FOREIGN KEY (kitchen_order_id) REFERENCES kitchen_orders(id)
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      terminal_id TEXT,
      receipt_number TEXT UNIQUE,
      order_type TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      table_session_id TEXT,
      table_number TEXT,
      kitchen_order_id TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_total REAL NOT NULL DEFAULT 0,
      coupon_discount REAL DEFAULT 0,
      coupon_code_id TEXT,
      tax_total REAL NOT NULL DEFAULT 0,
      tax_breakdown TEXT DEFAULT '[]',
      delivery_charge REAL DEFAULT 0,
      driver_compensation REAL DEFAULT 0,
      round_off REAL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      gratuity REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      change_given REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      cashier_id TEXT,
      cashier_name TEXT,
      notes TEXT,
      metadata TEXT DEFAULT '{}',
      data TEXT,
      data_blob TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      voided_at TEXT,
      void_reason TEXT,
      sync_status TEXT DEFAULT 'PENDING'
    );

    CREATE INDEX IF NOT EXISTS idx_sales_location ON sales(location_id);
    CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      variant_id TEXT,
      variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      discount REAL DEFAULT 0,
      discount_type TEXT,
      tax REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_type_ids TEXT DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      notes TEXT,
      modifiers TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      weight REAL,
      weight_unit TEXT,
      product_kit_id TEXT,
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      tip_amount REAL DEFAULT 0,
      reference TEXT,
      card_last_four TEXT,
      card_brand TEXT,
      status TEXT DEFAULT 'COMPLETED',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );

    -- ============================================================
    -- TABLE SESSIONS (dine-in workflow)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS table_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      server_id TEXT,
      server_name TEXT,
      guest_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ACTIVE',
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      notes TEXT,
      FOREIGN KEY (table_id) REFERENCES tables(id)
    );

    CREATE TABLE IF NOT EXISTS guest_checks (
      id TEXT PRIMARY KEY,
      table_session_id TEXT NOT NULL,
      guest_number INTEGER DEFAULT 1,
      subtotal REAL DEFAULT 0,
      tax REAL DEFAULT 0,
      total REAL DEFAULT 0,
      status TEXT DEFAULT 'OPEN',
      FOREIGN KEY (table_session_id) REFERENCES table_sessions(id)
    );

    -- ============================================================
    -- SHIFT & CASH MANAGEMENT
    -- ============================================================

    CREATE TABLE IF NOT EXISTS shift_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      terminal_id TEXT,
      clock_in_at TEXT NOT NULL,
      clock_out_at TEXT,
      break_minutes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE',
      sync_status TEXT DEFAULT 'PENDING'
    );

    CREATE TABLE IF NOT EXISTS shift_breaks (
      id TEXT PRIMARY KEY,
      shift_log_id TEXT NOT NULL,
      type TEXT DEFAULT 'BREAK',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER DEFAULT 0,
      FOREIGN KEY (shift_log_id) REFERENCES shift_logs(id)
    );

    CREATE TABLE IF NOT EXISTS cash_drawers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN',
      opening_balance REAL DEFAULT 0,
      closing_balance REAL,
      expected_balance REAL,
      difference REAL,
      notes TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      closed_by_id TEXT,
      sync_status TEXT DEFAULT 'PENDING'
    );

    CREATE TABLE IF NOT EXISTS cash_drawer_transactions (
      id TEXT PRIMARY KEY,
      cash_drawer_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      reason TEXT,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cash_drawer_id) REFERENCES cash_drawers(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_levels (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      product_variant_id TEXT,
      location_id TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      reserved_quantity REAL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 0,
      reorder_point REAL DEFAULT 0,
      reorder_quantity REAL DEFAULT 0
    );

    -- ============================================================
    -- TERMINALS (hub-managed)
    -- ============================================================

    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      name TEXT,
      device_type TEXT DEFAULT 'flutter',
      last_seen_at TEXT,
      ip_address TEXT,
      status TEXT DEFAULT 'OFFLINE',
      current_user_id TEXT,
      current_user_name TEXT,
      app_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (terminal_id) REFERENCES terminals(id)
    );

    -- ============================================================
    -- WEB ORDER SETTINGS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS web_order_settings (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL,
      alert_enabled INTEGER DEFAULT 1,
      alert_sound TEXT,
      alert_volume INTEGER DEFAULT 80,
      alert_repeat_interval INTEGER DEFAULT 30,
      alert_max_repeats INTEGER DEFAULT 5,
      prep_time_take_out INTEGER DEFAULT 20,
      prep_time_delivery INTEGER DEFAULT 30,
      prep_time_buffer INTEGER DEFAULT 5,
      auto_accept_enabled INTEGER DEFAULT 0,
      auto_accept_max_amount REAL,
      require_decline_reason INTEGER DEFAULT 1,
      decline_reasons TEXT,
      accept_orders_enabled INTEGER DEFAULT 1,
      operating_hours TEXT
    );

    -- ============================================================
    -- ROLES
    -- ============================================================

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT,
      version TEXT,
      synced_at TEXT
    );

    -- ============================================================
    -- STAFF BANKS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS staff_banks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      bank_type TEXT,
      status TEXT DEFAULT 'OPEN',
      opening_balance REAL DEFAULT 0,
      closing_balance REAL,
      expected_balance REAL,
      difference REAL,
      notes TEXT,
      opened_at TEXT,
      closed_at TEXT,
      closed_by_id TEXT,
      card_total REAL,
      tips_collected REAL,
      tips_paid_out REAL,
      version TEXT,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS staff_bank_transactions (
      id TEXT PRIMARY KEY,
      staff_bank_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      reason TEXT,
      user_id TEXT,
      created_at INTEGER,
      synced_at TEXT,
      FOREIGN KEY (staff_bank_id) REFERENCES staff_banks(id)
    );

    -- ============================================================
    -- STORE CREDITS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS store_credits (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      code TEXT,
      initial_amount REAL NOT NULL,
      current_balance REAL NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      reason TEXT,
      refund_id TEXT,
      expires_at INTEGER,
      created_by_id TEXT,
      created_at INTEGER,
      version TEXT,
      synced_at TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- ============================================================
    -- REFUNDS
    -- ============================================================

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      sale_id TEXT NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      tax_refund REAL DEFAULT 0,
      method TEXT NOT NULL DEFAULT 'ORIGINAL',
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
      requested_by_id TEXT,
      requested_by_name TEXT,
      approved_by_id TEXT,
      approved_by_name TEXT,
      approved_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );

    CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
    CREATE INDEX IF NOT EXISTS idx_refunds_location ON refunds(location_id);

    CREATE TABLE IF NOT EXISTS refund_items (
      id TEXT PRIMARY KEY,
      refund_id TEXT NOT NULL,
      sale_item_id TEXT,
      product_id TEXT,
      product_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      tax REAL DEFAULT 0,
      reason TEXT,
      FOREIGN KEY (refund_id) REFERENCES refunds(id)
    );

    -- ============================================================
    -- PIZZA SIZE ORDER TYPE PRICES
    -- ============================================================

    CREATE TABLE IF NOT EXISTS pizza_size_order_type_prices (
      id TEXT PRIMARY KEY,
      size_price_id TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL NOT NULL,
      synced_at TEXT,
      FOREIGN KEY (size_price_id) REFERENCES pizza_size_prices(id)
    );
  `);

  // --- Migrations for existing databases ---
  // These ALTER TABLE statements fix schema gaps. Each is wrapped in try/catch
  // because the column may already exist (on fresh databases with corrected CREATE TABLE).
  const migrations: string[] = [
    // sync_state: rename last_sync_at → last_synced_at, add status + updated_at
    "ALTER TABLE sync_state ADD COLUMN last_synced_at TEXT",
    "ALTER TABLE sync_state ADD COLUMN status TEXT DEFAULT 'IDLE'",
    "ALTER TABLE sync_state ADD COLUMN updated_at TEXT",
    // outbox_queue: rename retry_count → attempts, max_retries → max_attempts, error_message → error
    "ALTER TABLE outbox_queue ADD COLUMN attempts INTEGER DEFAULT 0",
    "ALTER TABLE outbox_queue ADD COLUMN max_attempts INTEGER DEFAULT 5",
    "ALTER TABLE outbox_queue ADD COLUMN error TEXT",
    // deal_items: add missing columns
    "ALTER TABLE deal_items ADD COLUMN quantity INTEGER DEFAULT 1",
    "ALTER TABLE deal_items ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE deal_items ADD COLUMN allow_pizza INTEGER DEFAULT 0",
    "ALTER TABLE deal_items ADD COLUMN allow_variant_selection INTEGER DEFAULT 0",
    // tables: add floor_id column, make area_id nullable (already nullable in CREATE TABLE)
    "ALTER TABLE tables ADD COLUMN floor_id TEXT",
    // pizza_location_config: add data column
    "ALTER TABLE pizza_location_config ADD COLUMN data TEXT",
    // post_codes: add is_active
    "ALTER TABLE post_codes ADD COLUMN is_active INTEGER DEFAULT 1",
    // customer_addresses: add missing columns
    "ALTER TABLE customer_addresses ADD COLUMN tenant_id TEXT",
    "ALTER TABLE customer_addresses ADD COLUMN label TEXT",
    "ALTER TABLE customer_addresses ADD COLUMN unit_number TEXT",
    "ALTER TABLE customer_addresses ADD COLUMN address_notes TEXT",
    "ALTER TABLE customer_addresses ADD COLUMN buzzer_number TEXT",
    "ALTER TABLE customer_addresses ADD COLUMN delivery_charge REAL DEFAULT 0",
    "ALTER TABLE customer_addresses ADD COLUMN driver_compensation REAL DEFAULT 0",
    "ALTER TABLE customer_addresses ADD COLUMN is_active INTEGER DEFAULT 1",
    // kitchen_orders: add columns for cloud sync parity
    "ALTER TABLE kitchen_orders ADD COLUMN table_number TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN priority TEXT DEFAULT 'NORMAL'",
    "ALTER TABLE kitchen_orders ADD COLUMN created_by TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN prep_started_at TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN ready_at TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN data TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN split_group_id TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN parent_order_id TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN is_split_child INTEGER DEFAULT 0",
    "ALTER TABLE kitchen_orders ADD COLUMN split_index INTEGER",
    "ALTER TABLE kitchen_orders ADD COLUMN combined_from_ids TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN combined_from_numbers TEXT",
    "ALTER TABLE kitchen_orders ADD COLUMN is_combined INTEGER DEFAULT 0",
    // kitchen_order_items: add financial + timing columns
    "ALTER TABLE kitchen_order_items ADD COLUMN discount REAL DEFAULT 0",
    "ALTER TABLE kitchen_order_items ADD COLUMN discount_type TEXT",
    "ALTER TABLE kitchen_order_items ADD COLUMN tax REAL DEFAULT 0",
    "ALTER TABLE kitchen_order_items ADD COLUMN tax_rate REAL DEFAULT 0",
    "ALTER TABLE kitchen_order_items ADD COLUMN tax_type_ids TEXT DEFAULT '[]'",
    "ALTER TABLE kitchen_order_items ADD COLUMN fired_at TEXT",
    "ALTER TABLE kitchen_order_items ADD COLUMN ready_at TEXT",
    "ALTER TABLE kitchen_order_items ADD COLUMN served_at TEXT",
    // sales: add columns for cloud sync parity
    "ALTER TABLE sales ADD COLUMN table_number TEXT",
    "ALTER TABLE sales ADD COLUMN driver_compensation REAL DEFAULT 0",
    "ALTER TABLE sales ADD COLUMN coupon_code_id TEXT",
    "ALTER TABLE sales ADD COLUMN data TEXT",
    // sale_items: add financial + metadata columns
    "ALTER TABLE sale_items ADD COLUMN tax_rate REAL DEFAULT 0",
    "ALTER TABLE sale_items ADD COLUMN tax_type_ids TEXT DEFAULT '[]'",
    "ALTER TABLE sale_items ADD COLUMN notes TEXT",
    "ALTER TABLE sale_items ADD COLUMN weight REAL",
    "ALTER TABLE sale_items ADD COLUMN weight_unit TEXT",
    "ALTER TABLE sale_items ADD COLUMN product_kit_id TEXT",
    // inventory_levels: add reorder columns
    "ALTER TABLE inventory_levels ADD COLUMN reorder_point REAL DEFAULT 0",
    "ALTER TABLE inventory_levels ADD COLUMN reorder_quantity REAL DEFAULT 0",
    // category_schedules: add missing columns
    "ALTER TABLE category_schedules ADD COLUMN name TEXT",
    "ALTER TABLE category_schedules ADD COLUMN effective_date TEXT",
    "ALTER TABLE category_schedules ADD COLUMN expiry_date TEXT",
    "ALTER TABLE category_schedules ADD COLUMN is_active INTEGER DEFAULT 1",
    // price_schedules: add missing columns
    "ALTER TABLE price_schedules ADD COLUMN product_variant_id TEXT",
    "ALTER TABLE price_schedules ADD COLUMN name TEXT",
    "ALTER TABLE price_schedules ADD COLUMN price_type TEXT",
    "ALTER TABLE price_schedules ADD COLUMN effective_date TEXT",
    "ALTER TABLE price_schedules ADD COLUMN expiry_date TEXT",
    "ALTER TABLE price_schedules ADD COLUMN is_active INTEGER DEFAULT 1",
    "ALTER TABLE price_schedules ADD COLUMN priority INTEGER DEFAULT 0",
    // cash_drawers: add notes
    "ALTER TABLE cash_drawers ADD COLUMN notes TEXT",
    // cash_drawer_transactions: add reason
    "ALTER TABLE cash_drawer_transactions ADD COLUMN reason TEXT",
    // location_settings: add missing settings columns
    "ALTER TABLE location_settings ADD COLUMN enable_floor_plan INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN enable_tips INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN enable_reservations INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN enable_waitlist INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN allow_check_in_without_order INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN allow_per_guest_ordering INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN post_order_action TEXT DEFAULT 'STAY_ON_ORDER_ENTRY'",
    "ALTER TABLE location_settings ADD COLUMN hold_table_action TEXT DEFAULT 'STAY_ON_ORDER_ENTRY'",
    "ALTER TABLE location_settings ADD COLUMN allow_price_override INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN address TEXT",
    "ALTER TABLE location_settings ADD COLUMN phone TEXT",
    "ALTER TABLE location_settings ADD COLUMN email TEXT",
    "ALTER TABLE location_settings ADD COLUMN tax_rate REAL DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN default_drawer_float REAL DEFAULT 100",
    "ALTER TABLE location_settings ADD COLUMN kitchen_print_price INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN kitchen_print_mode TEXT DEFAULT 'NEW_ONLY'",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_modifiers INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_notes INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_total INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_customer_name INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_table_number INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN kitchen_large_font INTEGER DEFAULT 0",
    "ALTER TABLE location_settings ADD COLUMN kitchen_show_order_age INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN drawer_open_on_cash INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN drawer_open_on_pay_in_out INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN drawer_manual_open INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN receipt_red_void INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN receipt_red_modifiers INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN receipt_red_notes INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN receipt_red_modified INTEGER DEFAULT 1",
    "ALTER TABLE location_settings ADD COLUMN delivery_fee_tax_type_ids TEXT DEFAULT '[]'",
    // terminal_settings: add missing columns
    "ALTER TABLE terminal_settings ADD COLUMN auto_logout_after_send_order INTEGER DEFAULT 0",
    "ALTER TABLE terminal_settings ADD COLUMN auto_logout_after_payment INTEGER DEFAULT 0",
    "ALTER TABLE terminal_settings ADD COLUMN auto_logout_timeout INTEGER",
    "ALTER TABLE terminal_settings ADD COLUMN block_clock_out_with_open_orders INTEGER DEFAULT 0",
    "ALTER TABLE terminal_settings ADD COLUMN allow_shared_cash_drawer INTEGER DEFAULT 0",
    // reservations table (local-only, not synced from cloud)
    `CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT,
      party_size INTEGER DEFAULT 2,
      reservation_date TEXT NOT NULL,
      reservation_time TEXT NOT NULL,
      status TEXT DEFAULT 'CONFIRMED',
      notes TEXT,
      table_id TEXT,
      created_at INTEGER NOT NULL,
      seated_at INTEGER,
      cancelled_at INTEGER
    )`,
    // waiting_queue table (local-only, not synced from cloud)
    `CREATE TABLE IF NOT EXISTS waiting_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT,
      party_size INTEGER DEFAULT 1,
      status TEXT DEFAULT 'WAITING',
      notes TEXT,
      quoted_wait_minutes INTEGER,
      table_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      seated_at INTEGER,
      cancelled_at INTEGER
    )`,
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  // Copy old column data to new column names if old columns exist
  try {
    // sync_state: copy last_sync_at → last_synced_at if last_synced_at is null
    db.exec("UPDATE sync_state SET last_synced_at = last_sync_at WHERE last_synced_at IS NULL AND last_sync_at IS NOT NULL");
  } catch { /* old column may not exist */ }

  try {
    // outbox_queue: copy retry_count → attempts, max_retries → max_attempts, error_message → error
    db.exec("UPDATE outbox_queue SET attempts = retry_count WHERE attempts = 0 AND retry_count > 0");
    db.exec("UPDATE outbox_queue SET max_attempts = max_retries WHERE max_attempts = 5 AND max_retries != 5");
    db.exec("UPDATE outbox_queue SET error = error_message WHERE error IS NULL AND error_message IS NOT NULL");
  } catch { /* old columns may not exist */ }
}
