import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// --- Environment config ---
export interface HubConfig {
  port: number;
  host: string;
  nodeEnv: "development" | "production" | "test";
  dbPath: string;
  dbEncryptionKey?: string;

  // Cloud sync
  cloudApiUrl?: string;
  cloudApiKey?: string;
  hubRegistrationToken?: string;

  // Identity
  locationId?: string;
  tenantId?: string;
  hubSecret?: string;

  // mDNS discovery
  mdnsEnabled: boolean;
  mdnsServiceName: string;

  // Sync intervals
  syncPullInterval: number;
  syncPushInterval: number;
  dataRetentionDays: number;

  // Locking
  lockTimeoutMs: number;
  lockHeartbeatMs: number;

  // WebSocket
  wsAuthRequired: boolean;
  hubWsToken?: string;

  // Hub role
  isPrimary: boolean;
  hubEpoch: number;
  replicationEnabled: boolean;
  replicationPullInterval: number;
  primaryHubUrl?: string;

  // Logging
  logLevel: string;
  allowedOrigins: string;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

const DATA_DIR = join(homedir(), ".pos-hub-v2");

export function loadConfig(): HubConfig {
  // Load saved config from disk (from previous registration)
  const savedConfigPath = join(DATA_DIR, "hub-config.json");
  let saved: Record<string, string> = {};
  if (existsSync(savedConfigPath)) {
    try {
      saved = JSON.parse(readFileSync(savedConfigPath, "utf-8"));
    } catch (err) {
      console.warn(`[Config] Corrupt hub-config.json — starting with defaults: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    port: envInt("PORT", 4001),
    host: envStr("HOST", "0.0.0.0"),
    nodeEnv: envStr("NODE_ENV", "development") as HubConfig["nodeEnv"],
    dbPath: envStr("DB_PATH", join(DATA_DIR, "hub.db")),
    dbEncryptionKey: process.env.DB_ENCRYPTION_KEY,

    cloudApiUrl: process.env.CLOUD_API_URL ?? saved.cloudApiUrl,
    cloudApiKey: process.env.CLOUD_API_KEY ?? saved.cloudApiKey,
    hubRegistrationToken: process.env.HUB_REGISTRATION_TOKEN,

    locationId: process.env.LOCATION_ID ?? saved.locationId,
    tenantId: process.env.TENANT_ID ?? saved.tenantId,
    hubSecret: process.env.HUB_SECRET ?? saved.hubSecret,

    mdnsEnabled: envBool("MDNS_ENABLED", true),
    mdnsServiceName: envStr("MDNS_SERVICE_NAME", "pos-hub-v2"),

    syncPullInterval: envInt("SYNC_PULL_INTERVAL", 30000),
    syncPushInterval: envInt("SYNC_PUSH_INTERVAL", 5000),
    dataRetentionDays: envInt("DATA_RETENTION_DAYS", 30),

    lockTimeoutMs: envInt("LOCK_TIMEOUT_MS", 300000),
    lockHeartbeatMs: envInt("LOCK_HEARTBEAT_MS", 30000),

    wsAuthRequired: envBool("WS_AUTH_REQUIRED", false),
    hubWsToken: process.env.HUB_WS_TOKEN ?? process.env.HUB_SECRET,

    isPrimary: envBool("IS_PRIMARY", false),
    hubEpoch: envInt("HUB_EPOCH", 0),
    replicationEnabled: envBool("REPLICATION_ENABLED", false),
    replicationPullInterval: envInt("REPLICATION_PULL_INTERVAL", 5000),
    primaryHubUrl: process.env.PRIMARY_HUB_URL,

    logLevel: envStr("LOG_LEVEL", "info"),
    allowedOrigins: envStr("ALLOWED_ORIGINS", "*"),
  };
}

export function saveConfig(updates: Record<string, string>): void {
  const savedConfigPath = join(DATA_DIR, "hub-config.json");
  let saved: Record<string, string> = {};

  if (existsSync(savedConfigPath)) {
    try {
      saved = JSON.parse(readFileSync(savedConfigPath, "utf-8"));
    } catch (err) {
      console.warn(`[Config] Corrupt hub-config.json on save — merging with empty: ${err instanceof Error ? err.message : err}`);
    }
  }

  const merged = { ...saved, ...updates };
  mkdirSync(dirname(savedConfigPath), { recursive: true });
  writeFileSync(savedConfigPath, JSON.stringify(merged, null, 2));
}

export const config = loadConfig();
