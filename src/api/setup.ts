import type { FastifyInstance } from "fastify";
import { hostname, networkInterfaces } from "os";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config, saveConfig, loadConfig } from "../config.js";
import { getCloudClient } from "../sync/cloud-client.js";

/**
 * Hub setup & cloud pairing endpoints.
 *
 * Flow A (Short-code):
 * 1. App calls POST /api/setup/pair/init → gets { challengeId, code }
 * 2. Admin enters code in Location Portal → confirms pairing
 * 3. App polls GET /api/setup/pair/status?challengeId=xxx
 * 4. When paired → hub saves cloud credentials, sync starts
 *
 * Flow B (Token):
 * 1. Admin generates token in Location Portal
 * 2. App calls POST /api/setup/register { token, cloudApiUrl }
 * 3. Hub registers with cloud, saves credentials
 */

interface PairInitResponse {
  challengeId: string;
  code: string;
  expiresAt: string;
}

interface PairStatusResponse {
  status: "pending" | "paired" | "expired";
  apiKey?: string;
  tenantId?: string;
  locationId?: string;
  cloudApiUrl?: string;
}

function getHubFingerprint(): string {
  return `hub-v2-${hostname()}-${config.port}`;
}

function getHubIp(): string {
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

/** Register the hub itself as a terminal in the cloud (for Location Portal visibility) */
async function registerHubTerminalInCloud(): Promise<void> {
  const cloudClient = getCloudClient();
  if (!cloudClient.isConfigured() || !config.locationId) return;

  const hubTerminalId = `hub-v2-${config.locationId}`;
  try {
    await cloudClient.post("/api/hub/sync/terminal-register", {
      terminalId: hubTerminalId,
      name: `Hub Server (${hostname()})`,
      deviceType: "ELECTRON",
      appType: "POS_TERMINAL",
      ipAddress: getHubIp(),
      appVersion: "0.1.0",
      isHubServer: true,
      hubServerPrimary: true,
      hubServerPort: config.port,
      hubServerIpAddress: getHubIp(),
    });
    console.log(`[Setup] Hub registered as terminal in cloud (id: ${hubTerminalId})`);
  } catch (err) {
    console.warn(`[Setup] Hub terminal registration failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerSetupRoutes(app: FastifyInstance) {
  // --- Check if hub is registered with cloud ---
  app.get("/api/setup/status", async () => {
    return {
      isRegistered: !!config.cloudApiKey && !!config.locationId && !!config.tenantId,
      locationId: config.locationId ?? null,
      tenantId: config.tenantId ?? null,
      cloudApiUrl: config.cloudApiUrl ?? null,
      hasApiKey: !!config.cloudApiKey,
    };
  });

  // --- Short-code pairing: Step 1 — Request code from cloud ---
  app.post("/api/setup/pair/init", async (req, reply) => {
    const body = (req.body ?? {}) as { cloudApiUrl?: string };
    const cloudUrl = (body.cloudApiUrl ?? config.cloudApiUrl ?? "").replace(/\/$/, "");

    if (!cloudUrl) {
      reply.status(400);
      return { error: "Cloud API URL required. Set CLOUD_API_URL or pass cloudApiUrl in body." };
    }

    // Save cloud URL if provided
    if (body.cloudApiUrl) {
      saveConfig({ cloudApiUrl: body.cloudApiUrl });
      Object.assign(config, loadConfig());
    }

    try {
      const res = await fetch(`${cloudUrl}/api/hub/pair/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hubFingerprint: getHubFingerprint() }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as Record<string, unknown>;
        reply.status(res.status);
        return { error: errData.error ?? `Cloud returned ${res.status}` };
      }

      const data = await res.json() as PairInitResponse;
      return {
        challengeId: data.challengeId,
        code: data.code,
        expiresAt: data.expiresAt,
      };
    } catch (err) {
      reply.status(502);
      return { error: `Cannot reach cloud at ${cloudUrl}: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  });

  // --- Short-code pairing: Step 2 — Poll for result ---
  app.get("/api/setup/pair/status", async (req, reply) => {
    const { challengeId } = req.query as { challengeId?: string };
    if (!challengeId) {
      reply.status(400);
      return { error: "challengeId required" };
    }

    const cloudUrl = (config.cloudApiUrl ?? "").replace(/\/$/, "");
    if (!cloudUrl) {
      reply.status(400);
      return { error: "Cloud API URL not configured" };
    }

    try {
      const res = await fetch(
        `${cloudUrl}/api/hub/pair/status?challengeId=${encodeURIComponent(challengeId)}`,
      );

      if (!res.ok) {
        reply.status(res.status);
        const errData = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { error: errData.error ?? `Cloud returned ${res.status}` };
      }

      const data = await res.json() as PairStatusResponse;

      if (data.status === "paired" && data.apiKey) {
        saveConfig({
          cloudApiKey: data.apiKey,
          tenantId: data.tenantId ?? "",
          locationId: data.locationId ?? "",
          cloudApiUrl: data.cloudApiUrl ?? cloudUrl,
          hubSecret: data.apiKey,
        });
        Object.assign(config, loadConfig());

        console.log(`[Setup] Hub paired! locationId=${data.locationId}, tenantId=${data.tenantId}`);

        // Register hub as terminal in cloud (non-blocking)
        registerHubTerminalInCloud().catch(() => {});

        return {
          status: "paired",
          locationId: data.locationId,
          tenantId: data.tenantId,
        };
      }

      return { status: data.status };
    } catch (err) {
      reply.status(502);
      return { error: `Cannot reach cloud: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  });

  // --- Token-based registration ---
  app.post("/api/setup/register", async (req, reply) => {
    const body = req.body as { token?: string; cloudApiUrl?: string };
    const token = body.token;
    const cloudUrl = (body.cloudApiUrl ?? config.cloudApiUrl ?? "").replace(/\/$/, "");

    if (!token) {
      reply.status(400);
      return { error: "Registration token required" };
    }
    if (!cloudUrl) {
      reply.status(400);
      return { error: "Cloud API URL required" };
    }

    try {
      const res = await fetch(`${cloudUrl}/api/hub/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registrationToken: token,
          hostname: hostname(),
          ipAddress: getHubIp(),
          version: "0.1.0",
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as Record<string, unknown>;
        reply.status(res.status);
        return { error: errData.error ?? `Registration failed: HTTP ${res.status}` };
      }

      const data = await res.json() as {
        registered: boolean;
        apiKey?: string;
        tenantId?: string;
        locationId?: string;
        locationName?: string;
      };

      if (data.registered && data.apiKey) {
        saveConfig({
          cloudApiUrl: cloudUrl,
          cloudApiKey: data.apiKey,
          tenantId: data.tenantId ?? "",
          locationId: data.locationId ?? "",
          hubSecret: data.apiKey,
        });
        Object.assign(config, loadConfig());

        console.log(`[Setup] Hub registered! location="${data.locationName}", locationId=${data.locationId}`);

        // Register hub as terminal in cloud (non-blocking)
        registerHubTerminalInCloud().catch(() => {});

        return {
          registered: true,
          locationId: data.locationId,
          locationName: data.locationName,
          tenantId: data.tenantId,
        };
      }

      reply.status(400);
      return { error: "Registration failed — no credentials returned" };
    } catch (err) {
      reply.status(502);
      return { error: `Cannot reach cloud at ${cloudUrl}: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  });

  // --- Update cloud URL ---
  app.post("/api/setup/cloud-url", async (req) => {
    const body = req.body as { cloudApiUrl: string };
    if (body.cloudApiUrl) {
      saveConfig({ cloudApiUrl: body.cloudApiUrl });
      Object.assign(config, loadConfig());
    }
    return { cloudApiUrl: config.cloudApiUrl };
  });

  // --- Trigger manual pull sync ---
  app.post("/api/setup/initial-sync", async () => {
    const cloudClient = getCloudClient();
    if (!cloudClient.isConfigured()) {
      return { error: "Hub not registered with cloud yet", syncing: false };
    }
    return {
      message: "Sync engines are running. Pull sync will fetch data on next cycle.",
      syncing: true,
      locationId: config.locationId,
    };
  });

  // --- Serve setup HTML page ---
  app.get("/setup", async (_req, reply) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const htmlPath = join(__dirname, "..", "..", "public", "setup.html");
    try {
      const html = readFileSync(htmlPath, "utf-8");
      reply.type("text/html").send(html);
    } catch {
      reply.status(404).send("Setup page not found");
    }
  });
}
