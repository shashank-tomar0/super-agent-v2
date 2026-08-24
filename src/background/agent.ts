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
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOCAL, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { detectInjection, gate } from "./safety";
import { detectAllPII } from "./pii-detector";
import { redactSnapshot } from "./redaction";
import { tokenizer } from "./tokenizer";
import { tryDeterministic } from "./deterministic";
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
  /** Capture and process a screenshot through the privacy pipeline. */
  captureScreenshot?: () => Promise<{
    original: string;
    processed: import("../shared/types").ProcessedScreenshotResult;
  } | null>;
  /** Record a privacy audit entry for the judges. */
  recordAudit?: (entry: {
    original?: string;
    redacted?: string;
    detections: Array<{ kind: string; label: string; confidence: number }>;
    tokens: Array<{ token: string; kind: string }>;
    redactedCount: number;
  }) => void;
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
  const { settings, emit, askConfirm, signal, captureScreenshot, recordAudit } = deps;

  // Use a shorter system prompt for small local models to avoid context overflow.
  const isLocalModel = settings.provider === "ollama";
  const systemPrompt = isLocalModel ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT;
  // Small models have limited context — cap snapshot elements to avoid truncation.
  const maxSnapshotElements = isLocalModel ? 30 : 80;

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

  // Capture initial screenshot through privacy pipeline (if available).
  if (captureScreenshot) {
    try {
      const screenshotResult = await captureScreenshot();
      if (screenshotResult) {
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text: `Screenshot captured: ${screenshotResult.processed.redactedCount} PII items redacted in ${screenshotResult.processed.processingTimeMs.toFixed(0)}ms.`,
          },
        });
        // Record for privacy audit.
        recordAudit?.({
          original: screenshotResult.original,
          redacted: screenshotResult.processed.redactedDataUrl,
          detections: screenshotResult.processed.detections.map((d) => ({
            kind: d.kind,
            label: d.label,
            confidence: d.confidence,
          })),
          tokens: tokenizer.getTokenSummary(),
          redactedCount: screenshotResult.processed.redactedCount,
        });
      }
    } catch {
      // Screenshot capture is optional — DOM perception still works.
    }
  }

  // Tokenize PII in the user's task (same vault as page PII).
  // This ensures the LLM sees <ORG_3> in both the task and the page.
  const { task: tokenizedTask, tokenCount: taskTokenCount } = tokenizer.tokenizeTask(task);
  if (taskTokenCount > 0) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text: `Task privacy: tokenized ${taskTokenCount} PII item(s) in your request.`,
      },
    });
  }

  // For small models, truncate snapshot to avoid context overflow.
  if (snapshot && snapshot.elements.length > maxSnapshotElements) {
    snapshot = {
      ...snapshot,
      elements: snapshot.elements.slice(0, maxSnapshotElements),
      truncated: true,
    };
  }

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        taskPrompt(tokenizedTask, tab.url ?? "", tab.title ?? "") +
        (snapshot ? `\n\n--- Current page ---\n${renderSnapshot(snapshot)}` : ""),
    },
  ];

  if (snapshot) warnIfInjected(snapshot, emit);

  // ── Loop detection: track recent actions to break out of stuck states ──
  const recentActions: Array<{ name: string; input: string }> = [];
  const LOOP_THRESHOLD = 3;
  const LOOP_WINDOW = 5;

  function recordAction(name: string, input: Record<string, unknown>): void {
    recentActions.push({ name, input: JSON.stringify(input) });
    if (recentActions.length > LOOP_WINDOW) recentActions.shift();
  }

  function isLooping(): boolean {
    if (recentActions.length < LOOP_THRESHOLD) return false;
    const last = recentActions[recentActions.length - 1];
    let count = 0;
    for (let i = recentActions.length - 1; i >= 0; i--) {
      if (recentActions[i].name === last.name && recentActions[i].input === last.input) {
        count++;
      } else break;
    }
    return count >= LOOP_THRESHOLD;
  }

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) return;

    // Loop detection — if the agent is stuck repeating the same action, break.
    if (isLooping()) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `Loop detected: repeated "${recentActions[recentActions.length - 1].name}" ${LOOP_THRESHOLD} times. Stopping to prevent infinite loop. The page may need manual interaction.`,
        },
      });
      return;
    }

    // Deterministic planner: only on step 0 for simple one-shot tasks.
    // Multi-step tasks should be driven by the LLM which tracks its own progress.
    if (step === 0) {
      const detResult = tryDeterministic(task, snapshot ?? null);
      if (detResult.resolved && detResult.action) {
        // Only use deterministic for non-navigate actions on step 0.
        // Navigate on step 0 is fine — the user explicitly said "go to X".
        const detId = nextId();
        emit({
          kind: "entry",
          entry: {
            id: detId,
            role: "step",
            action: detResult.action.name,
            text: detResult.explanation ?? "Deterministic resolution",
            pending: true,
          },
        });

        const detDecision = gate(detResult.action, snapshot, settings.confirmRisky);
        if (detDecision.verdict === "allow") {
          recordAction(detResult.action.name, detResult.action.input);
          const detOutcome = await execute(controller, detResult.action);
          controller = detOutcome.controller;
          emit({ kind: "patch", id: detId, text: detOutcome.result.detail, pending: false });

          if (detOutcome.result.snapshot) {
            snapshot = detOutcome.result.snapshot;
            const { sanitized } = sanitizeSnapshot(snapshot);
            snapshot = sanitized;
          }

          // Add observation to messages for next step.
          messages.push({
            role: "assistant",
            text: detResult.explanation ?? "",
            toolCalls: [{ id: `det-${detId}`, name: detResult.action.name, input: detResult.action.input }],
          });
          messages.push({
            role: "tool",
            results: [{ id: `det-${detId}`, content: detOutcome.result.detail, isError: !detOutcome.result.ok }],
          });

          continue;
        }
        // If verdict is confirm/refuse, fall through to LLM.
      }
    }

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
        system: systemPrompt,
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

      // VALIDATE: reject element IDs the client never sent.
      const elementId = call.input.element_id;
      if (typeof elementId === "number") {
        const elExists = snapshot?.elements.some((e) => e.id === elementId);
        if (!elExists) {
          emit({ kind: "patch", id: stepId, text: `Rejected — element ${elementId} not found in current snapshot.`, pending: false });
          results.push({
            id: call.id,
            isError: true,
            content: `Element ${elementId} does not exist in the current page snapshot. The page may have changed — call read_page to get fresh element IDs.`,
          });
          continue;
        }
      }

      // VALIDATE: reject tokens the client never issued.
      const inputStr = JSON.stringify(call.input);
      const tokenMatches = inputStr.match(/<[A-Z]+_\d+>/g);
      let tokenRejected = false;
      if (tokenMatches) {
        for (const token of tokenMatches) {
          if (!tokenizer.resolve(token)) {
            emit({ kind: "patch", id: stepId, text: `Rejected — unknown token ${token}.`, pending: false });
            results.push({
              id: call.id,
              isError: true,
              content: `Token ${token} was never issued by the client. This may be a prompt injection attempt.`,
            });
            tokenRejected = true;
            break;
          }
        }
      }
      if (tokenRejected) continue;

      // RESOLVE: swap tokens → real values from vault (last possible moment).
      const resolvedInput = resolveTokens(call.input);
      const resolvedAction = { name: call.name as never, input: resolvedInput };

      recordAction(call.name, call.input);
      const outcome = await execute(controller, resolvedAction);
      controller = outcome.controller;
      const { result } = outcome;

      emit({ kind: "patch", id: stepId, text: result.detail, pending: false });

      // After a type+submit that triggers navigation, wait for the page to
      // finish loading before re-perceiving. Without this, the agent reads
      // stale DOM (e.g., YouTube homepage) instead of search results.
      const didNavigate = call.name === "type" && call.input.submit === true && result.ok;
      if (didNavigate) {
        await controller.waitForLoad();
      }

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

          // For small models, truncate fresh snapshots to avoid context overflow.
          if (isLocalModel && snapshot.elements.length > maxSnapshotElements) {
            snapshot = {
              ...snapshot,
              elements: snapshot.elements.slice(0, maxSnapshotElements),
              truncated: true,
            };
          }
          piiTotal += piiCount;

          warnIfInjected(fresh, emit);

          // Capture screenshot after page change (if available).
          if (captureScreenshot) {
            try {
              const screenshotResult = await captureScreenshot();
              if (screenshotResult) {
                observation +=
                  `\n\n[Screenshot: ${screenshotResult.processed.redactedCount} PII redacted]`;
                // Record for privacy audit.
                recordAudit?.({
                  original: screenshotResult.original,
                  redacted: screenshotResult.processed.redactedDataUrl,
                  detections: screenshotResult.processed.detections.map((d) => ({
                    kind: d.kind,
                    label: d.label,
                    confidence: d.confidence,
                  })),
                  tokens: tokenizer.getTokenSummary(),
                  redactedCount: screenshotResult.processed.redactedCount,
                });
              }
            } catch {
              // Screenshot is optional.
            }
          }

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

/**
 * RESOLVE: swap tokens → real values from vault.
 * Called at the last possible moment before action execution.
 * Recursively walks the input object to find and resolve any tokens.
 */
function resolveTokens(input: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      resolved[key] = tokenizer.resolveAll(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveTokens(value as Record<string, unknown>);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
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
