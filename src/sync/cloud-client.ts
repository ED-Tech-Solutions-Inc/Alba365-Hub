import { config } from "../config.js";

interface CloudResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

/**
 * HTTP client for communicating with the cloud API (Azure PostgreSQL via Next.js API).
 * Uses the hub's API key for authentication.
 */
export class CloudClient {
  private timeout: number;

  constructor() {
    this.timeout = 30_000;
  }

  /** Read live from config so credentials picked up after pairing */
  private get baseUrl(): string {
    return (config.cloudApiUrl ?? "").replace(/\/$/, "");
  }

  private get apiKey(): string {
    return config.cloudApiKey ?? "";
  }

  private get headers(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "X-Tenant-ID": config.tenantId ?? "",
      "X-Location-ID": config.locationId ?? "",
      "Content-Type": "application/json",
    };
  }

  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<CloudResponse<T>> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
        signal: controller.signal,
      });

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json() as T
        : null as T;

      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null as T,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async post<T = unknown>(path: string, body: unknown): Promise<CloudResponse<T>> {
    const url = new URL(path, this.baseUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json() as T
        : null as T;

      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null as T,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  isConfigured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }
}

// Singleton
let cloudClient: CloudClient | null = null;

export function getCloudClient(): CloudClient {
  if (!cloudClient) {
    cloudClient = new CloudClient();
  }
  return cloudClient;
}
