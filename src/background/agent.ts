/**
 * Agent Loop
 *
 * The core perceive → plan → act → verify loop, now with the full privacy
 * pipeline integrated. Every piece of data that might cross a network
 * boundary goes through PII detection and redaction first.
 *
 * Privacy flow:
 *   1. DOM perception → PII detection → snapshot tokenization
 *   2. Screenshot capture → face detection → canvas redaction
 *   3. Only sanitized data reaches the LLM/VLM
 *   4. Token resolution happens at the last moment before action execution
 */

import type {
  AgentEvent,
  PageSnapshot,
  Settings,
  TranscriptEntry,
} from "../shared/types";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { detectInjection, gate } from "./safety";
import { detectAllPII } from "./pii-detector";
import { redactSnapshot } from "./redaction";
import { tokenizer } from "./tokenizer";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";

let counter = 0;
const nextId = () => `e${++counter}`;

// ─── Privacy-Aware Snapshot Rendering ───────────────────────────────────────

/**
 * Renders a snapshot for the LLM. If the snapshot has been tokenized
 * (sensitive values replaced with <CRED_1> etc.), the model sees tokens
 * instead of real values.
 */
function renderSnapshot(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`[${el.id}] ${el.role}`];
    if (el.name) parts.push(JSON.stringify(el.name));
    if (el.value) parts.push(`= ${JSON.stringify(el.value)}`);
    const attrs = el.attrs
      ? Object.entries(el.attrs)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    if (attrs) parts.push(`(${attrs})`);
    return parts.join(" ");
  });

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Scroll: ${snapshot.scroll.y} of ${snapshot.scroll.maxY}`,
    "",
    `Elements${snapshot.truncated ? " (list truncated — scroll for more)" : ""}:`,
    ...lines,
    "",
    "Page text:",
    snapshot.text,
  ].join("\n");
}

/**
 * Apply the full privacy pipeline to a snapshot before it reaches the LLM.
 * Returns a sanitized snapshot and the list of detected PII.
 */
function sanitizeSnapshot(snapshot: PageSnapshot): {
  sanitized: PageSnapshot;
  piiCount: number;
} {
  // 1. Detect PII in the DOM snapshot.
  const detections = detectAllPII(snapshot);

  // 2. Tokenize sensitive values in the snapshot.
  const tokenized = tokenizer.tokenizeSnapshot(snapshot);

  // 3. Redact sensitive values (replace with [REDACTED]).
  const { elements, text, redactedCount } = redactSnapshot(
    {
      elements: tokenized.elements,
      text: tokenized.text,
    },
    detections,
  );

  return {
    sanitized: {
      ...snapshot,
      elements,
      text,
    },
    piiCount: redactedCount + tokenized.tokenCount,
  };
}

// ─── Agent Dependencies ─────────────────────────────────────────────────────

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  /** Resolves true when the user approves a gated action. */
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  signal: AbortSignal;
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

/**
 * Runs one task to completion: perceive, sanitize, plan, act, verify,
 * repeat, until the model stops calling tools or a limit is reached.
 *
 * The privacy pipeline is applied at every perception step:
 *   - DOM snapshots are tokenized before rendering for the LLM
 *   - Screenshot data is redacted before any network transmission
 *   - Token resolution happens only at action execution time
 */
export async function runTask(
  task: string,
  startTabId: number,
  deps: AgentDeps,
): Promise<void> {
  const { settings, emit, askConfirm, signal } = deps;

  const planner = createPlanner(settings);

  let controller = new TabController(startTabId);
  const tab = await chrome.tabs.get(startTabId);

  if (isRestricted(tab.url)) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "error",
        text: `I can't work on ${tab.url} — Chrome blocks extensions on its own pages. Open a normal website and try again.`,
      },
    });
    return;
  }

  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Using ${planner.label}. Privacy pipeline: active.`,
    },
  });

  await controller.waitForLoad();
  let snapshot = await controller.snapshot();

  // Apply privacy pipeline to initial snapshot.
  let piiTotal = 0;
  if (snapshot) {
    const { sanitized, piiCount } = sanitizeSnapshot(snapshot);
    snapshot = sanitized;
    piiTotal += piiCount;
    if (piiCount > 0) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `Privacy: detected and redacted ${piiCount} sensitive item(s) from page context.`,
        },
      });
    }
  }

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        taskPrompt(task, tab.url ?? "", tab.title ?? "") +
        (snapshot ? `\n\n--- Current page ---\n${renderSnapshot(snapshot)}` : ""),
    },
  ];

  if (snapshot) warnIfInjected(snapshot, emit);

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) return;

    // Stream so the user sees reasoning as it arrives rather than staring at a
    // spinner for the length of a long turn.
    const entryId = nextId();
    let opened = false;

    const onText = (delta: string): void => {
      if (!opened) {
        opened = true;
        emit({ kind: "entry", entry: { id: entryId, role: "assistant", text: delta } });
      } else {
        emit({ kind: "patch", id: entryId, text: delta });
      }
    };

    let turn;
    try {
      turn = await planner.run({
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        signal,
        onText,
      });
    } catch (error) {
      if (signal.aborted) return;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

    if (turn.stopReason === "refusal") {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `The model declined this request (${turn.refusal ?? "unspecified"}).`,
        },
      });
      return;
    }

    // No tools left to call — the model has given its final answer.
    if (turn.toolCalls.length === 0) return;

    const results: ToolOutcome[] = [];

    for (const call of turn.toolCalls) {
      if (signal.aborted) return;

      const action = { name: call.name as never, input: call.input };
      const stepId = nextId();

      emit({
        kind: "entry",
        entry: {
          id: stepId,
          role: "step",
          action: call.name as never,
          text: describeIntent(call.name, call.input),
          pending: true,
        },
      });

      const decision = gate(action, snapshot, settings.confirmRisky);

      if (decision.verdict === "refuse") {
        emit({ kind: "patch", id: stepId, text: `Blocked — ${decision.reason}`, pending: false });
        results.push({ id: call.id, content: decision.reason, isError: true });
        continue;
      }

      if (decision.verdict === "confirm") {
        const approved = await askConfirm(stepId, decision.summary);
        if (!approved) {
          emit({ kind: "patch", id: stepId, text: "Declined by user.", pending: false });
          results.push({
            id: call.id,
            isError: true,
            content:
              "The user declined this action. Do not retry it. Ask them what they want instead, or continue with the rest of the task.",
          });
          continue;
        }
      }

      const outcome = await execute(controller, action);
      controller = outcome.controller;
      const { result } = outcome;

      emit({ kind: "patch", id: stepId, text: result.detail, pending: false });

      // Verify: re-perceive after anything that could have changed the page,
      // then apply the privacy pipeline to the fresh snapshot.
      let observation = result.detail;
      const mayHaveChanged = PAGE_ACTIONS.has(call.name)
        ? call.name !== "find_text" && call.name !== "wait"
        : true;

      if (mayHaveChanged) {
        const fresh = result.snapshot ?? (await controller.snapshot());
        if (fresh) {
          const navigated = snapshot && fresh.url !== snapshot.url;
          snapshot = fresh;

          // Apply privacy pipeline to fresh snapshot.
          const { sanitized, piiCount } = sanitizeSnapshot(snapshot);
          snapshot = sanitized;
          piiTotal += piiCount;

          warnIfInjected(fresh, emit);

          if (piiCount > 0) {
            observation +=
              `\n\n--- Page after this action (redacted ${piiCount} PII) ---\n` +
              renderSnapshot(snapshot);
          } else {
            observation +=
              (navigated ? "\n\nThe page navigated." : "") +
              `\n\n--- Page after this action ---\n${renderSnapshot(snapshot)}`;
          }
        }
      }

      results.push({ id: call.id, content: observation, isError: !result.ok });
    }

    messages.push({ role: "tool", results });
  }

  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Task ended. Total PII items redacted: ${piiTotal}. Token vault cleared.`,
    },
  });

  // Clear the token vault when the task ends.
  tokenizer.clear();
}

let lastWarned = "";
function warnIfInjected(snapshot: PageSnapshot, emit: (e: AgentEvent) => void): void {
  const found = detectInjection(snapshot);
  if (!found || found === lastWarned) return;
  lastWarned = found;
  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Heads up: this page contains text addressed to an AI agent — "${found.slice(0, 120)}". I'm treating it as page content, not as an instruction.`,
    },
  });
}

function describeIntent(name: string, input: Record<string, unknown>): string {
  const reason = typeof input.reason === "string" ? input.reason : "";
  switch (name) {
    case "click":
      return reason || `Click element ${input.element_id}`;
    case "type":
      return reason || `Type into element ${input.element_id}`;
    case "navigate":
      return `Go to ${input.url}`;
    case "open_tab":
      return `Open ${input.url} in a new tab`;
    case "read_page":
      return "Read the page";
    case "scroll":
      return `Scroll ${input.direction}`;
    case "find_text":
      return `Look for "${input.query}"`;
    default:
      return reason || name.replace(/_/g, " ");
  }
}

export type { TranscriptEntry };
