import type { ProviderId } from "../background/providers/types";

/**
 * Wire types shared by the side panel, the service worker, and the content
 * script. The three run in separate JS realms and only ever exchange these.
 */

/** One interactive or informative node the agent is allowed to reference. */
export interface PageElement {
  /** Stable-within-a-snapshot handle. The model only ever sees this. */
  id: number;
  /** ARIA role, or a normalised fallback derived from the tag name. */
  role: string;
  /** Accessible name: aria-label, associated <label>, placeholder, or text. */
  name: string;
  /** Current value for form controls, truncated. */
  value?: string;
  /** Extra hints the planner needs: checked, disabled, expanded, href host. */
  attrs?: Record<string, string>;
}

/** What the agent knows about the page at one point in time. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Interactive elements plus enough text nodes to give the page meaning. */
  elements: PageElement[];
  /** Visible text of the main content region, truncated. */
  text: string;
  /** True when the snapshot was cut off by the element budget. */
  truncated: boolean;
  /** Scroll position as a 0-1 fraction, so the model can tell it can scroll. */
  scroll: { y: number; maxY: number };
}

export type ActionName =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "go_back"
  | "key"
  | "wait"
  | "read_page"
  | "find_text"
  | "open_tab"
  | "switch_tab"
  | "close_tab"
  | "list_tabs";

/** A single action the planner asked for, already schema-validated. */
export interface AgentAction {
  name: ActionName;
  input: Record<string, unknown>;
}

/** Result of executing one action, fed back to the planner as a tool result. */
export interface ActionResult {
  ok: boolean;
  /** Human- and model-readable description of what happened. */
  detail: string;
  /** Populated when the action changed the page enough to warrant a re-read. */
  snapshot?: PageSnapshot;
  /** Populated when screenshot capture was requested. */
  screenshot?: ProcessedScreenshotResult;
}

/** Screenshot processing result from the privacy pipeline. */
export interface ProcessedScreenshotResult {
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
}

/** Messages the content script accepts. */
export type ContentRequest =
  | { kind: "snapshot" }
  | { kind: "act"; action: AgentAction }
  | { kind: "ping" }
  | { kind: "capture-screenshot" }
  | { kind: "capture-and-act"; action: AgentAction }
  | { kind: "get-sensitive-regions" };

/** A rendered entry in the side panel transcript. */
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "step" | "error" | "system";
  text: string;
  /** Set on "step" entries so the UI can show an icon per action type. */
  action?: ActionName;
  /** Set while a step is still running. */
  pending?: boolean;
}

/** Privacy audit snapshot — captured after each task for the judges. */
export interface PrivacyAuditSnapshot {
  /** Redacted screenshot as data URL (faces blurred, credentials masked). */
  redactedScreenshot?: string;
  /** PII detections found during this snapshot. */
  detections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
  }>;
  /** Token replacements made (e.g., <CRED_1> replaced "password123"). */
  tokens: Array<{ token: string; kind: string }>;
  /** Total PII items redacted in this snapshot. */
  redactedCount: number;
  /** Timestamp. */
  timestamp: number;
}

/** Service worker -> side panel events. */
export type AgentEvent =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "patch"; id: string; text?: string; pending?: boolean }
  | { kind: "status"; running: boolean }
  | {
      kind: "confirm";
      id: string;
      summary: string;
    }
  | {
      kind: "privacy-audit";
      audit: {
        screenshots: Array<{
          original?: string;
          redacted?: string;
          timestamp: number;
        }>;
        allDetections: Array<{
          kind: string;
          label: string;
          confidence: number;
        }>;
        allTokens: Array<{ token: string; kind: string }>;
        totalRedacted: number;
        totalScreenshots: number;
        totalPIIDetections: number;
        durationMs: number;
      };
    };

/** Side panel -> service worker commands. */
export type PanelCommand =
  | { kind: "run"; task: string; tabId: number }
  | { kind: "stop" }
  | { kind: "reset" }
  | { kind: "confirm-reply"; id: string; approved: boolean }
  | { kind: "get-state" }
  | { kind: "get-history" }
  | { kind: "delete-history"; sessionId?: string; clearAll?: boolean };

export interface Settings {
  provider: ProviderId;
  /** Keys are kept per provider so switching does not lose the others. */
  apiKeys: Record<ProviderId, string>;
  /** Chosen model per provider, likewise remembered independently. */
  models: Record<ProviderId, string>;
  /** Hard ceiling on planner turns, so a confused agent cannot spin forever. */
  maxSteps: number;
  /** Ask before click/type on anything that looks irreversible. */
  confirmRisky: boolean;
  /** VLESS server configuration for privacy-preserving VLM processing. */
  server: ServerSettings;
  /** Privacy pipeline configuration. */
  privacy: PrivacySettings;
}

export interface ServerSettings {
  /** Whether to use the VLESS server for VLM processing. */
  enabled: boolean;
  /** Server URL (default: http://localhost:3001). */
  url: string;
  /** API key for the VLESS server (optional, for authenticated servers). */
  apiKey: string;
}

export interface PrivacySettings {
  /** Enable face detection and blur on screenshots. */
  blurFaces: boolean;
  /** Enable credential field masking. */
  maskCredentials: boolean;
  /** Enable PII tokenization for DOM values. */
  tokenizePII: boolean;
  /** Show redaction labels on screenshots (demo mode). */
  showRedactionLabels: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  apiKeys: { anthropic: "", openai: "", openrouter: "", ollama: "" },
  models: {
    anthropic: "claude-opus-5",
    openai: "gpt-5",
    openrouter: "anthropic/claude-opus-5",
    ollama: "qwen2.5:1.5b",
  },
  maxSteps: 40,
  confirmRisky: true,
  server: {
    enabled: false,
    url: "http://localhost:3001",
    apiKey: "",
  },
  privacy: {
    blurFaces: true,
    maskCredentials: true,
    tokenizePII: true,
    showRedactionLabels: false,
  },
};

/** The shape stored before multi-provider support landed. */
interface LegacySettings {
  apiKey?: string;
  model?: string;
}

/**
 * Reads settings out of storage, upgrading anything written by an older
 * version so an existing install keeps its key instead of silently losing it.
 */
export function normaliseSettings(stored: unknown): Settings {
  const raw = (stored ?? {}) as Partial<Settings> & LegacySettings;

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(raw.apiKeys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(raw.models ?? {}) },
    server: { ...DEFAULT_SETTINGS.server, ...(raw.server ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(raw.privacy ?? {}) },
  };

  // Pre-multi-provider installs stored a bare Anthropic key and model.
  if (raw.apiKey && !settings.apiKeys.anthropic) settings.apiKeys.anthropic = raw.apiKey;
  if (raw.model && !raw.models) settings.models.anthropic = raw.model;

  return settings;
}
