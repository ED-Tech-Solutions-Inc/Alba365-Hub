import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getDb, generateId, transaction } from "../db/index.js";
import { config } from "../config.js";

/** Parse JSON safely — returns fallback on corrupt data instead of crashing. */
function safeParseJson(value: unknown, fallback: unknown = []): unknown {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** In-memory rate limiter for PIN auth — 10 attempts per 5 min per IP. */
const PIN_RATE_LIMIT = 10;
const PIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

function checkPinRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = pinAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    pinAttempts.set(ip, { count: 1, resetAt: now + PIN_RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= PIN_RATE_LIMIT;
}

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pinAttempts) {
    if (now >= entry.resetAt) pinAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

/** Recent user IDs — try these first for fast PIN auth (~84ms vs 1.3s full scan).
 *  In a restaurant, the same staff log in/out repeatedly all day. */
const recentUserIds: string[] = [];
const MAX_RECENT_USERS = 5;

function recordRecentUser(userId: string) {
  const idx = recentUserIds.indexOf(userId);
  if (idx !== -1) recentUserIds.splice(idx, 1);
  recentUserIds.unshift(userId);
  if (recentUserIds.length > MAX_RECENT_USERS) recentUserIds.pop();
}

export function registerAuthRoutes(app: FastifyInstance) {
  // PIN authentication
  app.post("/api/auth/pin", async (req, reply) => {
    const body = req.body as { pin?: string; terminalId?: string };
    const pin = body.pin;

    if (!pin || pin.length < 4 || pin.length > 10) {
      reply.status(400);
      return { error: "PIN must be 4-10 characters" };
    }

    // Rate limit: 10 attempts per 5 min per IP
    const clientIp = req.ip ?? "unknown";
    if (!checkPinRateLimit(clientIp)) {
      reply.status(429);
      return { error: "Too many PIN attempts. Try again later." };
    }

    const db = getDb();
    const users = db.prepare(`
      SELECT id, name, email, pin_hash, role, permissions, max_discount, is_active
      FROM users
      WHERE tenant_id = ? AND is_active = 1 AND pin_hash IS NOT NULL
    `).all(config.tenantId ?? "") as Array<{
      id: string;
      name: string;
      email: string | null;
      pin_hash: string;
      role: string;
      permissions: string;
      max_discount: number;
      is_active: number;
    }>;

    // Fast path: try recent users first (~84ms per check vs 1.3s full scan).
    // In a restaurant, the same staff log in/out all day — this hits on first try.
    const authStart = Date.now();
    let user: typeof users[number] | null = null;

    // 1. Try recent users first (ordered by most recent login)
    for (const recentId of recentUserIds) {
      const candidate = users.find((u) => u.id === recentId);
      if (!candidate) continue;
      try {
        if (await bcrypt.compare(pin, candidate.pin_hash)) {
          user = candidate;
          break;
        }
      } catch { /* corrupt hash, skip */ }
    }

    // 2. Fall back to full scan only if recent users didn't match
    if (!user) {
      const remaining = users.filter((u) => !recentUserIds.includes(u.id));
      for (const candidate of remaining) {
        try {
          if (await bcrypt.compare(pin, candidate.pin_hash)) {
            user = candidate;
            break;
          }
        } catch { /* corrupt hash, skip */ }
      }
    }

    console.log(`[Auth] PIN auth: ${users.length} users, took ${Date.now() - authStart}ms, match=${!!user}`);

    if (!user) {
      reply.status(401);
      return { error: "Invalid PIN" };
    }

    // Cache this user for fast re-auth
    recordRecentUser(user.id);

    // Create terminal session
    const sessionId = generateId();
    const terminalId = body.terminalId ?? (req.headers["x-terminal-id"] as string) ?? null;

    if (terminalId) {
      const terminalExists = db.prepare("SELECT id FROM terminals WHERE id = ?").get(terminalId);
      if (terminalExists) {
        transaction((txDb) => {
          txDb.prepare(`
            INSERT INTO terminal_sessions (id, terminal_id, user_id, user_name, started_at, is_active)
            VALUES (?, ?, ?, ?, datetime('now'), 1)
          `).run(sessionId, terminalId, user.id, user.name);

          txDb.prepare(`
            UPDATE terminals SET current_user_id = ?, current_user_name = ?, status = 'ONLINE', last_seen_at = datetime('now')
            WHERE id = ?
          `).run(user.id, user.name, terminalId);
        });
      }
    }

    return {
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: safeParseJson(user.permissions, []),
        maxDiscount: user.max_discount,
      },
      sessionId,
    };
  });

  // Verify session
  app.get("/api/auth/session", async (req, reply) => {
    const sessionId = req.headers["x-session-id"] as string;
    if (!sessionId) {
      reply.status(401);
      return { error: "No session" };
    }

    const db = getDb();
    const session = db.prepare(`
      SELECT ts.*, u.name, u.role, u.permissions, u.max_discount
      FROM terminal_sessions ts
      JOIN users u ON u.id = ts.user_id
      WHERE ts.id = ? AND ts.is_active = 1
    `).get(sessionId) as Record<string, unknown> | undefined;

    if (!session) {
      reply.status(401);
      return { error: "Invalid or expired session" };
    }

    return {
      sessionId: session.id,
      user: {
        id: session.user_id,
        name: session.name,
        role: session.role,
        permissions: safeParseJson(session.permissions as string, []),
        maxDiscount: session.max_discount,
      },
    };
  });

  // Logout
  app.post("/api/auth/logout", async (req) => {
    const sessionId = req.headers["x-session-id"] as string;
    if (sessionId) {
      const db = getDb();
      db.prepare("UPDATE terminal_sessions SET is_active = 0, ended_at = datetime('now') WHERE id = ?")
        .run(sessionId);
    }
    return { success: true };
  });
}
