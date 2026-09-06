/**
 * Privacy Budget Ledger
 *
 * Creates an immutable, cryptographically hashed audit trail of every
 * privacy-relevant action the agent takes. Each entry is SHA-256 hashed
 * and chained to the previous entry, making tampering detectable.
 *
 * This is the "enterprise-grade" feature that proves VLESS's privacy
 * claims are verifiable, not just asserted.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  /** Sequential entry number. */
  seq: number;
  /** Timestamp. */
  timestamp: number;
  /** Type of event. */
  type: "snapshot" | "detection" | "tokenize" | "redact" | "resolve" | "action" | "verification";
  /** Event-specific data. */
  data: Record<string, unknown>;
  /** SHA-256 hash of this entry's content. */
  hash: string;
  /** Hash of the previous entry (chain). */
  prevHash: string;
}

export interface PrivacyLedger {
  /** Session ID. */
  sessionId: string;
  /** All entries in order. */
  entries: LedgerEntry[];
  /** Summary statistics. */
  summary: {
    totalSnapshots: number;
    totalDetections: number;
    totalTokensCreated: number;
    totalRedactions: number;
    totalActions: number;
    verificationPassed: boolean;
    /** Whether the chain is valid (no tampering). */
    chainValid: boolean;
  };
}

// ─── SHA-256 Helper ─────────────────────────────────────────────────────────

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Ledger Implementation ──────────────────────────────────────────────────

let currentEntries: LedgerEntry[] = [];
let entryCounter = 0;
let lastHash = "0".repeat(64); // Genesis hash.

/**
 * Initialize the ledger for a new session.
 */
export function initLedger(): void {
  currentEntries = [];
  entryCounter = 0;
  lastHash = "0".repeat(64);
}

/**
 * Add an entry to the ledger.
 */
export async function addEntry(
  type: LedgerEntry["type"],
  data: Record<string, unknown>,
): Promise<LedgerEntry> {
  const seq = ++entryCounter;
  const timestamp = Date.now();

  // Build the content to hash (excluding hash fields).
  const content = JSON.stringify({ seq, timestamp, type, data, prevHash: lastHash });
  const hash = await sha256(content);

  const entry: LedgerEntry = {
    seq,
    timestamp,
    type,
    data,
    hash,
    prevHash: lastHash,
  };

  lastHash = hash;
  currentEntries.push(entry);

  return entry;
}

/**
 * Record a page snapshot capture.
 */
export async function recordSnapshot(url: string, title: string, elementCount: number): Promise<LedgerEntry> {
  return addEntry("snapshot", { url, title, elementCount });
}

/**
 * Record PII detections.
 */
export async function recordDetections(
  detections: Array<{ kind: string; method: string; confidence: number; label: string }>,
): Promise<LedgerEntry> {
  return addEntry("detection", {
    count: detections.length,
    kinds: [...new Set(detections.map((d) => d.kind))],
    methods: [...new Set(detections.map((d) => d.method))],
  });
}

/**
 * Record token creation.
 */
export async function recordTokenization(tokens: Array<{ token: string; kind: string }>): Promise<LedgerEntry> {
  // Never store the original values - only the token→kind mapping.
  return addEntry("tokenize", {
    count: tokens.length,
    tokenTypes: [...new Set(tokens.map((t) => t.kind))],
  });
}

/**
 * Record a redaction event.
 */
export async function recordRedaction(redactedCount: number, method: string): Promise<LedgerEntry> {
  return addEntry("redact", { redactedCount, method });
}

/**
 * Record a token resolution (token → real value at action time).
 */
export async function recordResolution(token: string, kind: string): Promise<LedgerEntry> {
  // Never store the resolved value - only that a resolution happened.
  return addEntry("resolve", { token, kind });
}

/**
 * Record an action execution.
 */
export async function recordAction(tool: string, success: boolean, elementId?: number): Promise<LedgerEntry> {
  return addEntry("action", { tool, success, elementId });
}

/**
 * Record re-OCR verification result.
 */
export async function recordVerification(passed: boolean, regionsChecked: number, leakedCount: number): Promise<LedgerEntry> {
  return addEntry("verification", { passed, regionsChecked, leakedCount });
}

/**
 * Get the complete ledger for a session.
 */
export async function getLedger(): Promise<PrivacyLedger> {
  const summary = {
    totalSnapshots: 0,
    totalDetections: 0,
    totalTokensCreated: 0,
    totalRedactions: 0,
    totalActions: 0,
    verificationPassed: true,
    chainValid: true,
  };

  // Verify chain integrity.
  let prevHash = "0".repeat(64);
  for (const entry of currentEntries) {
    // Check chain link.
    if (entry.prevHash !== prevHash) {
      summary.chainValid = false;
    }

    // Verify hash.
    const content = JSON.stringify({
      seq: entry.seq,
      timestamp: entry.timestamp,
      type: entry.type,
      data: entry.data,
      prevHash: entry.prevHash,
    });
    const expectedHash = await sha256(content);
    if (expectedHash !== entry.hash) {
      summary.chainValid = false;
    }

    // Count by type.
    switch (entry.type) {
      case "snapshot": summary.totalSnapshots++; break;
      case "detection": summary.totalDetections += (entry.data.count as number) ?? 0; break;
      case "tokenize": summary.totalTokensCreated += (entry.data.count as number) ?? 0; break;
      case "redact": summary.totalRedactions += (entry.data.redactedCount as number) ?? 0; break;
      case "action": summary.totalActions++; break;
      case "verification":
        if (!entry.data.passed) summary.verificationPassed = false;
        break;
    }

    prevHash = entry.hash;
  }

  return {
    sessionId: `session-${currentEntries[0]?.timestamp ?? Date.now()}`,
    entries: currentEntries,
    summary,
  };
}

/**
 * Export the ledger as a downloadable JSON.
 */
export async function exportLedger(): Promise<string> {
  const ledger = await getLedger();
  return JSON.stringify(ledger, null, 2);
}
