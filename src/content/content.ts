/**
 * Content Script
 *
 * The page-side half of the VLEE agent. It owns the only code that reads
 * or touches the DOM; the service worker drives it entirely through messages.
 *
 * Two perception channels:
 *   1. DOM perception — flattens interactive elements into a numbered list
 *   2. Visual perception — captures screenshot for privacy pipeline
 */

import type { ContentRequest, ActionResult } from "../shared/types";
import { act } from "./act";
import { snapshot } from "./perceive";
import { captureVisibleTab, processScreenshot } from "./screenshot";

chrome.runtime.onMessage.addListener(
  (request: ContentRequest, _sender, sendResponse: (r: unknown) => void) => {
    switch (request.kind) {
      case "ping":
        sendResponse({ ok: true, detail: "alive" } satisfies ActionResult);
        return false;

      case "snapshot":
        sendResponse({ ok: true, detail: "snapshot", snapshot: snapshot() } satisfies ActionResult);
        return false;

      case "act":
        // Async work requires keeping the message channel open (return true).
        act(request.action).then(sendResponse);
        return true;

      case "capture-screenshot":
        // Capture and process the visible tab through the privacy pipeline.
        (async () => {
          try {
            const screenshot = await captureVisibleTab();
            if (!screenshot) {
              sendResponse({
                ok: false,
                detail: "Could not capture screenshot (restricted page or permission denied)",
              } satisfies ActionResult);
              return;
            }

            const processed = await processScreenshot(screenshot);
            sendResponse({
              ok: true,
              detail: `Screenshot captured and processed: ${processed.redactedCount} PII items redacted in ${processed.processingTimeMs.toFixed(0)}ms`,
              screenshot: {
                redactedDataUrl: processed.redactedDataUrl,
                detections: processed.detections,
                redactedCount: processed.redactedCount,
                processingTimeMs: processed.processingTimeMs,
              },
            } satisfies ActionResult);
          } catch (error) {
            sendResponse({
              ok: false,
              detail: `Screenshot processing failed: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies ActionResult);
          }
        })();
        return true;

      case "capture-and-act":
        // Combined: capture screenshot, then perform an action.
        // Used for the full privacy pipeline flow.
        (async () => {
          try {
            // Capture screenshot first.
            const screenshot = await captureVisibleTab();
            let processedScreenshot = null;

            if (screenshot) {
              processedScreenshot = await processScreenshot(screenshot);
            }

            // Then perform the action.
            const actionResult = await act(request.action);

            sendResponse({
              ok: actionResult.ok,
              detail: actionResult.detail,
              screenshot: processedScreenshot
                ? {
                    redactedDataUrl: processedScreenshot.redactedDataUrl,
                    detections: processedScreenshot.detections,
                    redactedCount: processedScreenshot.redactedCount,
                    processingTimeMs: processedScreenshot.processingTimeMs,
                  }
                : undefined,
              snapshot: actionResult.snapshot,
            } satisfies ActionResult);
          } catch (error) {
            sendResponse({
              ok: false,
              detail: `Combined action failed: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies ActionResult);
          }
        })();
        return true;

      default:
        sendResponse({ ok: false, detail: "Unknown request" } satisfies ActionResult);
        return false;
    }
  },
);
