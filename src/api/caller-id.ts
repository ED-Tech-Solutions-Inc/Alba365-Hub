/**
 * Caller ID API routes for Hub v2.
 *
 * Endpoints:
 *   GET  /api/caller-id/config       — Get caller ID config + lines
 *   GET  /api/caller-id/active-calls — Get RINGING/ANSWERED calls (last hour)
 *   POST /api/caller-id/dismiss      — Dismiss a call
 *   GET  /api/caller-id/lookup-customer — Lookup customer by phone number
 *   GET  /api/caller-id/poll         — Poll for calls since timestamp
 */

import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { formatPhoneNumber } from "../caller-id/parser.js";
import { broadcast } from "../realtime/websocket.js";

interface CallRow {
  id: string;
  line_number: number;
  direction: string;
  phone_number: string | null;
  caller_name: string | null;
  call_started_at: string;
  call_ended_at: string | null;
  duration_seconds: number | null;
  ring_count: number;
  status: string;
  customer_id: string | null;
  order_id: string | null;
  order_type: string | null;
  raw_data: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  line_number: number;
  label: string | null;
  enabled: number;
  default_order_type: string | null;
  color: string | null;
  priority: number;
}

export function registerCallerIdRoutes(app: FastifyInstance) {
  // --- GET /api/caller-id/config ---
  app.get("/api/caller-id/config", async (_req, reply) => {
    const db = getDb();

    const cfg = db.prepare(
      "SELECT * FROM caller_id_config WHERE location_id = ?",
    ).get(config.locationId) as Record<string, unknown> | undefined;

    if (!cfg) {
      return reply.send({ enabled: false, lines: [] });
    }

    const lines = db.prepare(
      "SELECT * FROM caller_id_lines WHERE config_id = ? ORDER BY line_number",
    ).all(cfg.id) as LineRow[];

    return reply.send({
      ...cfg,
      enabled: !!cfg.enabled,
      auto_lookup_customer: !!cfg.auto_lookup_customer,
      log_all_calls: !!cfg.log_all_calls,
      show_caller_animation: !!cfg.show_caller_animation,
      popup_on_incoming: !!cfg.popup_on_incoming,
      play_ring_sound: !!cfg.play_ring_sound,
      lines: lines.map((l) => ({
        ...l,
        enabled: !!l.enabled,
      })),
    });
  });

  // --- GET /api/caller-id/active-calls ---
  app.get("/api/caller-id/active-calls", async (_req, reply) => {
    const db = getDb();

    // Get RINGING and ANSWERED calls from the last hour
    const calls = db.prepare(`
      SELECT * FROM call_log
      WHERE location_id = ?
        AND status IN ('RINGING', 'ANSWERED')
        AND call_started_at > datetime('now', '-1 hour')
      ORDER BY call_started_at DESC
    `).all(config.locationId) as CallRow[];

    // Get config + lines for enrichment
    const cfg = db.prepare(
      "SELECT id FROM caller_id_config WHERE location_id = ?",
    ).get(config.locationId) as { id: string } | undefined;

    const lines = cfg
      ? (db.prepare(
          "SELECT line_number, label, default_order_type, color FROM caller_id_lines WHERE config_id = ?",
        ).all(cfg.id) as LineRow[])
      : [];

    const lineMap = new Map(lines.map((l) => [l.line_number, l]));

    // Enrich calls with line info + computed fields
    const enriched = calls.map((call) => {
      const line = lineMap.get(call.line_number);
      const startTime = new Date(call.call_started_at).getTime();
      const ringingDuration = Math.floor((Date.now() - startTime) / 1000);

      // Lookup customer name if we have a customer_id
      let customerName: string | null = call.caller_name;
      if (call.customer_id) {
        const customer = db.prepare("SELECT name FROM customers WHERE id = ?")
          .get(call.customer_id) as { name: string } | undefined;
        if (customer) customerName = customer.name;
      }

      return {
        id: call.id,
        lineNumber: call.line_number,
        direction: call.direction,
        phoneNumber: call.phone_number,
        formattedPhone: call.phone_number ? formatPhoneNumber(call.phone_number) : null,
        callerName: customerName,
        callStartedAt: call.call_started_at,
        status: call.status,
        customerId: call.customer_id,
        ringingDuration,
        lineLabel: line?.label ?? `Line ${call.line_number}`,
        lineColor: line?.color ?? "#3B82F6",
        defaultOrderType: line?.default_order_type ?? null,
      };
    });

    return reply.send({ calls: enriched, serverTime: new Date().toISOString() });
  });

  // --- POST /api/caller-id/dismiss ---
  app.post("/api/caller-id/dismiss", async (req, reply) => {
    const { callId } = req.body as { callId: string };
    if (!callId) {
      return reply.status(400).send({ error: "callId required" });
    }

    const db = getDb();
    const now = new Date().toISOString();

    const call = db.prepare(
      "SELECT id, call_started_at FROM call_log WHERE id = ? AND location_id = ?",
    ).get(callId, config.locationId) as { id: string; call_started_at: string } | undefined;

    if (!call) {
      return reply.status(404).send({ error: "Call not found" });
    }

    const durationSeconds = Math.floor((Date.now() - new Date(call.call_started_at).getTime()) / 1000);

    db.prepare(
      "UPDATE call_log SET status = 'DISMISSED', call_ended_at = ?, duration_seconds = ?, updated_at = ? WHERE id = ?",
    ).run(now, durationSeconds, now, callId);

    broadcast("call:dismissed", { id: callId, status: "DISMISSED" });

    return reply.send({ success: true });
  });

  // --- GET /api/caller-id/lookup-customer ---
  app.get("/api/caller-id/lookup-customer", async (req, reply) => {
    const { phone } = req.query as { phone?: string };
    if (!phone) {
      return reply.status(400).send({ error: "phone query param required" });
    }

    const db = getDb();
    const digits = phone.replace(/\D/g, "");
    const last10 = digits.slice(-10);

    // Find customer by phone
    const customer = db.prepare(`
      SELECT id, name, email, phone FROM customers
      WHERE phone LIKE ? OR phone LIKE ?
      LIMIT 1
    `).get(`%${last10}`, `%${digits}`) as {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
    } | undefined;

    if (!customer) {
      return reply.send({ found: false });
    }

    // Get customer address
    const address = db.prepare(
      "SELECT street, city, province, postal_code FROM customer_addresses WHERE customer_id = ? LIMIT 1",
    ).get(customer.id) as {
      street: string;
      city: string;
      province: string;
      postal_code: string;
    } | undefined;

    // Count recent orders
    const orderCount = db.prepare(
      "SELECT COUNT(*) as count FROM sales WHERE customer_id = ?",
    ).get(customer.id) as { count: number };

    // Get last 3 orders
    const recentOrders = db.prepare(`
      SELECT id, receipt_number, order_type, total, created_at
      FROM sales WHERE customer_id = ?
      ORDER BY created_at DESC LIMIT 3
    `).all(customer.id) as Array<{
      id: string;
      receipt_number: string;
      order_type: string;
      total: number;
      created_at: string;
    }>;

    return reply.send({
      found: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: address
          ? `${address.street}, ${address.city}, ${address.province} ${address.postal_code}`
          : null,
        orderCount: orderCount.count,
        recentOrders,
      },
    });
  });

  // --- GET /api/caller-id/poll ---
  app.get("/api/caller-id/poll", async (req, reply) => {
    const { since } = req.query as { since?: string };
    const db = getDb();

    const sinceTime = since || new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const calls = db.prepare(`
      SELECT * FROM call_log
      WHERE location_id = ?
        AND updated_at > ?
      ORDER BY updated_at DESC
      LIMIT 50
    `).all(config.locationId, sinceTime) as CallRow[];

    // Get line info for enrichment
    const cfg = db.prepare(
      "SELECT id FROM caller_id_config WHERE location_id = ?",
    ).get(config.locationId) as { id: string } | undefined;

    const lines = cfg
      ? (db.prepare(
          "SELECT line_number, label, default_order_type, color FROM caller_id_lines WHERE config_id = ?",
        ).all(cfg.id) as LineRow[])
      : [];

    const lineMap = new Map(lines.map((l) => [l.line_number, l]));

    const enriched = calls.map((call) => {
      const line = lineMap.get(call.line_number);
      return {
        id: call.id,
        lineNumber: call.line_number,
        direction: call.direction,
        phoneNumber: call.phone_number,
        formattedPhone: call.phone_number ? formatPhoneNumber(call.phone_number) : null,
        callerName: call.caller_name,
        callStartedAt: call.call_started_at,
        callEndedAt: call.call_ended_at,
        durationSeconds: call.duration_seconds,
        ringCount: call.ring_count,
        status: call.status,
        customerId: call.customer_id,
        lineLabel: line?.label ?? `Line ${call.line_number}`,
        lineColor: line?.color ?? "#3B82F6",
        defaultOrderType: line?.default_order_type ?? null,
        updatedAt: call.updated_at,
      };
    });

    return reply.send({ calls: enriched, serverTime: new Date().toISOString() });
  });
}
