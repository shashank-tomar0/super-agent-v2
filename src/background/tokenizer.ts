/**
 * PII Tokenizer
 *
 * Replaces sensitive values with opaque tokens before data crosses the wire.
 * The vault is held in memory only — never persisted to chrome.storage or
 * any other durable storage.
 *
 * Token format: `<TYPE_N>` where TYPE is ORG, PERSON, ID, CRED, KEY
 * and N is a monotonically increasing counter per type.
 *
 * The server receives tokens and can reference them in responses, but can
 * never resolve them back to real values.
 */

import type { DetectedPII } from "./pii-detector";

// ─── Token Vault ────────────────────────────────────────────────────────────

export interface TokenEntry {
  token: string;
  /** The original value — held only in memory. */
  original: string;
  kind: DetectedPII["kind"];
  createdAt: number;
}

export type TokenVault = Map<string, TokenEntry>;

/** Token type prefixes for different PII categories. */
const TOKEN_PREFIXES: Record<DetectedPII["kind"], string> = {
  face: "FACE",
  credential: "CRED",
  id_number: "ID",
  api_key: "KEY",
  pii_text: "PII",
};

// ─── Tokenizer Class ────────────────────────────────────────────────────────

export class PIITokenizer {
  private vault: TokenVault = new Map();
  private counters: Record<string, number> = {};

  /**
   * Generate a unique token for a value.
   * If the value was already tokenized, return the existing token.
   */
  tokenize(value: string, kind: DetectedPII["kind"]): string {
    // Check if already tokenized.
    const existing = this.findToken(value);
    if (existing) return existing.token;

    const prefix = TOKEN_PREFIXES[kind] ?? "PII";
    const count = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = count;
    const token = `<${prefix}_${count}>`;

    this.vault.set(token, {
      token,
      original: value,
      kind,
      createdAt: Date.now(),
    });

    return token;
  }

  /**
   * Resolve a token back to its original value.
   * Only called at the last possible moment before executing an action.
   */
  resolve(token: string): string | undefined {
    return this.vault.get(token)?.original;
  }

  /**
   * Check if a string contains any tokens.
   */
  containsTokens(text: string): boolean {
    return /<[A-Z]+_\d+>/.test(text);
  }

  /**
   * Replace all tokens in a string with their original values.
   * Used when the server returns a command that references tokenized data.
   */
  resolveAll(text: string): string {
    return text.replace(/<[A-Z]+_\d+>/g, (match) => {
      return this.resolve(match) ?? match;
    });
  }

  /**
   * Find the token for a value (reverse lookup).
   */
  findToken(value: string): TokenEntry | undefined {
    for (const entry of this.vault.values()) {
      if (entry.original === value) return entry;
    }
    return undefined;
  }

  /**
   * Tokenize all detected PII in a snapshot's elements and text.
   * Returns a new snapshot with tokens in place of sensitive values.
   */
  tokenizeSnapshot(snapshot: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
    url: string;
    title: string;
  }): {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
    url: string;
    title: string;
    tokenCount: number;
  } {
    let tokenCount = 0;

    const elements = snapshot.elements.map((el) => {
      const newEl = { ...el };

      // Tokenize element values that are sensitive.
      if (newEl.value && this.shouldTokenizeValue(newEl)) {
        newEl.value = this.tokenize(newEl.value, "credential");
        tokenCount++;
      }

      return newEl;
    });

    // Tokenize ID numbers in page text.
    let text = snapshot.text;
    const idPatterns: Array<{ pattern: RegExp; kind: DetectedPII["kind"] }> = [
      { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, kind: "id_number" },
      { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, kind: "id_number" },
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "id_number" },
    ];

    for (const { pattern, kind } of idPatterns) {
      text = text.replace(pattern, (match) => {
        tokenCount++;
        return this.tokenize(match, kind);
      });
    }

    return { ...snapshot, elements, text, tokenCount };
  }

  /**
   * Tokenize values that the detectors actually flagged.
   *
   * Detection and tokenization were previously disconnected: the detectors
   * found names/emails/phones in fields and ID numbers in text, but the
   * tokenizer only knew about password-role inputs and its own hardcoded ID
   * patterns. As a result the vault stayed empty and the audit had no tokens
   * to show even when PII was found.
   *
   * This closes that gap: every detection with a value gets that value
   * replaced by a vault token (in its element and/or in the page text).
   */
  tokenizeDetections(
    snapshot: {
      elements: Array<{
        id: number;
        role: string;
        name: string;
        value?: string;
        attrs?: Record<string, string>;
      }>;
      text: string;
      url: string;
      title: string;
    },
    detections: Array<{
      kind: string;
      value?: string;
      elementSelector?: string;
    }>,
  ): {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
    url: string;
    title: string;
    tokenCount: number;
  } {
    const TOKEN_RE = /^<[A-Z]+_\d+>$/;
    const elements = snapshot.elements.map((el) => ({ ...el }));
    let text = snapshot.text;
    let tokenCount = 0;
    const elementsById = new Map(elements.map((el) => [el.id, el]));

    for (const det of detections) {
      if (!det.value || det.kind === "face") continue;
      const val = det.value;
      if (TOKEN_RE.test(val)) continue;

      // Map any detector kind onto a token kind the vault understands.
      const tokenKind = (det.kind === "pii_text" || det.kind === "person" || det.kind === "organization"
        ? "pii_text"
        : det.kind === "id_number" || det.kind === "api_key" || det.kind === "credential"
          ? det.kind
          : "credential") as DetectedPII["kind"];

      const token = this.tokenize(val, tokenKind);
      let replacedAny = false;

      // 1) Element path: replace the value on the element the detector flagged.
      const selMatch = det.elementSelector?.match(/data-vless-id="(\d+)"/);
      if (selMatch) {
        const el = elementsById.get(parseInt(selMatch[1], 10));
        if (el && el.value && el.value.includes(val) && !TOKEN_RE.test(el.value)) {
          el.value = el.value.split(val).join(token);
          replacedAny = true;
        }
      }

      // 2) Text path: replace remaining occurrences (guarded by length so we
      //    never mangle tiny substrings like "No" inside ordinary sentences,
      //    and word-bounded so "Singh" never corrupts "Singhania").
      if (val.length >= 4 && text.includes(val)) {
        const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isAlpha = /^[A-Za-z ]+$/.test(val);
        const bounded = isAlpha
          ? new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, "g")
          : new RegExp(escaped, "g");
        const next = text.replace(bounded, (match, lead) => `${lead ?? ""}${token}`);
        if (next !== text) {
          text = next;
          replacedAny = true;
        }
      }

      if (replacedAny) tokenCount++;
    }

    return { ...snapshot, elements, text, tokenCount };
  }

  /**
   * Tokenize PII found in the user's task description.
   * This ensures the LLM sees the same tokens in the task as on screen,
   * so it can match "Sharma Traders" in the task to <ORG_3> on screen.
   */
  tokenizeTask(task: string): { task: string; tokenCount: number } {
    let tokenCount = 0;
    let result = task;

    // Tokenize email addresses.
    result = result.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, (match) => {
      tokenCount++;
      return this.tokenize(match, "credential");
    });

    // Tokenize phone numbers (Indian format: +91 XXXXX XXXXX, or 10 digits).
    result = result.replace(/(\+91[\s-]?)?\b\d{5}[\s-]?\d{5}\b/g, (match) => {
      tokenCount++;
      return this.tokenize(match, "credential");
    });

    // Tokenize ID numbers.
    const idPatterns: Array<{ pattern: RegExp; kind: DetectedPII["kind"] }> = [
      { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, kind: "id_number" },  // Aadhaar
      { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, kind: "id_number" },      // PAN
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "id_number" },       // SSN
      { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, kind: "credential" }, // Card
    ];

    for (const { pattern, kind } of idPatterns) {
      result = result.replace(pattern, (match) => {
        tokenCount++;
        return this.tokenize(match, kind);
      });
    }

    // Tokenize names that appear after common patterns.
    // "from Sharma Traders" → "from <ORG_3>"
    // "to John Doe" → "to <PERSON_1>"
    const namePatterns = [
      { pattern: /\b(from|to|sender|recipient|addressed to|sent by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g, kind: "pii_text" as const },
      { pattern: /\b(name|company|business|firm|organization|vendor|supplier|client)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g, kind: "pii_text" as const },
    ];

    for (const { pattern, kind } of namePatterns) {
      result = result.replace(pattern, (match, prefix, name) => {
        tokenCount++;
        const token = this.tokenize(name, kind);
        return `${prefix} ${token}`;
      });
    }

    return { task: result, tokenCount };
  }

  /**
   * Determine if an element's value should be tokenized based on its
   * role and attributes.
   */
  private shouldTokenizeValue(el: { role: string; attrs?: Record<string, string> }): boolean {
    if (el.role === "password") return true;
    if (el.attrs?.inputType === "password") return true;
    if (el.attrs?.inputType === "hidden") return false;

    // Check credential patterns on the element's metadata.
    const haystack = `${el.role} ${Object.values(el.attrs ?? {}).join(" ")}`;
    return /\b(password|secret|key|token|cvv|otp)\b/i.test(haystack);
  }

  /**
   * Get a summary of all tokenized values (for debugging/demo).
   * Does NOT expose the original values — just the token→kind mapping plus a
   * masked sample ("r•••@gmail.com") so the UI can show what was tokenized.
   */
  getTokenSummary(): Array<{ token: string; kind: string; sample?: string }> {
    return Array.from(this.vault.values()).map((entry) => ({
      token: entry.token,
      kind: entry.kind,
      sample: maskSample(entry.original),
    }));
  }

  /**
   * Clear the entire vault. Called when the task ends or the user resets.
   */
  clear(): void {
    this.vault.clear();
    this.counters = {};
  }

  /**
   * Number of tokens in the vault.
   */
  get size(): number {
    return this.vault.size;
  }
}

/**
 * Shared singleton tokenizer instance.
 * Lives for the duration of one task run, then gets cleared.
 */
export const tokenizer = new PIITokenizer();

/**
 * Produces a display-safe sample of a tokenized value so the audit UI can show
 * WHAT was tokenized without ever exposing the raw value.
 *
 *   "rahul@gmail.com"    → "ra•••@gmail.com"
 *   "9876543210"         → "98••••3210"
 *   "Sharma Traders Pvt" → "Sh••••••••••••"
 */
export function maskSample(value: string): string {
  const v = String(value);
  if (v.length <= 2) return "••";

  // Emails keep their domain visible so the kind is obvious.
  const at = v.indexOf("@");
  if (at > 0 && v.includes(".")) {
    const local = v.slice(0, at);
    const domain = v.slice(at);
    return `${local.slice(0, 2)}•••${domain}`;
  }

  // Digits: keep first 2 and last 4.
  if (/\d/.test(v) && v.replace(/\D/g, "").length >= 8) {
    const first2 = v.slice(0, 2);
    const last4 = v.slice(-4);
    return `${first2}••••${last4}`;
  }

  return `${v.slice(0, 2)}••••••••`;
}
