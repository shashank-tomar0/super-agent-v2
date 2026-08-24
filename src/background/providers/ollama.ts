/**
 * Ollama Planner
 *
 * Uses Ollama's native /api/chat endpoint instead of the OpenAI-compatible
 * /v1/ wrapper. The native API is more reliable, supports tool calling
 * properly, and doesn't have the 403/405 issues the OpenAI client causes.
 *
 * Ollama native API: POST http://localhost:11434/api/chat
 */

import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  StopReason,
  ToolSpec,
} from "./types";
import { PlannerError, parseArguments } from "./types";

// ─── Ollama API Types ─────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
}

// ─── Message Conversion ────────────────────────────────────────────────────

function toOllamaMessages(
  system: string,
  messages: ConvMessage[],
): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const msg: OllamaMessage = {
        role: "assistant",
        content: message.text || "",
      };
      if (message.toolCalls.length > 0) {
        msg.tool_calls = message.toolCalls.map((call) => ({
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        }));
      }
      out.push(msg);
      continue;
    }

    // Tool results → individual tool messages.
    for (const result of message.results) {
      out.push({
        role: "tool",
        content: result.isError ? `ERROR: ${result.content}` : result.content,
        tool_call_id: result.id,
      });
    }
  }

  return out;
}

function toOllamaTools(tools: ToolSpec[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toStopReason(
  hasToolCalls: boolean,
): StopReason {
  return hasToolCalls ? "tool_use" : "end_turn";
}

// ─── Planner Factory ───────────────────────────────────────────────────────

export function createOllamaPlanner(model: string): Planner {
  const baseUrl = "http://localhost:11434";

  return {
    label: `Ollama (Local) ${model}`,

    async run({
      system,
      messages,
      tools,
      signal,
      onText,
    }: PlannerRequest): Promise<PlannerTurn> {
      const body: OllamaChatRequest = {
        model,
        messages: toOllamaMessages(system, messages),
        tools: toOllamaTools(tools),
        stream: true,
      };

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        throw new PlannerError(
          `Cannot connect to Ollama at ${baseUrl}. Is Ollama running? ` +
            `Run "ollama serve" to start it.`,
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new PlannerError(
          `Ollama returned ${response.status}: ${text || response.statusText}. ` +
            `Make sure model "${model}" is pulled (ollama pull ${model}).`,
        );
      }

      // Parse streaming NDJSON response.
      let text = "";
      const partials = new Map<number, { id: string; name: string; args: string }>();
      let done = false;

      const reader = response.body?.getReader();
      if (!reader) throw new PlannerError("Ollama returned no response body.");

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;

            let parsed: any;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }

            // Check if streaming is done.
            if (parsed.done) {
              done = true;
              break;
            }

            const delta = parsed.message;
            if (!delta) continue;

            // Accumulate text content.
            if (delta.content) {
              text += delta.content;
              onText(delta.content);
            }

            // Accumulate tool calls.
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                const existing = partials.get(index) ?? {
                  id: `call_${index}`,
                  name: "",
                  args: "",
                };
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
                partials.set(index, existing);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const toolCalls = Array.from(partials.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          input: parseArguments(call.args),
        }));

      return {
        text,
        toolCalls,
        stopReason: toStopReason(toolCalls.length > 0),
      };
    },
  };
}
