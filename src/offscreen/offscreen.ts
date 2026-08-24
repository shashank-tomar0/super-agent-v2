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
 * Communication: the service worker sends messages here, this document
 * processes them and sends results back via chrome.runtime.sendMessage.
 */

import { detectFaces } from "../background/pii-detector";
import { redactToBlob } from "../background/redaction";

// ─── Transformers.js Integration ────────────────────────────────────────────

// We use dynamic imports so the main bundle doesn't include Transformers.js.
// The library is ~600KB and loads models from Hugging Face on first use.
let imageClassifier: any = null;
let objectDetector: any = null;
let modelsLoaded = false;

// ImageNet class labels for MobileNet (top-5 subset relevant to screen content).
const SCREEN_RELEVANT_LABELS = new Set([
  "monitor", "computer", "laptop", "screen", "web site", "webpage",
  "notebook", "desktop", "keyboard", "mouse", "printer", "scanner",
  "cell phone", "mobile phone", "telephone", "dial telephone",
  "envelope", "newspaper", "book", "notebook", "menu",
  "wallet", "purse", "handbag", "backpack",  // items with PII
  "passport", "identity card",  // PII documents
  "barber shop", "beauty salon",  // faces likely
  "suit", "dress", "sunglasses",  // personal appearance
]);

async function loadVisionModels(): Promise<void> {
  if (modelsLoaded) return;

  try {
    // Dynamic import — Transformers.js handles ONNX Runtime internally.
    const { pipeline, env } = await import("@huggingface/transformers");

    // Allow remote model downloads.
    env.allowLocalModels = false;

    // Load image classification model (MobileNet V3 Small, ~6MB).
    // This runs entirely in the browser via ONNX Runtime Web + WASM/WebGPU.
    imageClassifier = await pipeline(
      "image-classification",
      "onnx-community/mobilenet-v3-small-300-cls-int8",
      { device: "wasm" },
    );

    // Load object detection model (YOLOv8 nano, ~12MB) for UI element detection.
    try {
      objectDetector = await pipeline(
        "object-detection",
        "onnx-community/yolov8n-int8",
        { device: "wasm" },
      );
    } catch {
      // YOLO is heavier — optional. Classification alone is sufficient.
      console.warn("[VLEE] Object detection model not loaded, using classification only");
    }

    modelsLoaded = true;
    console.log("[VLEE] Vision models loaded successfully");
  } catch (err) {
    console.warn("[VLEE] Failed to load vision models:", err);
    // Graceful degradation — DOM-only perception still works.
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
  /** Image classification results. */
  classifications: ScreenClassification[];
  /** Object detection results (if model loaded). */
  objects: ObjectDetection[];
  /** Whether any screen-relevant label was detected. */
  hasScreenContent: boolean;
  /** Whether any PII-related objects were detected. */
  hasPIIObjects: boolean;
  /** Inference time in ms. */
  inferenceTimeMs: number;
  /** Whether vision models are available. */
  modelsAvailable: boolean;
}

async function runVisionInference(
  imageBitmap: ImageBitmap,
): Promise<VisionResult> {
  const startTime = performance.now();

  if (!modelsLoaded) {
    await loadVisionModels();
  }

  if (!imageClassifier) {
    return {
      classifications: [],
      objects: [],
      hasScreenContent: false,
      hasPIIObjects: false,
      inferenceTimeMs: 0,
      modelsAvailable: false,
    };
  }

  try {
    // Convert ImageBitmap to a format Transformers.js accepts (HTMLCanvasElement or Blob).
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(imageBitmap, 0, 0);

    // Transformers.js can accept canvas elements.
    const canvasForModel = document.createElement("canvas");
    canvasForModel.width = imageBitmap.width;
    canvasForModel.height = imageBitmap.height;
    const modelCtx = canvasForModel.getContext("2d")!;
    modelCtx.drawImage(imageBitmap, 0, 0);

    // Run image classification.
    const classifications: ScreenClassification[] = await imageClassifier(
      canvasForModel,
      { topk: 10 },
    );

    // Check for screen-relevant and PII-related labels.
    const hasScreenContent = classifications.some((c: ScreenClassification) =>
      SCREEN_RELEVANT_LABELS.has(c.label.toLowerCase()),
    );
    const hasPIIObjects = classifications.some((c: ScreenClassification) =>
      ["passport", "identity card", "wallet", "purse", "handbag"].includes(
        c.label.toLowerCase(),
      ),
    );

    // Run object detection if available.
    let objects: ObjectDetection[] = [];
    if (objectDetector) {
      try {
        objects = await objectDetector(canvasForModel, {
          threshold: 0.3,
          percentage: true,
        });
      } catch {
        // Object detection is optional.
      }
    }

    return {
      classifications,
      objects,
      hasScreenContent,
      hasPIIObjects,
      inferenceTimeMs: performance.now() - startTime,
      modelsAvailable: true,
    };
  } catch (err) {
    console.warn("[VLEE] Vision inference failed:", err);
    return {
      classifications: [],
      objects: [],
      hasScreenContent: false,
      hasPIIObjects: false,
      inferenceTimeMs: performance.now() - startTime,
      modelsAvailable: false,
    };
  }
}

// ─── Screenshot Processing ──────────────────────────────────────────────────

async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
): Promise<{
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  vision?: VisionResult;
}> {
  const startTime = performance.now();

  // Load the screenshot into an ImageBitmap for canvas operations.
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // 1. Face detection (visual PII) — always runs.
  const faceDetections = await detectFaces(imageBitmap, width, height);

  // 2. Run vision model inference — runs asynchronously.
  const vision = await runVisionInference(imageBitmap);

  // 3. Combine detections.
  const allDetections = [...faceDetections];

  // Add object detections as PII signals if relevant.
  if (vision.objects) {
    for (const obj of vision.objects) {
      if (
        ["person", "face", "passport", "id card", "credit card"].some((k) =>
          obj.label.toLowerCase().includes(k),
        )
      ) {
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

  // 4. Apply redaction to the image.
  const redactedBlob = await redactToBlob(imageBitmap, allDetections, {
    blurFaces: true,
    maskCredentials: true,
    showLabels: false,
    blurRadius: 20,
  });

  // 5. Convert redacted image to data URL for transmission.
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

// Start loading models as soon as the offscreen document loads.
loadVisionModels();

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      dataUrl?: string;
      width?: number;
      height?: number;
    },
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
          sendResponse({ type: "screenshot-processed", result });
        })
        .catch((error) => {
          sendResponse({ type: "screenshot-processed", error: error.message });
        });
      return true; // async response
    }

    if (message.type === "load-vision-model") {
      loadVisionModels().then(() => sendResponse({ loaded: modelsLoaded }));
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
