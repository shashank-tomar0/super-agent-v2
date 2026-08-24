/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment for:
 *   1. PII detection on captured screenshots
 *   2. Canvas-based redaction (blur faces, mask credentials)
 *   3. On-device vision model inference via Transformers.js
 *
 * Transformers.js downloads models from Hugging Face at runtime — no need
 * to bundle large ONNX files in the extension package.
 *
 * Communication: the service worker sends messages here via sendMessage.
 * This document processes them and sends results BACK via sendMessage
 * (NOT sendResponse — sendResponse replies to the caller's Promise but
 * does not trigger onMessage listeners, which is what the SW uses).
 */

import { detectFaces } from "../background/pii-detector";
import { redactToBlob } from "../background/redaction";

// ─── Transformers.js Integration ────────────────────────────────────────────

let imageClassifier: any = null;
let objectDetector: any = null;
let modelsLoaded = false;

const SCREEN_RELEVANT_LABELS = new Set([
  "monitor", "computer", "laptop", "screen", "web site", "webpage",
  "notebook", "desktop", "keyboard", "mouse", "printer", "scanner",
  "cell phone", "mobile phone", "telephone", "dial telephone",
  "envelope", "newspaper", "book", "notebook", "menu",
  "wallet", "purse", "handbag", "backpack",
  "passport", "identity card",
  "barber shop", "beauty salon",
  "suit", "dress", "sunglasses",
]);

async function loadVisionModels(): Promise<void> {
  if (modelsLoaded) return;

  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;

    imageClassifier = await pipeline(
      "image-classification",
      "onnx-community/mobilenet-v3-small-300-cls-int8",
      { device: "wasm" },
    );

    try {
      objectDetector = await pipeline(
        "object-detection",
        "onnx-community/yolov8n-int8",
        { device: "wasm" },
      );
    } catch {
      console.warn("[VLEE] Object detection model not loaded, using classification only");
    }

    modelsLoaded = true;
    console.log("[VLEE] Vision models loaded successfully");
  } catch (err) {
    console.warn("[VLEE] Failed to load vision models:", err);
  }
}

// ─── Screen Understanding ───────────────────────────────────────────────────

export interface ScreenClassification {
  label: string;
  score: number;
}

export interface ObjectDetection {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

export interface VisionResult {
  classifications: ScreenClassification[];
  objects: ObjectDetection[];
  hasScreenContent: boolean;
  hasPIIObjects: boolean;
  inferenceTimeMs: number;
  modelsAvailable: boolean;
}

async function runVisionInference(imageBitmap: ImageBitmap): Promise<VisionResult> {
  const startTime = performance.now();

  if (!modelsLoaded) await loadVisionModels();

  if (!imageClassifier) {
    return {
      classifications: [], objects: [], hasScreenContent: false,
      hasPIIObjects: false, inferenceTimeMs: 0, modelsAvailable: false,
    };
  }

  try {
    const canvasForModel = document.createElement("canvas");
    canvasForModel.width = imageBitmap.width;
    canvasForModel.height = imageBitmap.height;
    const modelCtx = canvasForModel.getContext("2d")!;
    modelCtx.drawImage(imageBitmap, 0, 0);

    const classifications: ScreenClassification[] = await imageClassifier(canvasForModel, { topk: 10 });

    const hasScreenContent = classifications.some((c: ScreenClassification) =>
      SCREEN_RELEVANT_LABELS.has(c.label.toLowerCase()),
    );
    const hasPIIObjects = classifications.some((c: ScreenClassification) =>
      ["passport", "identity card", "wallet", "purse", "handbag"].includes(c.label.toLowerCase()),
    );

    let objects: ObjectDetection[] = [];
    if (objectDetector) {
      try {
        objects = await objectDetector(canvasForModel, { threshold: 0.3, percentage: true });
      } catch { /* optional */ }
    }

    return {
      classifications, objects, hasScreenContent, hasPIIObjects,
      inferenceTimeMs: performance.now() - startTime, modelsAvailable: true,
    };
  } catch (err) {
    console.warn("[VLEE] Vision inference failed:", err);
    return {
      classifications: [], objects: [], hasScreenContent: false,
      hasPIIObjects: false, inferenceTimeMs: performance.now() - startTime,
      modelsAvailable: false,
    };
  }
}

// ─── Screenshot Processing ──────────────────────────────────────────────────

async function processScreenshot(dataUrl: string, width: number, height: number) {
  const startTime = performance.now();

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  const faceDetections = await detectFaces(imageBitmap, width, height);
  const vision = await runVisionInference(imageBitmap);

  const allDetections = [...faceDetections];

  if (vision.objects) {
    for (const obj of vision.objects) {
      if (["person", "face", "passport", "id card", "credit card"].some((k) =>
        obj.label.toLowerCase().includes(k),
      )) {
        allDetections.push({
          kind: "face",
          box: {
            x: Math.round(obj.box.xmin * width),
            y: Math.round(obj.box.ymin * height),
            width: Math.round((obj.box.xmax - obj.box.xmin) * width),
            height: Math.round((obj.box.ymax - obj.box.ymin) * height),
          },
          confidence: obj.score,
          label: `Object: ${obj.label}`,
        });
      }
    }
  }

  const redactedBlob = await redactToBlob(imageBitmap, allDetections, {
    blurFaces: true,
    maskCredentials: true,
    showLabels: false,
    blurRadius: 20,
  });

  const reader = new FileReader();
  const redactedDataUrl = await new Promise<string>((resolve) => {
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(redactedBlob);
  });

  imageBitmap.close();

  return {
    redactedDataUrl,
    detections: allDetections.map((d) => ({
      kind: d.kind,
      box: d.box,
      confidence: d.confidence,
      label: d.label,
    })),
    redactedCount: allDetections.length,
    processingTimeMs: performance.now() - startTime,
    vision,
  };
}

// ─── Preload Models on Init ─────────────────────────────────────────────────

loadVisionModels();

// ─── Message Handler ────────────────────────────────────────────────────────
//
// CRITICAL: We use chrome.runtime.sendMessage to send results back to the
// service worker, NOT sendResponse. Here's why:
//
// - sendResponse() replies to the original sendMessage() call's Promise.
//   The service worker's onMessage listener does NOT see it.
// - chrome.runtime.sendMessage() sends a NEW message that triggers
//   onMessage listeners, which is how the service worker receives results.
//

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; dataUrl?: string; width?: number; height?: number },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ) => {
    if (
      message.type === "process-screenshot" &&
      message.dataUrl &&
      message.width &&
      message.height
    ) {
      processScreenshot(message.dataUrl, message.width, message.height)
        .then((result) => {
          // Send result back via sendMessage, NOT sendResponse.
          chrome.runtime.sendMessage({
            type: "screenshot-processed",
            result,
          });
          sendResponse({ received: true });
        })
        .catch((error) => {
          chrome.runtime.sendMessage({
            type: "screenshot-processed",
            error: error.message,
          });
          sendResponse({ received: true, error: error.message });
        });
      return true; // keep channel open for sendResponse ack
    }

    if (message.type === "load-vision-model") {
      loadVisionModels().then(() => {
        chrome.runtime.sendMessage({
          type: "vision-model-loaded",
          loaded: modelsLoaded,
        });
        sendResponse({ received: true });
      });
      return true;
    }

    if (message.type === "vision-status") {
      sendResponse({
        modelsLoaded,
        hasClassifier: !!imageClassifier,
        hasDetector: !!objectDetector,
      });
      return false;
    }

    return false;
  },
);

console.log("[VLEE] Offscreen document initialized — loading vision models...");
