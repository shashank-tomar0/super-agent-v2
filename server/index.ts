/**
 * VLESS Server
 *
 * Privacy-preserving VLM processing server for the VLESS browser agent.
 * Receives ONLY sanitized data:
 *   - Redacted screenshots (faces blurred, credentials blacked)
 *   - Tokenized DOM context (PII replaced with opaque tokens)
 *
 * The server processes sanitized data and returns actionable commands.
 * It can never resolve tokens back to real values — the vault lives
 * only on the client.
 *
 * Supported VLM backends:
 *   - Anthropic Claude (native vision)
 *   - OpenAI GPT-4o (vision)
 *   - OpenRouter (proxied VLMs)
 *   - Self-hosted VLMs (Qwen2-VL, LLaVA, etc.)
 */

import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { processVisionRequest, type VLMResponse } from "./vlm";
import { handleProcessRequest, handleHealthCheck } from "./routes";

config();

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({
  origin: [
    "chrome-extension://*",
    "moz-extension://*",
    "http://localhost:*",
  ],
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/process
 *
 * Main endpoint: receives sanitized screenshot + DOM context,
 * returns actionable commands from the VLM.
 *
 * Body:
 *   - screenshot: base64-encoded redacted screenshot (JPEG)
 *   - domContext: tokenized DOM snapshot (elements + text)
 *   - task: the user's original task description
 *   - history: optional conversation history for multi-step tasks
 *
 * Response:
 *   - commands: array of UI actions (click, type, scroll, navigate)
 *   - reasoning: the VLM's explanation of what it sees and plans
 *   - confidence: 0-1 score for the VLM's confidence
 */
app.post("/api/process", handleProcessRequest);

/**
 * GET /api/health
 *
 * Health check endpoint. Returns server status and VLM availability.
 */
app.get("/api/health", handleHealthCheck);

/**
 * GET /api/models
 *
 * Lists available VLM models on this server.
 */
app.get("/api/models", (_req, res) => {
  const provider = process.env.VLM_PROVIDER ?? "anthropic";
  const model = process.env.VLM_MODEL ?? "claude-sonnet-5";

  res.json({
    provider,
    model,
    capabilities: [
      "vision",
      "tool_use",
      "reasoning",
    ],
    maxImageSize: "50MB",
    supportedFormats: ["image/jpeg", "image/png", "image/webp"],
  });
});

// ─── Error Handling ─────────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[VLESS Server] Error:", err.message);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[VLESS Server] Running on http://localhost:${PORT}`);
  console.log(`[VLESS Server] VLM Provider: ${process.env.VLM_PROVIDER ?? "anthropic"}`);
  console.log(`[VLESS Server] VLM Model: ${process.env.VLM_MODEL ?? "claude-sonnet-5"}`);
});
