/**
 * VLM (Vision-Language Model) Processing
 *
 * Processes sanitized screenshots and tokenized DOM context through
 * a vision-language model. The model receives ONLY:
 *   - Redacted images (faces blurred, credentials blacked)
 *   - Tokenized text (real values replaced with <CRED_1> etc.)
 *
 * Returns structured commands that the client-side agent can execute.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VLMRequest {
  /** Redacted screenshot as base64 JPEG. */
  screenshot: string;
  /** Tokenized DOM context. */
  domContext: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
    url: string;
    title: string;
  };
  /** The user's original task. */
  task: string;
  /** Optional conversation history for multi-step tasks. */
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface VLMCommand {
  /** Action type. */
  action: "click" | "type" | "scroll" | "navigate" | "select" | "key" | "wait" | "read_page" | "done";
  /** Parameters for the action. */
  params: Record<string, unknown>;
  /** The VLM's reasoning for this command. */
  reasoning: string;
  /** Confidence score 0-1. */
  confidence: number;
}

export interface VLMResponse {
  /** Commands to execute in sequence. */
  commands: VLMCommand[];
  /** The VLM's overall reasoning about the page state. */
  reasoning: string;
  /** Overall confidence. */
  confidence: number;
  /** Whether the task appears to be complete. */
  taskComplete: boolean;
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const VLM_SYSTEM_PROMPT = `You are VLESS's server-side vision-language model. You receive:
1. A REDACTED screenshot where faces are blurred and credentials are blacked out
2. A TOKENIZED DOM context where sensitive values are replaced with opaque tokens like <CRED_1>, <ID_2>, <KEY_3>

Your job is to understand the page state from the sanitized data and return actionable commands.

IMPORTANT:
- You can see the visual layout but CANNOT identify people or read redacted text
- Tokens like <CRED_1> represent redacted values — reference them by token, not by original value
- Return commands as JSON array
- Each command should target an element by its [id] from the DOM context
- If the task is complete, return action: "done"

Command format:
{
  "action": "click" | "type" | "scroll" | "navigate" | "select" | "key" | "wait" | "read_page" | "done",
  "params": { ... },
  "reasoning": "short explanation",
  "confidence": 0.0-1.0
}

For "click": { "element_id": number, "reason": "string" }
For "type": { "element_id": number, "text": "string", "submit": boolean, "reason": "string" }
For "scroll": { "direction": "up" | "down", "amount": number }
For "navigate": { "url": "string", "reason": "string" }
For "done": { "summary": "what was accomplished" }

Always return a JSON object with "commands" array and "reasoning" string.`;

// ─── VLM Providers ──────────────────────────────────────────────────────────

async function processWithAnthropic(request: VLMRequest): Promise<VLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });

  const userContent: Anthropic.ContentBlockParam[] = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: request.screenshot.replace(/^data:image\/\w+;base64,/, ""),
      },
    },
    {
      type: "text",
      text: `Task: ${request.task}\n\nDOM Context (tokenized):\n${JSON.stringify(request.domContext, null, 2)}\n\nAnalyze this sanitized page state and return commands as JSON.`,
    },
  ];

  const response = await client.messages.create({
    model: process.env.VLM_MODEL ?? "claude-sonnet-5",
    max_tokens: 4096,
    system: VLM_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseVLMResponse(text);
}

async function processWithOpenAI(request: VLMRequest): Promise<VLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: process.env.VLM_MODEL ?? "gpt-4o",
    messages: [
      { role: "system", content: VLM_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: request.screenshot.startsWith("data:")
                ? request.screenshot
                : `data:image/jpeg;base64,${request.screenshot}`,
              detail: "high",
            },
          },
          {
            type: "text",
            text: `Task: ${request.task}\n\nDOM Context (tokenized):\n${JSON.stringify(request.domContext, null, 2)}\n\nAnalyze this sanitized page state and return commands as JSON.`,
          },
        ],
      },
    ],
    max_tokens: 4096,
    response_format: { type: "json_object" },
  });

  const text = response.choices[0]?.message?.content ?? "{}";
  return parseVLMResponse(text);
}

async function processWithOpenRouter(request: VLMRequest): Promise<VLMResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const model = process.env.VLM_MODEL ?? "anthropic/claude-sonnet-5";

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/vless/vless-agent",
      "X-Title": "VLESS Agent Server",
    },
  });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: VLM_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: request.screenshot.startsWith("data:")
                ? request.screenshot
                : `data:image/jpeg;base64,${request.screenshot}`,
            },
          },
          {
            type: "text",
            text: `Task: ${request.task}\n\nDOM Context (tokenized):\n${JSON.stringify(request.domContext, null, 2)}\n\nAnalyze this sanitized page state and return commands as JSON.`,
          },
        ],
      },
    ],
    max_tokens: 4096,
  });

  const text = response.choices[0]?.message?.content ?? "{}";
  return parseVLMResponse(text);
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function parseVLMResponse(text: string): VLMResponse {
  // Try to extract JSON from the response (may be wrapped in markdown).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      commands: [],
      reasoning: text,
      confidence: 0,
      taskComplete: false,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      reasoning: parsed.reasoning ?? text,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      taskComplete: parsed.taskComplete ?? false,
    };
  } catch {
    return {
      commands: [],
      reasoning: text,
      confidence: 0,
      taskComplete: false,
    };
  }
}

// ─── Main Processing Function ───────────────────────────────────────────────

export async function processVisionRequest(request: VLMRequest): Promise<VLMResponse> {
  const provider = process.env.VLM_PROVIDER ?? "anthropic";

  switch (provider) {
    case "anthropic":
      return processWithAnthropic(request);
    case "openai":
      return processWithOpenAI(request);
    case "openrouter":
      return processWithOpenRouter(request);
    default:
      throw new Error(`Unsupported VLM provider: ${provider}`);
  }
}
