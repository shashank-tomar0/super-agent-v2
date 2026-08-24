/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment
 * for:
 *   1. PII detection on captured screenshots
 *   2. Canvas-based redaction (blur faces, mask credentials)
 *   3. On-device vision model inference via ONNX Runtime Web
 *
 * Communication: the service worker sends messages here, this document
 * processes them and sends results back via chrome.runtime.sendMessage.
 */

import { detectFaces } from "../background/pii-detector";
import { redactToBlob } from "../background/redaction";

// ─── Type Declarations for Unstable APIs ────────────────────────────────────

// WebGPU is not yet in the standard TypeScript DOM types.
interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}
interface GPUDevice {}
interface NavigatorWithGPU extends Navigator {
  gpu?: {
    requestAdapter(): Promise<GPUAdapter | null>;
  };
}

// ONNX Runtime Web type (minimal).
interface ORTSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
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
}> {
  const startTime = performance.now();

  // Load the screenshot into an ImageBitmap for canvas operations.
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // 1. Face detection (visual PII).
  const faceDetections = await detectFaces(imageBitmap, width, height);

  // 2. Combine with any DOM-based detections (passed separately).
  const allDetections = [...faceDetections];

  // 3. Apply redaction to the image.
  const redactedBlob = await redactToBlob(imageBitmap, allDetections, {
    blurFaces: true,
    maskCredentials: true,
    showLabels: false,
    blurRadius: 20,
  });

  // 4. Convert redacted image to data URL for transmission.
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
  };
}

// ─── Vision Model Inference ─────────────────────────────────────────────────

let visionSession: ORTSession | null = null;
let visionModelLoaded = false;

async function loadVisionModel(): Promise<void> {
  if (visionModelLoaded) return;

  try {
    // Dynamic import to avoid loading ONNX Runtime unless needed.
    const ort = await import(/* webpackIgnore: true */ "onnxruntime-web" as any) as any;

    // Configure for WebGPU with WASM fallback.
    if (typeof ort.env?.wasm !== "undefined") {
      ort.env.wasm.numThreads = navigator.hardwareConcurrency ?? 4;
    }

    // Try WebGPU first.
    const nav = navigator as NavigatorWithGPU;
    if (nav.gpu) {
      try {
        const adapter = await nav.gpu.requestAdapter();
        if (adapter) {
          await adapter.requestDevice();
          visionSession = await ort.InferenceSession.create(
            chrome.runtime.getURL("models/mobilenet-vit.onnx"),
            { executionProviders: ["webgpu"] },
          );
        }
      } catch {
        // WebGPU not available, fall back to WASM.
      }
    }

    // WASM fallback.
    if (!visionSession) {
      visionSession = await ort.InferenceSession.create(
        chrome.runtime.getURL("models/mobilenet-vit.onnx"),
        { executionProviders: ["wasm"] },
      );
    }

    visionModelLoaded = true;
  } catch {
    // Model not available — vision pipeline degrades gracefully to
    // DOM-only perception.
    console.warn("[VLEE] Vision model not available, using DOM-only perception");
  }
}

async function runVisionInference(
  imageBitmap: ImageBitmap,
): Promise<{ embedding?: number[]; available: boolean }> {
  if (!visionModelLoaded) {
    await loadVisionModel();
  }

  if (!visionSession) {
    return { available: false };
  }

  try {
    const canvas = new OffscreenCanvas(224, 224);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(imageBitmap, 0, 0, 224, 224);
    const imageData = ctx.getImageData(0, 0, 224, 224);

    // Normalize to model input format [1, 3, 224, 224].
    const input = new Float32Array(3 * 224 * 224);
    for (let i = 0; i < 224 * 224; i++) {
      input[i] = imageData.data[i * 4] / 255.0;
      input[224 * 224 + i] = imageData.data[i * 4 + 1] / 255.0;
      input[2 * 224 * 224 + i] = imageData.data[i * 4 + 2] / 255.0;
    }

    const ort = await import(/* webpackIgnore: true */ "onnxruntime-web" as any) as any;
    const tensor = new ort.Tensor("float32", input, [1, 3, 224, 224]);

    const inputName = visionSession.inputNames[0] ?? "input";
    const results = await visionSession.run({ [inputName]: tensor });
    const outputName = visionSession.outputNames[0] ?? "output";
    const output = results[outputName];

    return {
      embedding: Array.from(output.data as Float32Array).slice(0, 128),
      available: true,
    };
  } catch {
    return { available: false };
  }
}

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
    if (message.type === "process-screenshot" && message.dataUrl && message.width && message.height) {
      processScreenshot(message.dataUrl, message.width, message.height)
        .then((result) => {
          sendResponse({ type: "screenshot-processed", result });
        })
        .catch((error) => {
          sendResponse({ type: "screenshot-processed", error: error.message });
        });
      return true;
    }

    if (message.type === "process-screenshot-enhanced" && message.dataUrl && message.width && message.height) {
      (async () => {
        const startTime = performance.now();

        const response = await fetch(message.dataUrl!);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);

        const faceDetections = await detectFaces(imageBitmap, message.width!, message.height!);
        const vision = await runVisionInference(imageBitmap);

        const redactedBlob = await redactToBlob(imageBitmap, faceDetections);

        const reader = new FileReader();
        const redactedDataUrl = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(redactedBlob);
        });

        imageBitmap.close();

        sendResponse({
          type: "screenshot-processed",
          result: {
            redactedDataUrl,
            detections: faceDetections.map((d) => ({
              kind: d.kind,
              box: d.box,
              confidence: d.confidence,
              label: d.label,
            })),
            redactedCount: faceDetections.length,
            processingTimeMs: performance.now() - startTime,
            visionEmbedding: vision.embedding,
            visionAvailable: vision.available,
          },
        });
      })();
      return true;
    }

    if (message.type === "load-vision-model") {
      loadVisionModel().then(() => sendResponse({ loaded: visionModelLoaded }));
      return true;
    }

    return false;
  },
);

console.log("[VLEE] Offscreen document initialized");
