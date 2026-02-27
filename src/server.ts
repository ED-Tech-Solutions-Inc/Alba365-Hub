import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { initDatabase, closeDatabase } from "./db/index.js";
import { config } from "./config.js";

// API route imports
import { registerHealthRoutes } from "./api/health.js";
import { registerAuthRoutes } from "./api/auth.js";
import { registerBootstrapRoutes } from "./api/bootstrap.js";
import { registerProductRoutes } from "./api/products.js";
import { registerCategoryRoutes } from "./api/categories.js";
import { registerTaxRoutes } from "./api/taxes.js";
import { registerCustomerRoutes } from "./api/customers.js";
import { registerSaleRoutes } from "./api/sales.js";
import { registerKitchenOrderRoutes } from "./api/kitchen-orders.js";
import { registerCashDrawerRoutes } from "./api/cash-drawers.js";
import { registerShiftRoutes } from "./api/shifts.js";
import { registerTerminalRoutes } from "./api/terminals.js";
import { registerDealRoutes } from "./api/deals.js";
import { registerPizzaRoutes } from "./api/pizza.js";
import { registerModifierRoutes } from "./api/modifiers.js";
import { registerGiftCardRoutes } from "./api/gift-cards.js";
import { registerTableRoutes } from "./api/tables.js";
import { registerReceiptRoutes } from "./api/receipts.js";
import { registerInventoryRoutes } from "./api/inventory.js";
import { registerOrderRoutes } from "./api/orders.js";
import { registerSyncRoutes, startSyncEngines, stopSyncEngines } from "./api/sync.js";
import { registerSetupRoutes } from "./api/setup.js";
import { registerDiagnosticsRoutes } from "./api/diagnostics.js";
import { registerAuditLogRoutes } from "./api/audit-logs.js";
import { registerSequenceRoutes } from "./api/sequence.js";
import { registerGuestCheckRoutes } from "./api/guest-checks.js";
import { registerUserRoutes } from "./api/users.js";
import { registerCallerIdRoutes } from "./api/caller-id.js";
import { registerStoreCreditRoutes } from "./api/store-credits.js";
import { registerRefundRoutes } from "./api/refunds.js";
import { registerWaitingQueueRoutes } from "./api/waiting-queue.js";
import { registerReservationRoutes } from "./api/reservations.js";
import { registerWebSocketHandler } from "./realtime/websocket.js";
import { registerAuthMiddleware } from "./middleware/auth.js";
import { startCallerIdListener, stopCallerIdListener } from "./caller-id/udp-listener.js";

export async function createServer() {
  // Initialize database first
  initDatabase();

  // Create Fastify instance
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // CORS — use type assertion to work around Fastify plugin generics mismatch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(cors as any, {
    origin: config.allowedOrigins === "*" ? true : config.allowedOrigins.split(","),
    credentials: true,
  });

  // WebSocket support
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(websocket as any);

  // --- Auth middleware (validates x-session-id on protected routes) ---
  registerAuthMiddleware(app);

  // --- Register all API routes ---
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerBootstrapRoutes(app);
  registerProductRoutes(app);
  registerCategoryRoutes(app);
  registerTaxRoutes(app);
  registerCustomerRoutes(app);
  registerSaleRoutes(app);
  registerKitchenOrderRoutes(app);
  registerCashDrawerRoutes(app);
  registerShiftRoutes(app);
  registerTerminalRoutes(app);
  registerDealRoutes(app);
  registerPizzaRoutes(app);
  registerModifierRoutes(app);
  registerGiftCardRoutes(app);
  registerTableRoutes(app);
  registerReceiptRoutes(app);
  registerInventoryRoutes(app);
  registerOrderRoutes(app);
  registerDiagnosticsRoutes(app);
  registerAuditLogRoutes(app);
  registerSequenceRoutes(app);
  registerGuestCheckRoutes(app);
  registerUserRoutes(app);
  registerCallerIdRoutes(app);
  registerStoreCreditRoutes(app);
  registerRefundRoutes(app);
  registerWaitingQueueRoutes(app);
  registerReservationRoutes(app);
  registerSyncRoutes(app);
  registerSetupRoutes(app);

  // WebSocket handler
  registerWebSocketHandler(app);

  // Start sync engines
  startSyncEngines();

  // Start caller ID UDP listener (if configured)
  startCallerIdListener();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Server] Shutting down gracefully...");
    stopCallerIdListener();
    stopSyncEngines();
    closeDatabase();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return app;
}
