/**
 * Caller ID Parser — ported from apps/web/src/lib/caller-id/parser.ts
 *
 * Parses raw UDP data from CallerID.com Whozz Calling hardware.
 */

// --- Types ---
export type CallDirection = "INBOUND" | "OUTBOUND";
export type CallState = "START" | "END" | "RING" | "OFFHOOK" | "ONHOOK";
export type CallStatus = "RINGING" | "ANSWERED" | "MISSED" | "COMPLETED" | "DISMISSED";

export interface RawCallRecord {
  unitNumber?: string;
  serialNumber?: string;
  lineNumber: number;
  direction: CallDirection;
  state: CallState;
  duration: number;
  checksumValid: boolean;
  ringCount: number;
  timestamp: Date;
  phoneNumber: string;
  callerName: string | null;
  rawData: string;
}

/**
 * Regex for Whozz Calling data records:
 * LL D S DDDD C RR MM/DD HH:MM PP NNNNNNNNNNNN CCCCCCCCCCCCCCC
 */
const CALL_RECORD_REGEX =
  /(\d{2})\s+([IO])\s+([ESRB])\s+(\d{4})\s+([GB])\s+(.{2})\s+(\d{2}\/\d{2})\s+(\d{2}:\d{2}\s+[AP]M)\s+([0-9-]{7,15})\s*(.*)/;

function parseDirection(char: string): CallDirection {
  return char === "O" ? "OUTBOUND" : "INBOUND";
}

function parseState(char: string): CallState {
  switch (char) {
    case "S": return "START";
    case "E": return "END";
    case "R": return "RING";
    case "B": return "OFFHOOK";
    default: return "START";
  }
}

function parseDateTime(dateStr: string, timeStr: string): Date {
  const now = new Date();
  const [month, day] = dateStr.split("/").map(Number);
  const timeMatch = timeStr.match(/(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!timeMatch) return now;

  let hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const meridiem = timeMatch[3].toUpperCase();

  if (meridiem === "PM" && hours !== 12) hours += 12;
  else if (meridiem === "AM" && hours === 12) hours = 0;

  const timestamp = new Date(now.getFullYear(), month - 1, day, hours, minutes, 0, 0);
  if (timestamp > now) timestamp.setFullYear(now.getFullYear() - 1);
  return timestamp;
}

export function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function cleanCallerName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.replace(/_+$/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

/**
 * Parse UDP header: ^^<U>nnnnnn<S>nnnnnn$payload
 */
export function parseUdpHeader(data: string): {
  unitNumber: string;
  serialNumber: string;
  payload: string;
} | null {
  if (!data.startsWith("^^")) return null;

  const unitMarker = data.indexOf("<U>");
  const serialMarker = data.indexOf("<S>");
  const dataMarker = data.indexOf("$");

  if (unitMarker === -1 || serialMarker === -1 || dataMarker === -1) {
    return { unitNumber: "", serialNumber: "", payload: data };
  }

  return {
    unitNumber: data.substring(unitMarker + 3, unitMarker + 9).trim(),
    serialNumber: data.substring(serialMarker + 3, serialMarker + 9).trim(),
    payload: data.substring(dataMarker + 1).trim(),
  };
}

/**
 * Parse a single Whozz Calling record line.
 */
export function parseCallRecord(line: string, unitNumber?: string, serialNumber?: string): RawCallRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(CALL_RECORD_REGEX);
  if (!match) return null;

  const [rawData, lineNum, direction, state, durationStr, checksum, ringCountStr, dateStr, timeStr, phoneNumber, callerNameRaw] = match;

  let ringCount = 0;
  const ringTrimmed = ringCountStr.trim();
  if (ringTrimmed && /^\d+$/.test(ringTrimmed)) {
    ringCount = parseInt(ringTrimmed, 10);
  }

  return {
    unitNumber,
    serialNumber,
    lineNumber: parseInt(lineNum, 10),
    direction: parseDirection(direction),
    state: parseState(state),
    duration: parseInt(durationStr, 10),
    checksumValid: checksum === "G",
    ringCount,
    timestamp: parseDateTime(dateStr, timeStr),
    phoneNumber: normalizePhoneNumber(phoneNumber),
    callerName: cleanCallerName(callerNameRaw || null),
    rawData,
  };
}

/**
 * Parse a complete UDP packet (may contain multiple records).
 */
export function parseUdpPacket(data: string): RawCallRecord[] {
  const records: RawCallRecord[] = [];
  const headerResult = parseUdpHeader(data);
  const payload = headerResult?.payload ?? data;
  const { unitNumber, serialNumber } = headerResult ?? {};

  const lines = payload.split(/[\r\n]+/).filter((l) => l.trim());
  for (const line of lines) {
    const record = parseCallRecord(line, unitNumber, serialNumber);
    if (record) records.push(record);
  }
  return records;
}

export function isNewCall(record: RawCallRecord): boolean {
  return record.state === "START" || record.state === "RING";
}

export function isCallEnding(record: RawCallRecord): boolean {
  return record.state === "END" || record.state === "ONHOOK";
}

export function isCallAnswered(record: RawCallRecord): boolean {
  return record.state === "OFFHOOK";
}
