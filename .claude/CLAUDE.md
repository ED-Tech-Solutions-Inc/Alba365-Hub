# Alba365 Hub v2 — Project Documentation

> **Version**: 0.1.0 | **Last Updated**: February 26, 2026 | **Architecture**: Offline-First Sync Hub

---

## Three Repositories (CRITICAL — commit to the correct repo)

| Repo | GitHub | What goes here |
|------|--------|----------------|
| **pos-system** | `edtechsolution/Retail-pos` | Web app, Hub v1 (Web/Electron), Electron, Prisma, all portals |
| **Alba365-App** | `ED-Tech-Solutions-Inc/Alba365-App` | Flutter POS only (`apps/flutter_pos/`) |
| **Alba365-Hub** | `ED-Tech-Solutions-Inc/Alba365-Hub` | **This repo** — Hub v2 only (Fastify 5 + SQLite, Flutter-facing, port 4001) |

- Flutter POS connects to Hub v2 via HTTP — no source imports between repos
- Hub v2 syncs with Cloud (Azure PostgreSQL) — never talks to Hub v1 directly
- When modifying Flutter files: commit to Alba365-App
- When modifying web/hub-v1/electron files: commit to pos-system
- When modifying hub v2 files: commit here (Alba365-Hub)

---

## CRITICAL: NO CODING WITHOUT APPROVAL

```
+-------------------------------------------------------------------------+
|  STOP! Claude MUST get explicit user approval before writing ANY code.   |
|                                                                          |
|  DO NOT: Start coding immediately after receiving a task                 |
|  DO NOT: Make assumptions about implementation approach                  |
|  DO NOT: Write code while explaining what you "will do"                  |
|                                                                          |
|  DO: Explain your understanding of the task                              |
|  DO: Present your proposed approach                                      |
|  DO: List files to modify                                                |
|  DO: WAIT for user to say "yes", "approved", "go ahead", etc.           |
|  DO: Only THEN start writing code                                        |
+-------------------------------------------------------------------------+
```

**Approval Keywords to Wait For:** `yes`, `approved`, `go ahead`, `proceed`, `do it`, `ok`, `sounds good`

### The 5-Step Protocol (NO EXCEPTIONS)

| Step | Action | Example |
|------|--------|---------|
| **1. IDENTIFY** | State the area of Hub v2 affected | `Modifying: Sync Engine (pull-sync)` |
| **2. UNDERSTAND** | Explain task back in plain language | "You want me to add inventory sync..." |
| **3. PROPOSE** | Present approach with key files | "I'll add a new entity handler in pull-sync.ts..." |
| **4. WAIT** | **STOP and wait for user approval** | User must say "yes", "approved", etc. |
| **5. EXECUTE** | Only after approval, start coding | Follow patterns from this doc |

---

## Quick Stats

| Metric | Value |
|--------|-------|
| Source Files | 39 TypeScript |
| Total LOC | ~7,120 |
| API Route Files | 27 |
| API Route Groups | 30 |
| API Endpoints | ~150 |
| SQLite Tables | 85 |
| Sync Entity Types | 14+ (pull) / 5 (push) |
| WebSocket Events | 8 |
| Dependencies | 12 production + 6 dev |

---

## Architecture

```
Flutter POS (native)  <-->  Hub v2 (port 4001)  <-->  Cloud (Azure PostgreSQL)
     |                          |
  Drift SQLite             better-sqlite3
  (offline cache)          (full hub DB)
  (outbox queue)           (85 tables)

  Pull sync: Cloud --> Hub v2 SQLite (30s interval, reference data)
  Push sync: Hub v2 outbox --> Cloud (5s interval, sales/KO/shifts)
  WebSocket: Hub v2 --> Flutter terminals (real-time KDS/table events)
```

### Hub in the Ecosystem

```
+-----------+     +---------------+     +-----------+
| Cloud     |     | Hub v2        |     | Flutter   |
| (Azure    |<--->| (This repo)   |<--->| POS       |
| PostgreSQL|     | SQLite, :4001 |     | (Dart)    |
+-----------+     +---------------+     +-----------+
                        |
                  mDNS discovery
                  (bonjour-service)
```

- **One hub per location** — standalone Fastify server with SQLite
- **Cloud is the backup** — push/pull sync (outbox pattern)
- **Flutter thin client** — all writes go through hub API
- **Offline-first** — hub operates fully without cloud connectivity

---

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| HTTP Server | Fastify | 5.3.0 |
| Database | better-sqlite3 | 11.7.0 |
| Language | TypeScript | 5 |
| Runtime | Node.js | 20 (slim) |
| WebSocket | @fastify/websocket | 11.0.2 |
| CORS | @fastify/cors | 11.0.0 |
| Auth (PIN) | bcryptjs | 2.4.3 |
| Validation | Zod | 4.3.5 |
| Logging | Pino + pino-pretty | 9.6.0 / 13.0.0 |
| IDs | nanoid | 5.0.9 |
| Dates | date-fns | 4.1.0 |
| Service Discovery | bonjour-service | 1.3.0 |
| Env Vars | dotenv | 17.2.3 |
| Dev Runner | tsx | 4.19.0 |

---

## Project Structure

```
Alba365-Hub/
+-- src/
|   +-- index.ts                    # Entry point, startup, heartbeat (153 LOC)
|   +-- server.ts                   # Fastify app, plugin/route registration (115 LOC)
|   +-- config.ts                   # 3-layer config: env -> disk -> defaults (137 LOC)
|   +-- db/
|   |   +-- schema.ts              # 85 SQLite tables, CREATE statements (1,315 LOC)
|   |   +-- index.ts               # DB init, WAL mode, pragmas (83 LOC)
|   +-- api/                       # 27 route files (3,617 LOC total)
|   |   +-- auth.ts                # PIN auth, session mgmt (169 LOC)
|   |   +-- bootstrap.ts           # Single-request POS init (151 LOC)
|   |   +-- health.ts              # Health + diagnostics (216 LOC)
|   |   +-- setup.ts               # Hub registration + config (294 LOC)
|   |   +-- kitchen-orders.ts      # KO CRUD + status updates (309 LOC)
|   |   +-- sales.ts               # Sale creation, list, refund (166 LOC)
|   |   +-- orders.ts              # Order queries + status (172 LOC)
|   |   +-- terminals.ts           # Terminal registration (172 LOC)
|   |   +-- users.ts               # User queries + permissions (160 LOC)
|   |   +-- gift-cards.ts          # Balance, redeem, create (152 LOC)
|   |   +-- shifts.ts              # Clock in/out, breaks (139 LOC)
|   |   +-- guest-checks.ts        # Guest check CRUD + settle (121 LOC)
|   |   +-- customers.ts           # Customer CRUD + search (110 LOC)
|   |   +-- tables.ts              # Floor plans, table status (108 LOC)
|   |   +-- cash-drawers.ts        # Drawer open/close, pay-in/out (103 LOC)
|   |   +-- diagnostics.ts         # Sync stats, terminal count (100 LOC)
|   |   +-- sync.ts                # Push/pull status, manual triggers (78 LOC)
|   |   +-- inventory.ts           # Stock levels, adjustments (68 LOC)
|   |   +-- modifiers.ts           # Modifier groups + items (62 LOC)
|   |   +-- pizza.ts               # Pizza config + pricing (61 LOC)
|   |   +-- products.ts            # Product queries + search (58 LOC)
|   |   +-- sequence.ts            # Receipt number generation (57 LOC)
|   |   +-- audit-logs.ts          # Audit log queries (52 LOC)
|   |   +-- deals.ts               # Deal queries (47 LOC)
|   |   +-- receipts.ts            # Receipt generation (45 LOC)
|   |   +-- taxes.ts               # Tax queries (23 LOC)
|   |   +-- categories.ts          # Category queries (22 LOC)
|   +-- middleware/
|   |   +-- auth.ts                # Session validation, public routes (58 LOC)
|   +-- sync/
|   |   +-- cloud-client.ts        # HTTP client for cloud API (120 LOC)
|   |   +-- pull-sync.ts           # Cloud -> SQLite sync (1,565 LOC)
|   |   +-- push-sync.ts           # Outbox -> Cloud sync (198 LOC)
|   |   +-- index.ts               # Barrel export (3 LOC)
|   +-- realtime/
|       +-- websocket.ts           # WS pub/sub, role-based broadcast (158 LOC)
+-- public/
|   +-- setup.html                 # Hub setup wizard page
+-- Dockerfile                     # node:20-slim, multi-stage build
+-- docker-compose.yml             # Single service + health check
+-- package.json                   # Scripts + dependencies
+-- tsconfig.json                  # TypeScript config
```

---

## Configuration

### 3-Layer Config Resolution

```
Environment variable  -->  Disk config (~/.pos-hub-v2/hub-config.json)  -->  Defaults
```

After hub registration, config is persisted to `~/.pos-hub-v2/hub-config.json` and loaded on startup.

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4001` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| `NODE_ENV` | `development` | development / production / test |
| `DB_PATH` | `~/.pos-hub-v2/hub.db` | SQLite database path |
| `CLOUD_API_URL` | (persisted) | Cloud backend URL for sync |
| `CLOUD_API_KEY` | (persisted) | API key for cloud auth |
| `HUB_REGISTRATION_TOKEN` | — | Token for self-registration |
| `LOCATION_ID` | (persisted) | Location UUID |
| `TENANT_ID` | (persisted) | Tenant UUID |
| `HUB_SECRET` | (persisted) | Hub secret (also used for WS auth) |
| `MDNS_ENABLED` | `true` | Enable mDNS service discovery |
| `MDNS_SERVICE_NAME` | `pos-hub-v2` | mDNS advertised service name |
| `SYNC_PULL_INTERVAL` | `30000` | Pull sync interval (ms) |
| `SYNC_PUSH_INTERVAL` | `5000` | Push sync interval (ms) |
| `DATA_RETENTION_DAYS` | `30` | Local data retention |
| `LOCK_TIMEOUT_MS` | `300000` | Resource lock timeout (5 min) |
| `LOCK_HEARTBEAT_MS` | `30000` | Lock heartbeat interval |
| `WS_AUTH_REQUIRED` | `false` | WebSocket auth required |
| `LOG_LEVEL` | `info` | Pino log level |
| `ALLOWED_ORIGINS` | `*` | CORS allowed origins |

### Data Paths

| Path | Purpose |
|------|---------|
| `~/.pos-hub-v2/hub.db` | SQLite database (WAL mode) |
| `~/.pos-hub-v2/hub-config.json` | Persistent config (survives restarts) |

---

## Database Schema (85 Tables)

### SQLite Pragmas
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### Table Groups

| Group | Count | Tables |
|-------|-------|--------|
| **System & Sync** | 5 | `sync_state`, `outbox_queue`, `sync_conflicts`, `order_sequence`, `resource_locks` |
| **Reference Data** (synced from cloud) | 31 | `users`, `categories`, `products`, `product_variants`, `product_order_type_prices`, `variant_order_type_prices`, `tax_types`, `customers`, `customer_addresses`, `discount_templates`, `gift_cards`, `coupon_codes`, `modifier_groups`, `modifiers`, `product_modifier_groups`, `product_kits`, `product_kit_items`, `pizza_module_config`, `pizza_location_config`, `pizza_sizes`, `pizza_crusts`, `pizza_sauces`, `pizza_cheeses`, `pizza_toppings`, `pizza_topping_categories`, `deals`, `roles`, `store_credits`, `web_order_settings`, `category_schedules`, `price_schedules` |
| **Pizza Pricing** | 5 | `pizza_size_prices`, `pizza_topping_prices`, `pizza_crust_prices`, `pizza_sauce_prices`, `pizza_cheese_prices` |
| **Deals Module** | 3 | `deal_items`, `deal_time_restrictions`, `deal_size_prices` |
| **Location Config** | 11 | `location_settings`, `terminal_settings`, `location_taxes`, `location_category_taxes`, `location_product_overrides`, `location_business_hours`, `note_presets`, `post_codes`, `floors`, `areas`, `courses` |
| **Restaurant** | 1 | `tables` |
| **Transactional** (created locally) | 8 | `kitchen_orders`, `kitchen_order_items`, `sales`, `sale_items`, `payments`, `table_sessions`, `guest_checks`, `shift_logs` |
| **Shift & Cash** | 5 | `shift_breaks`, `cash_drawers`, `cash_drawer_transactions`, `inventory_levels`, `staff_banks` |
| **Staff Banks** | 1 | `staff_bank_transactions` |
| **Terminal & Session** | 3 | `terminals`, `terminal_sessions`, `location_product_overrides` |

### Key Tables

| Table | Purpose |
|-------|---------|
| `outbox_queue` | Pending writes awaiting push to cloud (status: PENDING/PROCESSING/SYNCED/DEAD_LETTER) |
| `sync_state` | Pull sync cursor + status per entity type |
| `terminal_sessions` | Active user sessions (referenced by `x-session-id` header) |
| `sales` | POS transactions (receipt number, totals, gratuity, order type) |
| `kitchen_orders` | Kitchen order header (items JSON, metadata, timestamps) |
| `order_sequence` | Auto-increment receipt numbers per day |
| `resource_locks` | Distributed locks (cash drawer, tables) |

---

## API Endpoints (27 Files, ~150 Endpoints)

### Public Routes (no auth required)

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Server health + diagnostics |
| `/api/auth/pin` | POST | PIN authentication |
| `/api/auth/session` | GET | Session validation |
| `/api/bootstrap` | GET | Single-request POS data load |
| `/ws` | WS | WebSocket upgrade |
| `/api/setup/*` | ALL | Hub registration wizard |
| `/api/diagnostics/*` | ALL | Sync stats, terminal info |
| `/api/sync/*` | ALL | Push/pull sync (cloud-facing) |
| `/api/terminals/*` | ALL | Terminal management |

### Protected Routes (require `x-session-id` header)

| Domain | File | Key Routes |
|--------|------|------------|
| **Sales** | `sales.ts` | `POST /api/sales` (create), `GET /api/sales` (list), `POST /api/sales/:id/void`, `POST /api/sales/:id/refund` |
| **Kitchen Orders** | `kitchen-orders.ts` | `POST /api/kitchen-orders` (create), `PATCH /api/kitchen-orders/:id/status`, `PATCH /api/kitchen-orders/:id/items/:itemId/bump` |
| **Cash Drawers** | `cash-drawers.ts` | `POST /api/cash-drawers/open`, `POST /api/cash-drawers/close`, `POST /api/cash-drawers/pay-in`, `POST /api/cash-drawers/pay-out` |
| **Shifts** | `shifts.ts` | `POST /api/shifts/clock-in`, `POST /api/shifts/clock-out`, `POST /api/shifts/:id/break` |
| **Gift Cards** | `gift-cards.ts` | `GET /api/gift-cards/:code/balance`, `POST /api/gift-cards/redeem`, `POST /api/gift-cards` |
| **Customers** | `customers.ts` | `GET /api/customers/search`, `POST /api/customers`, `PATCH /api/customers/:id` |
| **Tables** | `tables.ts` | `GET /api/tables`, `POST /api/tables/:id/check-in`, `POST /api/tables/:id/check-out` |
| **Guest Checks** | `guest-checks.ts` | `POST /api/guest-checks`, `PATCH /api/guest-checks/:id/settle` |
| **Orders** | `orders.ts` | `GET /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status` |
| **Products** | `products.ts` | `GET /api/products`, `GET /api/products/search` |
| **Categories** | `categories.ts` | `GET /api/categories` |
| **Taxes** | `taxes.ts` | `GET /api/taxes` |
| **Modifiers** | `modifiers.ts` | `GET /api/modifiers` |
| **Pizza** | `pizza.ts` | `GET /api/pizza/config`, `GET /api/pizza/sizes`, `GET /api/pizza/pricing` |
| **Deals** | `deals.ts` | `GET /api/deals` |
| **Inventory** | `inventory.ts` | `GET /api/inventory`, `POST /api/inventory/adjust` |
| **Receipts** | `receipts.ts` | `POST /api/receipts/generate` |
| **Sequence** | `sequence.ts` | `POST /api/sequence/next` (receipt number) |
| **Audit Logs** | `audit-logs.ts` | `GET /api/audit-logs` |
| **Users** | `users.ts` | `GET /api/users`, `GET /api/users/:id` |

---

## Auth & Security

### Authentication Flow

```
Flutter POS --> POST /api/auth/pin { pin: "1234" }
         <-- { sessionId: "abc123", user: { id, name, role, permissions } }

Flutter POS --> GET /api/sales (header: x-session-id: abc123)
         <-- 200 { sales: [...] }
```

### Session Validation

All protected routes check the `x-session-id` header:
```sql
SELECT id, user_id FROM terminal_sessions
WHERE id = ? AND is_active = 1
```

### PIN Rate Limiting
- **Limit:** 10 attempts per 5 minutes per IP
- **Storage:** In-memory Map, cleaned every 10 minutes
- **Response:** `429 Too Many PIN Attempts`

### PIN Validation
- Fetch all active users with `pin_hash`
- Try `bcrypt.compareSync(pin, user.pin_hash)` for each user
- Return first match (bcrypt 12 rounds, ~100ms per attempt)

### Public Routes
Routes that skip session validation:
- Exact: `/health`, `/api/auth/pin`, `/api/auth/session`, `/api/bootstrap`, `/ws`
- Prefix: `/api/setup/`, `/api/diagnostics`, `/api/sync/`, `/api/hub/`, `/api/terminals/`, `/setup`

---

## Sync Engine

### Push Sync (hub -> cloud)

| Setting | Value |
|---------|-------|
| Interval | 5 seconds |
| Batch size | 20 items |
| Max retries | 5 attempts |
| Statuses | PENDING -> PROCESSING -> SYNCED / DEAD_LETTER |

**Push Entity Types & Endpoints:**
```
sale           -> /api/hub/push/sale
kitchen_order  -> /api/hub/push/kitchen-order
cash_drawer    -> /api/hub/push/cash-drawer
shift_log      -> /api/hub/push/shift
gift_card      -> /api/hub/push/gift-card
```

**Error Handling:**
- `2xx` -> Mark `SYNCED`
- `409` -> Mark `SYNCED` (idempotent duplicate, already exists in cloud)
- `4xx` (non-409) -> Mark `DEAD_LETTER` (bad data, won't succeed on retry)
- `5xx` / network error -> Back to `PENDING` for retry (unless max attempts reached)

### Pull Sync (cloud -> hub)

| Setting | Value |
|---------|-------|
| Interval | 30 seconds |
| Batch size | 50 items per request |
| Cursor | Tracked in `sync_state` per entity |

**Pull Entity Types (14+):**
`tax_types`, `location_taxes`, `location_category_taxes`, `products`, `product_variants`, `product_order_type_prices`, `variant_order_type_prices`, `categories`, `customers`, `deals`, `deal_items`, `deal_time_restrictions`, `deal_size_prices`, `locations`, plus pizza, modifiers, kits, coupons, gift_cards, discount_templates

**Pull Pattern:**
1. Read `sync_state` cursor for entity
2. `GET /api/sync/{entity}?cursor=X&limit=50`
3. Transform: camelCase -> snake_case, booleans -> 0/1
4. Upsert into SQLite (INSERT ... ON CONFLICT REPLACE)
5. Update `sync_state` (cursor, timestamp, count)
6. If `hasMore=true`, continue to next batch

### Cloud Client Headers
```
X-API-Key: <config.cloudApiKey>
X-Tenant-ID: <config.tenantId>
X-Location-ID: <config.locationId>
Content-Type: application/json
```

---

## WebSocket

### Connection
- Route: `/ws` (public, auth optional via `WS_AUTH_REQUIRED`)
- Client ID assigned on connect: `ws_{timestamp}_{random}`
- Role resolved server-side from terminal record (POS / KDS / ADMIN)

### Events

| Event | Target | Purpose |
|-------|--------|---------|
| `ping` / `pong` | sender | Keepalive |
| `order:created` | KDS only | New kitchen order |
| `order:status` | all | KO status change |
| `order:voided` | all | Order voided |
| `item:bumped` | all | Item bump bar signal |
| `table:updated` | all | Table status change |
| `drawer:opened` | ADMIN only | Cash drawer opened |

### Broadcast
- Role-based filtering (KDS terminals only see kitchen events)
- Selective broadcast by client ID or role
- Graceful disconnect + client cleanup

---

## Key Patterns

### Transaction Wrapping
All multi-step writes use SQLite transactions:
```typescript
db.transaction(() => {
  db.prepare('INSERT INTO sales ...').run(saleData);
  db.prepare('INSERT INTO sale_items ...').run(itemData);
  db.prepare('INSERT INTO payments ...').run(paymentData);
  db.prepare('INSERT INTO outbox_queue ...').run(outboxEntry);
})();
```

### Outbox Pattern
Every local write that needs cloud sync gets an outbox entry:
```typescript
db.prepare(`
  INSERT INTO outbox_queue (id, entity_type, entity_id, action, payload, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
`).run(nanoid(), 'sale', saleId, 'create', JSON.stringify(payload), now);
```

### Bootstrap Endpoint
Single GET request returns ALL POS data (~100ms):
- Products, variants, order-type prices
- Categories, taxes, location taxes
- Deals, deal items, deal pricing
- Pizza config + pricing matrices
- Modifiers, kits, coupons, gift cards
- Location settings, business hours
- Floors, areas, tables, courses
- Discount templates, note presets, post codes

### camelCase -> snake_case Mapping
Pull sync transforms cloud data (camelCase) to SQLite columns (snake_case):
```typescript
// Cloud: { tenantId, taxTypeIds, applyToAll }
// SQLite: tenant_id, tax_type_ids, apply_to_all
```

### Hub Registration Flow
1. Admin generates registration token in Location Portal
2. Hub sends token to cloud: `POST /api/hub/sync/terminal-register`
3. Cloud returns: `locationId`, `tenantId`, `cloudApiKey`, `hubSecret`
4. Hub saves config to `~/.pos-hub-v2/hub-config.json`
5. Hub starts sync engines

### Heartbeat
Hub sends heartbeat to cloud every 60 seconds:
```
POST /api/hub/heartbeat
{ locationId, tenantId, timestamp, terminalCount, pendingSyncCount }
```

---

## Development Commands

```bash
# Development
npm run dev           # Start with tsx watch (hot reload)
npm run build         # Compile TypeScript -> dist/
npm run start         # Run compiled output (production)
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint

# Docker
docker-compose build                  # Build image
docker-compose up -d                  # Start hub container
docker-compose logs -f hub-v2         # Tail logs
docker-compose down                   # Stop

# Health check
curl http://localhost:4001/health
```

### Docker

**Image:** `node:20-slim` (multi-stage build)

**Port:** 4001

**Volume:** `hub-v2-data` mounted at `/app/data` (SQLite DB)

**Health Check:** `GET /health` every 30s (timeout 10s, 3 retries)

**Restart Policy:** `unless-stopped`

**Env overrides in docker-compose.yml:**
```yaml
NODE_ENV=production
PORT=4001
DB_PATH=/app/data/hub.db
LOG_LEVEL=info
ALLOWED_ORIGINS=*
```

---

## Startup Sequence

1. Load config (env -> disk -> defaults)
2. Initialize SQLite database (create tables, WAL mode)
3. Register Fastify plugins (CORS, WebSocket)
4. Register all 27 route groups + auth middleware
5. Start listening on `config.port` (default 4001)
6. Register hub as terminal in cloud (non-blocking)
7. Start push sync engine (5s interval)
8. Start pull sync engine (30s interval)
9. Start mDNS advertisement (if enabled)
10. Start heartbeat loop (60s interval)

### Graceful Shutdown
- Stop sync engines
- Checkpoint WAL (flush to main DB file)
- Close database
- Close Fastify app

---

## Quality Checklist (All Changes)

- [ ] Multi-step writes wrapped in `db.transaction()`
- [ ] Outbox entry created for every cloud-syncable write
- [ ] `sync_state` updated after pull sync operations
- [ ] Zod validation on all request inputs
- [ ] Error responses use proper HTTP status codes
- [ ] WebSocket events broadcast after state changes
- [ ] camelCase -> snake_case transforms in pull sync
- [ ] No `SELECT *` — select only needed columns
- [ ] Resource locks acquired before exclusive operations
- [ ] Dead letters handled (not silently dropped)
- [ ] TypeScript strict (no `any`, no `@ts-ignore`)
- [ ] No over-engineering — only requested changes

---

## File Quick Reference

| Need to change... | Look at... |
|-------------------|------------|
| API endpoint | `src/api/{domain}.ts` |
| Database table | `src/db/schema.ts` |
| Database init/pragmas | `src/db/index.ts` |
| Auth / session validation | `src/middleware/auth.ts` |
| Pull sync (cloud -> hub) | `src/sync/pull-sync.ts` |
| Push sync (hub -> cloud) | `src/sync/push-sync.ts` |
| Cloud API client | `src/sync/cloud-client.ts` |
| WebSocket events | `src/realtime/websocket.ts` |
| Config / env vars | `src/config.ts` |
| Server setup / routes | `src/server.ts` |
| Startup / heartbeat | `src/index.ts` |
| Docker | `Dockerfile`, `docker-compose.yml` |
