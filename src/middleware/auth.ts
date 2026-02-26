import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db/index.js";

// Routes that don't require a valid session (exact match)
const PUBLIC_ROUTES = new Set([
  "/health",
  "/api/auth/pin",
  "/api/auth/session",
  "/api/bootstrap",
  "/ws",
]);

// Route prefixes that don't require a valid session.
// These cover setup, diagnostics, sync, and admin monitoring endpoints
// which are accessed by the Location Portal proxy (no terminal session).
const PUBLIC_PREFIXES = [
  "/api/setup/",
  "/api/diagnostics",
  "/api/sync/",
  "/api/hub/",          // Hub v1-compatible aliases used by web proxy
  "/api/terminals/",    // Terminal management from Location Portal
  "/setup",             // Setup HTML page
];

function isPublicRoute(url: string): boolean {
  // Strip query string
  const path = url.split("?")[0];
  if (PUBLIC_ROUTES.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Fastify onRequest hook — validates x-session-id header on protected routes.
 *
 * The session ID is created by POST /api/auth/pin and stored in terminal_sessions.
 * Flutter clients send it on every request via Dio interceptor.
 */
export function registerAuthMiddleware(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublicRoute(req.url)) return;

    const sessionId = req.headers["x-session-id"] as string | undefined;
    if (!sessionId) {
      reply.status(401).send({ error: "Authentication required" });
      return;
    }

    const db = getDb();
    const session = db
      .prepare("SELECT id, user_id FROM terminal_sessions WHERE id = ? AND is_active = 1")
      .get(sessionId) as { id: string; user_id: string } | undefined;

    if (!session) {
      reply.status(401).send({ error: "Invalid or expired session" });
      return;
    }
  });
}
