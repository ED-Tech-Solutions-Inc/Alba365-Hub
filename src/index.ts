import "dotenv/config";
import { hostname, networkInterfaces } from "os";
import { createServer } from "./server.js";
import { config } from "./config.js";
import { getCloudClient } from "./sync/cloud-client.js";
import { getDb } from "./db/index.js";

const HUB_VERSION = "0.1.0";

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/** Register the hub itself as a terminal in the cloud so it appears in Location Portal */
async function registerHubAsTerminal(): Promise<void> {
  const cloudClient = getCloudClient();
  if (!cloudClient.isConfigured() || !config.locationId || !config.tenantId) {
    return;
  }

  const hubTerminalId = `hub-v2-${config.locationId}`;

  try {
    // 1) Register hub as Terminal record (for terminal grid/list view)
    const termRes = await cloudClient.post("/api/hub/sync/terminal-register", {
      terminalId: hubTerminalId,
      name: `Hub Server (${hostname()})`,
      deviceType: "ELECTRON",
      appType: "POS_TERMINAL",
      ipAddress: getLocalIp(),
      appVersion: HUB_VERSION,
      isHubServer: true,
      hubServerPrimary: true,
      hubServerPort: config.port,
      hubServerIpAddress: getLocalIp(),
    });
    if (termRes.ok) {
      console.log(`[Hub v2] Registered as terminal in cloud (id: ${hubTerminalId})`);
    } else {
      console.warn(`[Hub v2] Terminal registration failed: HTTP ${termRes.status} — ${termRes.error ?? JSON.stringify(termRes.data)}`);
    }

    // 2) Update Location-level hub info (for Hub Server Status Card)
    const regRes = await cloudClient.post("/api/hub/register", {
      hostname: hostname(),
      ipAddress: getLocalIp(),
      version: HUB_VERSION,
    });
    if (regRes.ok) {
      console.log(`[Hub v2] Location hub info updated (hostname: ${hostname()}, ip: ${getLocalIp()})`);
    } else {
      console.warn(`[Hub v2] Location hub info update failed: HTTP ${regRes.status} — ${regRes.error ?? JSON.stringify(regRes.data)}`);
    }
  } catch (err) {
    console.warn(`[Hub v2] Cloud registration failed (hub still works): ${err instanceof Error ? err.message : err}`);
  }
}

/** Send periodic heartbeat to cloud with terminal count, sync status.
 *  Returns the interval ID so it can be cleared on shutdown. */
function startHeartbeat(): NodeJS.Timeout | null {
  const cloudClient = getCloudClient();
  if (!cloudClient.isConfigured() || !config.locationId || !config.tenantId) {
    return null;
  }

  const HEARTBEAT_INTERVAL = 60_000; // Every 60 seconds

  const sendHeartbeat = async () => {
    try {
      const db = getDb();

      // Count active terminals
      const terminalRow = db.prepare(
        "SELECT COUNT(*) as count FROM terminals WHERE location_id = ? AND status = 'ONLINE'",
      ).get(config.locationId ?? "") as { count: number } | undefined;
      const terminalCount = terminalRow?.count ?? 0;

      // Count pending outbox items
      const outboxRow = db.prepare(
        "SELECT COUNT(*) as count FROM outbox WHERE status = 'pending'",
      ).get() as { count: number } | undefined;
      const pendingSyncCount = outboxRow?.count ?? 0;

      await cloudClient.post("/api/hub/heartbeat", {
        locationId: config.locationId,
        tenantId: config.tenantId,
        timestamp: new Date().toISOString(),
        terminalCount,
        pendingSyncCount,
      });
    } catch {
      // Heartbeat failures are non-critical, don't log every time
    }
  };

  // Send first heartbeat immediately
  sendHeartbeat();

  // Then every 60 seconds
  const intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  console.log(`[Hub v2] Heartbeat started (every ${HEARTBEAT_INTERVAL / 1000}s)`);
  return intervalId;
}

async function main() {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║       POS Hub Server v2               ║
  ║       For Flutter Native POS          ║
  ╚═══════════════════════════════════════╝
  `);

  const app = await createServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`[Hub v2] Listening on http://${config.host}:${config.port}`);
    console.log(`[Hub v2] Environment: ${config.nodeEnv}`);
    console.log(`[Hub v2] Database: ${config.dbPath}`);

    if (config.locationId) {
      console.log(`[Hub v2] Location: ${config.locationId}`);
    }
    if (config.tenantId) {
      console.log(`[Hub v2] Tenant: ${config.tenantId}`);
    }

    // Register hub in cloud and start heartbeat (non-blocking)
    registerHubAsTerminal();
    const heartbeatInterval = startHeartbeat();

    // Clear heartbeat on shutdown (server.ts handles sync engines + DB + app.close)
    const clearHeartbeat = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    };
    process.on("SIGINT", clearHeartbeat);
    process.on("SIGTERM", clearHeartbeat);
  } catch (err) {
    console.error("[Hub v2] Failed to start:", err);
    process.exit(1);
  }
}

main();
