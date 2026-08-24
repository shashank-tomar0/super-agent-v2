/**
 * VLEE Server Routes
 *
 * API endpoints for the privacy-preserving VLM processing server.
 */

import type { Request, Response } from "express";
import { processVisionRequest, type VLMRequest } from "./vlm";

// ─── Request Validation ─────────────────────────────────────────────────────

interface ProcessRequestBody {
  screenshot?: string;
  domContext?: VLMRequest["domContext"];
  task?: string;
  history?: VLMRequest["history"];
}

function validateProcessRequest(body: ProcessRequestBody): string | null {
  if (!body.screenshot || typeof body.screenshot !== "string") {
    return "Missing or invalid 'screenshot' field (expected base64 string)";
  }
  if (!body.domContext || typeof body.domContext !== "object") {
    return "Missing or invalid 'domContext' field (expected object with elements, text, url, title)";
  }
  if (!Array.isArray(body.domContext.elements)) {
    return "Missing or invalid 'domContext.elements' (expected array)";
  }
  if (typeof body.domContext.text !== "string") {
    return "Missing or invalid 'domContext.text' (expected string)";
  }
  if (typeof body.domContext.url !== "string") {
    return "Missing or invalid 'domContext.url' (expected string)";
  }
  if (typeof body.domContext.title !== "string") {
    return "Missing or invalid 'domContext.title' (expected string)";
  }
  if (!body.task || typeof body.task !== "string") {
    return "Missing or invalid 'task' field (expected string)";
  }
  return null;
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

export async function handleProcessRequest(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const body = req.body as ProcessRequestBody;

    // Validate input.
    const validationError = validateProcessRequest(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // Log request (without sensitive data).
    console.log(`[VLEE] Processing request for task: "${body.task!.slice(0, 80)}..."`);
    console.log(`[VLEE] DOM elements: ${body.domContext!.elements.length}`);
    console.log(`[VLEE] Screenshot size: ${Math.round(body.screenshot!.length / 1024)}KB`);

    // Process through VLM.
    const request: VLMRequest = {
      screenshot: body.screenshot!,
      domContext: body.domContext!,
      task: body.task!,
      history: body.history,
    };

    const response = await processVisionRequest(request);

    const elapsed = Date.now() - startTime;
    console.log(`[VLEE] Processed in ${elapsed}ms — ${response.commands.length} commands, confidence: ${response.confidence.toFixed(2)}`);

    // Log what commands were returned (for debugging).
    for (const cmd of response.commands) {
      console.log(`[VLEE]   → ${cmd.action}: ${cmd.reasoning} (${(cmd.confidence * 100).toFixed(0)}%)`);
    }

    res.json({
      success: true,
      data: response,
      metadata: {
        processingTimeMs: elapsed,
        provider: process.env.VLM_PROVIDER ?? "anthropic",
        model: process.env.VLM_MODEL ?? "claude-sonnet-5",
        commandsReturned: response.commands.length,
        taskComplete: response.taskComplete,
      },
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[VLEE] Error after ${elapsed}ms:`, error);

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      metadata: {
        processingTimeMs: elapsed,
      },
    });
  }
}

export function handleHealthCheck(_req: Request, res: Response): void {
  const provider = process.env.VLM_PROVIDER ?? "anthropic";
  const model = process.env.VLM_MODEL ?? "claude-sonnet-5";

  res.json({
    status: "healthy",
    service: "VLEE Server",
    version: "1.0.0",
    vlm: {
      provider,
      model,
      configured: Boolean(
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.OPENROUTER_API_KEY,
      ),
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
