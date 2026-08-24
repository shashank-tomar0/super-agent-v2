/**
 * Screenshot Capture Pipeline
 *
 * Captures the visible tab area and sends it through the privacy pipeline
 * before any network transmission. This is the visual perception channel
 * that complements the DOM-based perception in perceive.ts.
 *
 * Flow:
 *   1. Capture visible tab via chrome.tabs.captureVisibleTab
 *   2. Send to offscreen document for PII detection + redaction
 *   3. Return sanitized ImageBitmap for server transmission
 */

// ─── Capture ────────────────────────────────────────────────────────────────

export interface CapturedScreenshot {
  /** The raw captured image data. */
  dataUrl: string;
  /** Image dimensions. */
  width: number;
  height: number;
  /** Timestamp of capture. */
  timestamp: number;
}

/**
 * Captures the visible area of the current tab.
 * Uses chrome.tabs.captureVisibleTab which is available in content scripts
 * when the extension has the "activeTab" permission.
 */
export async function captureVisibleTab(): Promise<CapturedScreenshot | null> {
  try {
    // Use the callback-based API and promisify it to avoid type issues.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        undefined as unknown as number, // windowId — undefined means current
        { format: "png" },
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        },
      );
    });

    // Parse dimensions from the data URL.
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load captured image"));
      img.src = dataUrl;
    });

    return {
      dataUrl,
      width: img.naturalWidth,
      height: img.naturalHeight,
      timestamp: Date.now(),
    };
  } catch {
    // captureVisibleTab can fail if the page is not ready or the tab
    // is a restricted URL. Return null rather than throwing.
    return null;
  }
}

// ─── Offscreen Processing ───────────────────────────────────────────────────

/**
 * Ensure the offscreen document exists. In Manifest V3, long-running
 * operations like WebGPU inference must happen in an offscreen document
 * because service workers cannot access DOM APIs.
 */
async function ensureOffscreenDocument(): Promise<void> {
  // Check if offscreen document already exists.
  try {
    const existingContexts = await (chrome.runtime as any).getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });

    if (existingContexts && existingContexts.length > 0) return;
  } catch {
    // getContexts may not be available in all contexts.
  }

  try {
    await (chrome.offscreen as any).createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "BLOBS"],
      justification: "WebGPU inference for on-device vision model and PII detection",
    });
  } catch {
    // May already exist or not be available.
  }
}

/**
 * Send a screenshot to the offscreen document for PII detection and redaction.
 * Returns the redacted image as a data URL plus the list of detected PII.
 */
export interface ProcessedScreenshot {
  /** Redacted image as a JPEG data URL. */
  redactedDataUrl: string;
  /** List of PII detections with bounding boxes. */
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
  }>;
  /** Number of items redacted. */
  redactedCount: number;
  /** Processing time in ms. */
  processingTimeMs: number;
}

/**
 * Process a screenshot through the offscreen document's privacy pipeline.
 * This is the main entry point for the visual privacy system.
 */
export async function processScreenshot(
  screenshot: CapturedScreenshot,
): Promise<ProcessedScreenshot> {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Offscreen processing timed out after 10s"));
    }, 10000);

    // Listen for the response from the offscreen document.
    const listener = (message: { type: string; result?: ProcessedScreenshot; error?: string }) => {
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
      dataUrl: screenshot.dataUrl,
      width: screenshot.width,
      height: screenshot.height,
    });
  });
}

/**
 * Capture and process in one call — the convenience function used by
 * the agent loop.
 */
export async function captureAndProcess(): Promise<{
  screenshot: CapturedScreenshot;
  processed: ProcessedScreenshot;
} | null> {
  const screenshot = await captureVisibleTab();
  if (!screenshot) return null;

  const processed = await processScreenshot(screenshot);
  return { screenshot, processed };
}
