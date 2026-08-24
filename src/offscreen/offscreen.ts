/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment for:
 *   1. DOM-guided screenshot redaction (blurring/masking PII regions)
 *   2. Face detection (Chrome FaceDetector API → skin-color fallback)
 *   3. Canvas-based redaction engine
 *
 * The key insight: instead of trying to detect PII from the image (which
 * requires heavy ML models), we use the DOM to KNOW where sensitive data
 * is on screen, then redact those exact pixel regions.
 *
 * Communication: service worker sends messages here via sendMessage.
 * Results are sent back via chrome.runtime.sendMessage (NOT sendResponse).
 */

import type { DetectedPII } from "../background/pii-detector";

// ─── Chrome FaceDetector API (Chrome 100+, Shape Detection API) ─────────────

declare class FaceDetector {
  constructor(options?: { fastMode?: boolean; maxDetectedFaces?: number });
  detect(image: ImageBitmap | HTMLCanvasElement): Promise<Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
  }>>;
}

let chromeFaceDetector: FaceDetector | null = null;

async function getChromeFaceDetector(): Promise<FaceDetector | null> {
  if (chromeFaceDetector) return chromeFaceDetector;
  try {
    if (typeof FaceDetector !== "undefined") {
      chromeFaceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
      return chromeFaceDetector;
    }
  } catch {
    // Not available in this context.
  }
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SensitiveRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  label: string;
}

// ─── Skin-Color Face Detection ──────────────────────────────────────────────
//
// A simple but effective heuristic: scan the image for clusters of skin-colored
// pixels. Not as accurate as a proper face detector, but works in any context
// without ML model dependencies. Good enough for the privacy pipeline.

/** Check if an RGB pixel is likely skin-colored (works across skin tones). */
function isSkinColor(r: number, g: number, b: number): boolean {
  // Combined rule using multiple color spaces for robustness.
  // Works across diverse skin tones by checking multiple ranges.

  // Rule 1: RGB heuristic (works for most skin tones).
  const rgbRule =
    r > 95 && g > 40 && b > 20 &&
    r > g && r > b &&
    Math.abs(r - g) > 15 &&
    r - b > 15;

  // Rule 2: Normalized RGB (handles lighting variation).
  const sum = r + g + b;
  if (sum === 0) return false;
  const nr = r / sum;
  const ng = g / sum;
  const nb = b / sum;
  const normalizedRule =
    nr > 0.28 && nr < 0.55 &&
    ng > 0.18 && ng < 0.42 &&
    nb > 0.08 && nb < 0.32 &&
    nr > nb;

  return rgbRule || normalizedRule;
}

/**
 * Detect face-like regions using skin-color clustering.
 * Returns bounding boxes of likely face regions.
 */
function detectFacesBySkinColor(
  imageData: ImageData,
  canvasWidth: number,
  canvasHeight: number,
): Array<{ x: number; y: number; width: number; height: number; confidence: number }> {
  const { data } = imageData;
  const blockSize = 12; // Sample every 12 pixels for speed.
  const minClusterSize = 40; // Minimum skin pixels to count as a face region.

  // Build a skin-color mask.
  const mask = new Uint8Array(canvasWidth * canvasHeight);
  for (let i = 0; i < mask.length; i++) {
    const px = i * 4;
    mask[i] = isSkinColor(data[px], data[px + 1], data[px + 2]) ? 1 : 0;
  }

  // Find connected skin regions using simple grid-based clustering.
  const regions: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];
  const visited = new Uint8Array(mask.length);

  for (let by = 0; by < canvasHeight; by += blockSize) {
    for (let bx = 0; bx < canvasWidth; bx += blockSize) {
      const idx = by * canvasWidth + bx;
      if (!mask[idx] || visited[idx]) continue;

      // BFS to find connected skin region.
      let minX = bx, maxX = bx, minY = by, maxY = by;
      let count = 0;
      const queue = [idx];

      while (queue.length > 0 && count < 2000) {
        const ci = queue.pop()!;
        if (visited[ci]) continue;
        visited[ci] = 1;

        const cx = ci % canvasWidth;
        const cy = Math.floor(ci / canvasWidth);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        count++;

        // Check neighbors (4-connected).
        for (const [dx, dy] of [[0, -blockSize], [0, blockSize], [-blockSize, 0], [blockSize, 0]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= canvasWidth || ny < 0 || ny >= canvasHeight) continue;
          const ni = ny * canvasWidth + nx;
          if (mask[ni] && !visited[ni]) queue.push(ni);
        }
      }

      if (count >= minClusterSize) {
        const regionW = maxX - minX;
        const regionH = maxY - minY;
        const aspectRatio = regionW / regionH;

        // Faces are roughly 1:1 to 1:1.5 aspect ratio.
        if (aspectRatio > 0.5 && aspectRatio < 2.0 && regionW > 20 && regionH > 20) {
          regions.push({
            x: minX,
            y: minY,
            width: regionW,
            height: regionH,
            confidence: Math.min(0.9, count / 200),
          });
        }
      }
    }
  }

  // Merge overlapping regions.
  return mergeOverlappingRegions(regions);
}

function mergeOverlappingRegions(
  regions: Array<{ x: number; y: number; width: number; height: number; confidence: number }>,
): Array<{ x: number; y: number; width: number; height: number; confidence: number }> {
  if (regions.length <= 1) return regions;

  const merged: typeof regions = [];
  const used = new Set<number>();

  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    let best = regions[i];
    used.add(i);

    for (let j = i + 1; j < regions.length; j++) {
      if (used.has(j)) continue;
      if (regionsOverlap(best, regions[j])) {
        best = mergeRects(best, regions[j]);
        used.add(j);
      }
    }

    merged.push(best);
  }

  return merged;
}

function regionsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

function mergeRects(
  a: { x: number; y: number; width: number; height: number; confidence: number },
  b: { x: number; y: number; width: number; height: number; confidence: number },
) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    confidence: Math.max(a.confidence, b.confidence),
  };
}

// ─── Screenshot Processing ──────────────────────────────────────────────────

async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
  sensitiveRegions: SensitiveRegion[] = [],
  dpr: number = 1,
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
  console.log(`[VLESS Offscreen] Processing ${width}x${height} screenshot, DPR=${dpr}, ${sensitiveRegions.length} DOM regions + face detection`);

  // Load the screenshot into an ImageBitmap.
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // Create canvas for redaction.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageBitmap, 0, 0);
  imageBitmap.close();

  const allDetections: DetectedPII[] = [];

  // Scale factor: DOM coordinates are CSS pixels, screenshot is device pixels.
  const scale = dpr;

  // 1. DOM-guided redaction — redact known sensitive regions.
  for (const region of sensitiveRegions) {
    // Scale CSS coordinates to device pixels + expand by 4px padding.
    const padding = 4 * scale;
    const rx = Math.max(0, Math.round(region.x * scale - padding));
    const ry = Math.max(0, Math.round(region.y * scale - padding));
    const rw = Math.min(width - rx, Math.round(region.width * scale + padding * 2));
    const rh = Math.min(height - ry, Math.round(region.height * scale + padding * 2));

    if (rw <= 0 || rh <= 0) continue;

    // Use blur for faces/labels/input fields, solid black mask for credentials/IDs.
    const useBlur = region.kind === "credential_label" || region.kind === "input_field";

    if (useBlur) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.filter = "blur(12px)";
      ctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.restore();
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(rx, ry, rw, rh);
      // Add a small label showing what was redacted.
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.font = `bold ${Math.max(9, Math.round(Math.min(rh * 0.3, 12)))}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const label = region.kind === "input_field" ? "🔒 Input" : `🔒 ${region.label}`;
      ctx.fillText(label, rx + rw / 2, ry + rh / 2);
    }

    allDetections.push({
      kind: (region.kind === "credential_label" || region.kind === "input_field") ? "credential" : region.kind as any,
      box: { x: region.x, y: region.y, width: region.width, height: region.height },
      confidence: 0.95,
      label: region.label,
    });
  }

  // 2. Face detection — try Chrome FaceDetector API first, fallback to skin-color.
  let faceBoxes: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];

  const chromeDetector = await getChromeFaceDetector();
  if (chromeDetector) {
    try {
      const bitmap = await createImageBitmap(await (async () => {
        const c = new OffscreenCanvas(width, height);
        c.getContext("2d")!.drawImage(canvas, 0, 0);
        return c.convertToBlob();
      })());
      const faces = await chromeDetector.detect(bitmap);
      bitmap.close();
      faceBoxes = faces.map((f) => ({
        x: f.boundingBox.x,
        y: f.boundingBox.y,
        width: f.boundingBox.width,
        height: f.boundingBox.height,
        confidence: 0.95,
      }));
      console.log(`[VLESS Offscreen] Chrome FaceDetector found ${faceBoxes.length} faces`);
    } catch {
      // Fall through to skin-color.
    }
  }

  if (faceBoxes.length === 0) {
    // Fallback: skin-color heuristic.
    const imageData = ctx.getImageData(0, 0, width, height);
    faceBoxes = detectFacesBySkinColor(imageData, width, height);
    console.log(`[VLESS Offscreen] Skin-color heuristic found ${faceBoxes.length} faces`);
  }

  for (const face of faceBoxes) {
    // Expand face box by 20% for better coverage.
    const expandX = face.width * 0.1;
    const expandY = face.height * 0.1;
    const rx = Math.max(0, Math.round(face.x - expandX));
    const ry = Math.max(0, Math.round(face.y - expandY));
    const rw = Math.min(width - rx, Math.round(face.width + expandX * 2));
    const rh = Math.min(height - ry, Math.round(face.height + expandY * 2));

    if (rw > 10 && rh > 10) {
      // Apply Gaussian blur to face region.
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.filter = "blur(20px)";
      ctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.restore();

      allDetections.push({
        kind: "face",
        box: {
          x: face.x / width,
          y: face.y / height,
          width: face.width / width,
          height: face.height / height,
        },
        confidence: face.confidence,
        label: "Face detected",
      });
    }
  }

  // 3. Convert to Blob.
  const redactedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });

  const reader = new FileReader();
  const redactedDataUrl = await new Promise<string>((resolve) => {
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(redactedBlob);
  });

  console.log(`[VLESS Offscreen] Redacted ${allDetections.length} items (${faceBoxes.length} faces, ${sensitiveRegions.length} DOM regions) in ${(performance.now() - startTime).toFixed(0)}ms`);

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

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      dataUrl?: string;
      width?: number;
      height?: number;
      sensitiveRegions?: SensitiveRegion[];
      dpr?: number;
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
      processScreenshot(
        message.dataUrl,
        message.width,
        message.height,
        message.sensitiveRegions ?? [],
        message.dpr ?? 1,
      )
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
      return true;
    }

    return false;
  },
);

console.log("[VLESS] Offscreen document initialized — DOM-guided privacy pipeline ready.");
