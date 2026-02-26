import type { FastifyInstance } from "fastify";
import { getDb, generateId } from "../db/index.js";
import { config } from "../config.js";
import { getCloudClient } from "../sync/cloud-client.js";

export function registerTerminalRoutes(app: FastifyInstance) {
  // List terminals for this location
  app.get("/api/terminals", async () => {
    const db = getDb();
    return db.prepare("SELECT * FROM terminals WHERE location_id = ?")
      .all(config.locationId ?? "");
  });

  // Get terminal by ID
  app.get("/api/terminals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const terminal = db.prepare("SELECT * FROM terminals WHERE id = ?").get(id);
    if (!terminal) {
      reply.status(404);
      return { error: "Terminal not found" };
    }

    // Get active session
    const session = db.prepare(
      "SELECT * FROM terminal_sessions WHERE terminal_id = ? AND is_active = 1 ORDER BY started_at DESC LIMIT 1",
    ).get(id);

    return { ...(terminal as Record<string, unknown>), activeSession: session ?? null };
  });

  // Register terminal (self-registration from Flutter/Electron app)
  // Also registers with cloud if hub is registered
  app.post("/api/terminals/register", async (req, reply) => {
    const body = req.body as {
      name?: string;
      deviceType?: string;
      ipAddress?: string;
      appVersion?: string;
    };
    const db = getDb();
    const id = generateId();
    const terminalName = body.name ?? `Terminal ${id.substring(0, 6)}`;
    const deviceType = body.deviceType ?? "FLUTTER";

    // Must have location identity
    if (!config.locationId || !config.tenantId) {
      reply.status(400);
      return { error: "Hub not registered with cloud yet. Complete hub setup first." };
    }

    // Insert into local terminals table
    db.prepare(`
      INSERT INTO terminals (id, tenant_id, location_id, name, device_type, ip_address, app_version, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ONLINE', datetime('now'))
    `).run(
      id,
      config.tenantId,
      config.locationId,
      terminalName,
      deviceType,
      body.ipAddress ?? null,
      body.appVersion ?? null,
    );

    // Also register with cloud (non-blocking — terminal works even if cloud is down)
    const cloudClient = getCloudClient();
    if (cloudClient.isConfigured()) {
      try {
        await cloudClient.post("/api/hub/sync/terminal-register", {
          terminalId: id,
          name: terminalName,
          deviceType,
          locationId: config.locationId,
          tenantId: config.tenantId,
          ipAddress: body.ipAddress,
          appVersion: body.appVersion,
        });
        console.log(`[Terminals] Registered terminal ${id} with cloud`);
      } catch (err) {
        console.warn(`[Terminals] Cloud registration failed (terminal still works locally): ${err instanceof Error ? err.message : err}`);
      }
    }

    return {
      id,
      name: terminalName,
      locationId: config.locationId,
      tenantId: config.tenantId,
      deviceType,
    };
  });

  // Deregister terminal
  app.post("/api/terminals/:id/deregister", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();

    const terminal = db.prepare("SELECT * FROM terminals WHERE id = ?").get(id);
    if (!terminal) {
      reply.status(404);
      return { error: "Terminal not found" };
    }

    // End active sessions
    db.prepare("UPDATE terminal_sessions SET is_active = 0, ended_at = datetime('now') WHERE terminal_id = ? AND is_active = 1").run(id);

    // Remove terminal locally
    db.prepare("DELETE FROM terminals WHERE id = ?").run(id);

    // Notify cloud (non-blocking)
    const cloudClient = getCloudClient();
    if (cloudClient.isConfigured()) {
      try {
        await cloudClient.post("/api/hub/sync/terminal-deregister", {
          terminalId: id,
          locationId: config.locationId,
          tenantId: config.tenantId,
        });
        console.log(`[Terminals] Deregistered terminal ${id} from cloud`);
      } catch (err) {
        console.warn(`[Terminals] Cloud deregistration failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    return { success: true, message: `Terminal ${id} deregistered` };
  });

  // Get active terminal sessions
  app.get("/api/terminal-sessions/active", async () => {
    const db = getDb();
    return db.prepare(`
      SELECT ts.*, t.name as terminal_name FROM terminal_sessions ts
      JOIN terminals t ON t.id = ts.terminal_id
      WHERE ts.is_active = 1
    `).all();
  });

  // Connected terminals (for diagnostics)
  app.get("/api/terminals/connected", async () => {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT ts.terminal_id, t.name, ts.user_id, ts.user_name, ts.started_at
      FROM terminal_sessions ts
      JOIN terminals t ON t.id = ts.terminal_id
      WHERE ts.is_active = 1
    `).all();
    return { count: sessions.length, terminals: sessions };
  });

  // Get terminal settings
  app.get("/api/terminal-settings/:terminalId", async (req) => {
    const { terminalId } = req.params as { terminalId: string };
    const db = getDb();
    return db.prepare("SELECT * FROM terminal_settings WHERE terminal_id = ?").get(terminalId) ?? {};
  });

  // Update terminal heartbeat (called periodically by Flutter app)
  app.post("/api/terminals/:id/heartbeat", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { ipAddress?: string; appVersion?: string };
    const db = getDb();

    db.prepare(`
      UPDATE terminals SET last_seen_at = datetime('now'), status = 'ONLINE',
      ip_address = COALESCE(?, ip_address), app_version = COALESCE(?, app_version)
      WHERE id = ?
    `).run(body.ipAddress ?? null, body.appVersion ?? null, id);

    return { ok: true };
  });
}
