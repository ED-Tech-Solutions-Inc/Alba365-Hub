/**
 * Caller ID UDP Listener
 *
 * Listens for UDP broadcasts from CallerID.com Whozz Calling hardware
 * on the local network. Parses call records and stores them in SQLite.
 * Broadcasts WebSocket events to connected Flutter terminals.
 */

import { createSocket, type Socket } from "dgram";
import { getDb, generateId } from "../db/index.js";
import { config } from "../config.js";
import { broadcast } from "../realtime/websocket.js";
import {
  parseUdpPacket,
  isNewCall,
  isCallEnding,
  isCallAnswered,
  normalizePhoneNumber,
  formatPhoneNumber,
  type RawCallRecord,
  type CallStatus,
} from "./parser.js";

let server: Socket | null = null;

interface CallerIdConfig {
  id: string;
  enabled: number;
  udp_port: number;
  auto_lookup_customer: number;
  log_all_calls: number;
}

interface CallerIdLine {
  line_number: number;
  label: string | null;
  enabled: number;
  default_order_type: string | null;
  color: string | null;
}

/**
 * Start the UDP listener if caller ID is enabled for this location.
 */
export function startCallerIdListener() {
  const db = getDb();

  // Check if caller ID is configured and enabled
  const cfg = db.prepare(
    "SELECT id, enabled, udp_port, auto_lookup_customer, log_all_calls FROM caller_id_config WHERE location_id = ? AND enabled = 1",
  ).get(config.locationId) as CallerIdConfig | undefined;

  if (!cfg) {
    console.log("[CallerID] Not enabled for this location, skipping UDP listener");
    return;
  }

  const port = cfg.udp_port || 3520;

  try {
    server = createSocket("udp4");

    server.on("message", (msg, rinfo) => {
      const data = msg.toString("utf8");
      console.log(`[CallerID] UDP packet from ${rinfo.address}:${rinfo.port} (${data.length} bytes)`);

      try {
        const records = parseUdpPacket(data);
        for (const record of records) {
          handleCallRecord(record, cfg);
        }
      } catch (err) {
        console.error("[CallerID] Parse error:", err);
      }
    });

    server.on("error", (err) => {
      console.error(`[CallerID] UDP listener error: ${err.message}`);
      server?.close();
      server = null;
    });

    server.bind(port, () => {
      console.log(`[CallerID] UDP listener started on port ${port}`);
    });
  } catch (err) {
    console.error("[CallerID] Failed to start UDP listener:", err);
  }
}

/**
 * Stop the UDP listener.
 */
export function stopCallerIdListener() {
  if (server) {
    server.close();
    server = null;
    console.log("[CallerID] UDP listener stopped");
  }
}

/**
 * Handle a parsed call record from the hardware.
 */
function handleCallRecord(record: RawCallRecord, cfg: CallerIdConfig) {
  const db = getDb();

  // Check if this line is enabled
  const line = db.prepare(
    "SELECT line_number, label, enabled, default_order_type, color FROM caller_id_lines WHERE config_id = ? AND line_number = ?",
  ).get(cfg.id, record.lineNumber) as CallerIdLine | undefined;

  if (line && !line.enabled) {
    return; // Line disabled, ignore
  }

  if (isNewCall(record)) {
    handleNewCall(record, cfg, line);
  } else if (isCallAnswered(record)) {
    handleCallAnswered(record);
  } else if (isCallEnding(record)) {
    handleCallEnded(record);
  }
}

/**
 * Handle new incoming/outgoing call.
 */
function handleNewCall(record: RawCallRecord, cfg: CallerIdConfig, line: CallerIdLine | undefined) {
  const db = getDb();

  // Skip outbound calls unless logAllCalls is enabled
  if (record.direction === "OUTBOUND" && !cfg.log_all_calls) {
    return;
  }

  // Check for existing RINGING call on this line (avoid duplicates from repeated RING events)
  const existing = db.prepare(
    "SELECT id FROM call_log WHERE location_id = ? AND line_number = ? AND status = 'RINGING' AND call_started_at > datetime('now', '-5 minutes')",
  ).get(config.locationId, record.lineNumber) as { id: string } | undefined;

  if (existing) {
    // Update ring count on existing call
    db.prepare("UPDATE call_log SET ring_count = ?, updated_at = datetime('now') WHERE id = ?")
      .run(record.ringCount, existing.id);
    return;
  }

  // Auto-lookup customer by phone number
  let customerId: string | null = null;
  let customerName: string | null = null;
  if (cfg.auto_lookup_customer && record.phoneNumber) {
    const normalized = normalizePhoneNumber(record.phoneNumber);
    // Search by last 10 digits
    const customer = db.prepare(
      "SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ? LIMIT 1",
    ).get(`%${normalized.slice(-10)}`, `%${normalized}`) as { id: string; name: string } | undefined;

    if (customer) {
      customerId = customer.id;
      customerName = customer.name;
    }
  }

  const callId = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO call_log (id, location_id, line_number, direction, phone_number, caller_name,
      call_started_at, ring_count, status, customer_id, raw_data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RINGING', ?, ?, ?, ?)
  `).run(
    callId,
    config.locationId,
    record.lineNumber,
    record.direction,
    record.phoneNumber,
    record.callerName ?? customerName,
    now,
    record.ringCount,
    customerId,
    record.rawData,
    now,
    now,
  );

  // Broadcast to all POS terminals
  broadcast("call:incoming", {
    id: callId,
    lineNumber: record.lineNumber,
    direction: record.direction,
    phoneNumber: record.phoneNumber,
    formattedPhone: formatPhoneNumber(record.phoneNumber),
    callerName: record.callerName ?? customerName,
    callStartedAt: now,
    status: "RINGING",
    customerId,
    customerName,
    lineLabel: line?.label ?? `Line ${record.lineNumber}`,
    lineColor: line?.color ?? "#3B82F6",
    defaultOrderType: line?.default_order_type,
  });

  console.log(`[CallerID] New call: ${record.direction} on line ${record.lineNumber} from ${record.phoneNumber}`);
}

/**
 * Handle call answered (off-hook).
 */
function handleCallAnswered(record: RawCallRecord) {
  const db = getDb();

  const call = db.prepare(
    "SELECT id FROM call_log WHERE location_id = ? AND line_number = ? AND status = 'RINGING' ORDER BY call_started_at DESC LIMIT 1",
  ).get(config.locationId, record.lineNumber) as { id: string } | undefined;

  if (!call) return;

  db.prepare(
    "UPDATE call_log SET status = 'ANSWERED', updated_at = datetime('now') WHERE id = ?",
  ).run(call.id);

  broadcast("call:answered", {
    id: call.id,
    lineNumber: record.lineNumber,
    status: "ANSWERED" as CallStatus,
  });

  console.log(`[CallerID] Call answered on line ${record.lineNumber}`);
}

/**
 * Handle call ended.
 */
function handleCallEnded(record: RawCallRecord) {
  const db = getDb();

  // Find the most recent active call on this line
  const call = db.prepare(
    "SELECT id, status, call_started_at FROM call_log WHERE location_id = ? AND line_number = ? AND status IN ('RINGING', 'ANSWERED') ORDER BY call_started_at DESC LIMIT 1",
  ).get(config.locationId, record.lineNumber) as {
    id: string;
    status: string;
    call_started_at: string;
  } | undefined;

  if (!call) return;

  const now = new Date().toISOString();
  const startTime = new Date(call.call_started_at).getTime();
  const durationSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Determine final status: MISSED if was still ringing with rings, COMPLETED if was answered
  let finalStatus: CallStatus = "COMPLETED";
  if (call.status === "RINGING") {
    finalStatus = record.ringCount > 0 ? "MISSED" : "COMPLETED";
  }

  db.prepare(
    "UPDATE call_log SET status = ?, call_ended_at = ?, duration_seconds = ?, ring_count = ?, updated_at = ? WHERE id = ?",
  ).run(finalStatus, now, durationSeconds, record.ringCount, now, call.id);

  broadcast("call:ended", {
    id: call.id,
    lineNumber: record.lineNumber,
    status: finalStatus,
    durationSeconds,
  });

  console.log(`[CallerID] Call ended on line ${record.lineNumber}: ${finalStatus} (${durationSeconds}s)`);
}
