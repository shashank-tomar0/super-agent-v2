import type {
  AgentEvent,
  PanelCommand,
  ProcessedScreenshotResult,
  Settings,
  TranscriptEntry,
} from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { runTask } from "./agent";

// The side panel can be closed and reopened mid-run, so the transcript lives
// here rather than in the panel's own memory.
let transcript: TranscriptEntry[] = [];
let running = false;
let abort: AbortController | null = null;

const pendingConfirms = new Map<string, (approved: boolean) => void>();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return normaliseSettings(stored.settings);
}

/** Broadcasts to the panel; a closed panel simply has no receiver. */
function emit(event: AgentEvent): void {
  if (event.kind === "entry") {
    transcript.push(event.entry);
  } else if (event.kind === "patch") {
    const entry = transcript.find((e) => e.id === event.id);
    if (entry) {
      // Text deltas append; step updates replace.
      if (event.text !== undefined) {
        entry.text = entry.role === "assistant" ? entry.text + event.text : event.text;
      }
      if (event.pending !== undefined) entry.pending = event.pending;
    }
  }
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

function askConfirm(id: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve);
    emit({ kind: "confirm", id, summary });
  });
}

// ─── Screenshot Capture (Service Worker Only) ───────────────────────────────

/**
 * Ensure the offscreen document exists. Only the service worker can
 * create offscreen documents via chrome.offscreen.createDocument.
 */
async function ensureOffscreenDocument(): Promise<void> {
  try {
    const existingContexts = await (chrome.runtime as any).getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existingContexts?.length > 0) return;
  } catch {
    // getContexts may not be available in older Chrome versions.
  }

  try {
    await (chrome.offscreen as any).createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "BLOBS"],
      justification: "WebGPU inference for on-device vision model and PII detection",
    });
  } catch {
    // May already exist.
  }
}

/**
 * Capture the visible tab area. This MUST run in the service worker
 * because chrome.tabs.captureVisibleTab is not available in content scripts.
 */
async function captureVisibleTab(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });

    // Get image dimensions by loading into an offscreen canvas.
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    return { dataUrl, width, height };
  } catch {
    return null;
  }
}

/**
 * Process a screenshot through the offscreen document's privacy pipeline.
 * Returns the redacted image and detection results.
 */
async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
): Promise<ProcessedScreenshotResult> {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Offscreen processing timed out after 10s"));
    }, 10000);

    // Listen for the response from the offscreen document.
    const listener = (
      message: { type: string; result?: ProcessedScreenshotResult; error?: string },
      _sender: chrome.runtime.MessageSender,
    ) => {
      if (message.type === "screenshot-processed") {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.result!);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Send the screenshot to the offscreen document for processing.
    chrome.runtime.sendMessage({
      type: "process-screenshot",
      dataUrl,
      width,
      height,
    });
  });
}

/**
 * Capture and process a screenshot in one call.
 * Called by the agent loop for visual perception.
 */
export async function captureAndProcessScreenshot(): Promise<{
  processed: ProcessedScreenshotResult;
} | null> {
  const captured = await captureVisibleTab();
  if (!captured) return null;

  const processed = await processScreenshot(captured.dataUrl, captured.width, captured.height);
  return { processed };
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

async function start(task: string, tabId: number): Promise<void> {
  if (running) return;

  const settings = await loadSettings();

  running = true;
  abort = new AbortController();
  emit({ kind: "status", running: true });
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: task } });

  try {
    await runTask(task, tabId, {
      settings,
      emit,
      askConfirm,
      signal: abort.signal,
      captureScreenshot: captureAndProcessScreenshot,
    });
  } catch (error) {
    emit({
      kind: "entry",
      entry: {
        id: `err-${Date.now()}`,
        role: "error",
        text: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    running = false;
    abort = null;
    // Nothing is waiting on an answer once the run is over.
    for (const resolve of pendingConfirms.values()) resolve(false);
    pendingConfirms.clear();
    emit({ kind: "status", running: false });
  }
}

chrome.runtime.onMessage.addListener(
  (command: PanelCommand, _sender, sendResponse: (r: unknown) => void) => {
    switch (command.kind) {
      case "run":
        void start(command.task, command.tabId);
        sendResponse({ ok: true });
        return false;

      case "stop":
        abort?.abort();
        for (const resolve of pendingConfirms.values()) resolve(false);
        pendingConfirms.clear();
        running = false;
        emit({ kind: "status", running: false });
        emit({
          kind: "entry",
          entry: { id: `s-${Date.now()}`, role: "system", text: "Stopped." },
        });
        sendResponse({ ok: true });
        return false;

      case "reset":
        abort?.abort();
        transcript = [];
        running = false;
        sendResponse({ ok: true });
        return false;

      case "confirm-reply": {
        const resolve = pendingConfirms.get(command.id);
        pendingConfirms.delete(command.id);
        resolve?.(command.approved);
        sendResponse({ ok: true });
        return false;
      }

      case "get-state":
        sendResponse({ transcript, running });
        return false;

      default:
        return false;
    }
  },
);
