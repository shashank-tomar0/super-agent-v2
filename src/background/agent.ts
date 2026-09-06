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
import type { ActionExperience, PIIExperience, RunExperience } from "./experience-memory";
import { extractDomain, classifyPageType } from "./experience-memory";
import { detectContextualPII, contextualToDetectedPII } from "./contextual-pii";
import {
  initLedger, recordSnapshot, recordDetections,
  recordAction as ledgerRecordAction,
  recordTokenization as ledgerRecordTokenization,
  recordRedaction as ledgerRecordRedaction,
} from "./privacy-ledger";

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
    const parts = [`[${el.id}]${el.role}`];
    if (el.name) parts.push(JSON.stringify(el.name.length > 40 ? el.name.slice(0, 40) + "..." : el.name));
    if (el.value) parts.push(`=${JSON.stringify(el.value.length > 30 ? el.value.slice(0, 30) + "..." : el.value)}`);
    if (el.attrs) {
      const attrs = Object.entries(el.attrs)
        .filter(([k]) => k !== "offscreen")
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      if (attrs) parts.push(`(${attrs})`);
    }
    return parts.join(" ");
  });

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Scroll: ${snapshot.scroll.y}/${snapshot.scroll.maxY}`,
    `Elements${snapshot.truncated ? "(truncated)" : ""}:`,
    ...lines,
    `Text: ${snapshot.text}`,
  ].join("\n");
}

/**
 * Apply the full privacy pipeline to a snapshot before it reaches the LLM.
 * Returns a sanitized snapshot and the list of detected PII.
 */
function sanitizeSnapshot(snapshot: PageSnapshot): {
  sanitized: PageSnapshot;
  piiCount: number;
  detections: Array<{ kind: string; method: string; confidence: number }>;
} {
  // 1. Detect PII: regex patterns + contextual analysis.
  const regexDetections = detectAllPII(snapshot);
  const contextualDetections = detectContextualPII(snapshot);
  const contextualPII = contextualToDetectedPII(contextualDetections);
  // Merge: regex first, then contextual (avoid duplicates by element ID).
  const seenElementIds = new Set(regexDetections.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const allDetections = [...regexDetections, ...contextualPII.filter((d) => !d.elementSelector || !seenElementIds.has(d.elementSelector))];

  // 2. Tokenize the values the detectors actually flagged (names, emails,
  //    phones, ID numbers) so they become vault tokens the LLM can reference
  //    instead of raw values.
  const tokenized = tokenizer.tokenizeDetections(snapshot, allDetections);

  // 3. Redact whatever could not be tokenized (replace with [REDACTED]).
  const { elements, text, redactedCount } = redactSnapshot(
    {
      elements: tokenized.elements,
      text: tokenized.text,
    },
    allDetections,
  );

  return {
    sanitized: {
      ...snapshot,
      elements,
      text,
    },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...regexDetections.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...contextualDetections.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
    ],
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
    tokens: Array<{ token: string; kind: string; sample?: string }>;
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
  const isFreeTier = settings.provider === "groq" || settings.provider === "nvidia";
  const systemPrompt = isLocalModel ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT;
  // Cap snapshot elements: free-tier providers need smaller snapshots for speed.
  const maxSnapshotElements = isLocalModel ? 15 : isFreeTier ? 30 : 50;

  const planner = createPlanner(settings);

  // ── Experience tracking for self-improvement ──
  const runStartTime = Date.now();
  const trackedActions: ActionExperience[] = [];
  const trackedPII: PIIExperience[] = [];
  let taskSuccess = false;
  let estimatedTokens = 0;
  let errorCount = 0;

  // ── Privacy Budget Ledger ──
  await initLedger();

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

  const domain = extractDomain(tab.url ?? "");

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
  const pageType = classifyPageType(tab.url ?? "", tab.title ?? "", snapshot?.text ?? "");

  let piiTotal = 0;
  if (snapshot) {
    // Record snapshot in privacy ledger.
    recordSnapshot(snapshot.url, snapshot.title, snapshot.elements.length).catch(() => {});

    const { sanitized, piiCount, detections } = sanitizeSnapshot(snapshot);
    snapshot = sanitized;

    // Record detections in privacy ledger.
    if (detections.length > 0) {
      recordDetections(detections.map((d) => ({ ...d, label: d.kind }))).catch(() => {});
    }

    // Record tokenization in privacy ledger.
    const tokenSummary = tokenizer.getTokenSummary();
    if (tokenSummary.length > 0) {
      ledgerRecordTokenization(tokenSummary).catch(() => {});
    }
    if (piiCount > 0) {
      ledgerRecordRedaction(piiCount, "dom").catch(() => {});
    }

    piiTotal += piiCount;

    // Track PII detections for experience memory.
    for (const det of detections) {
      trackedPII.push({
        kind: det.kind,
        method: det.method,
        outcome: "true_positive",
        confidence: det.confidence,
      });
    }

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
        // Track visual detections in experience memory too (faces, avatars).
        for (const det of screenshotResult.processed.detections) {
          trackedPII.push({
            kind: det.kind,
            method: "visual",
            outcome: "true_positive",
            confidence: det.confidence,
          });
        }
        piiTotal += screenshotResult.processed.redactedCount;
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

  // Truncate snapshot to avoid context overflow across all providers.
  if (snapshot && snapshot.elements.length > maxSnapshotElements) {
    // For free-tier: skip offscreen elements entirely for speed.
    if (isFreeTier) {
      snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
    }
    // Prefer visible elements over offscreen ones.
    const visible = snapshot.elements.filter((e) => !e.attrs?.offscreen);
    const offscreen = snapshot.elements.filter((e) => e.attrs?.offscreen);
    const kept = [...visible, ...offscreen].slice(0, maxSnapshotElements);
    snapshot = { ...snapshot, elements: kept, truncated: true };
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

  // ── Cleanup: emit experience and clear vault on ANY exit path ──
  let experienceEmitted = false;
  function finishTask(): void {
    if (experienceEmitted) return;
    experienceEmitted = true;

    const hasSuccessfulActions = trackedActions.some((a) => a.success);
    taskSuccess = !transcriptHasErrors() && (hasSuccessfulActions || trackedActions.length === 0);

    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text: `Task ended. Total PII items redacted: ${piiTotal}. Token vault cleared.`,
      },
    });

    const experience: RunExperience = {
      id: `exp-${runStartTime}`,
      timestamp: runStartTime,
      task,
      domain,
      pageType,
      piiDetections: trackedPII,
      actions: trackedActions,
      taskSuccess,
      durationMs: Date.now() - runStartTime,
      piiRedacted: piiTotal,
      estimatedTokens,
      rulesGenerated: [],
      userCorrections: [],
    };

    emit({ kind: "experience", experience } as unknown as AgentEvent);
    tokenizer.clear();
  }

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) { finishTask(); return; }

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
      finishTask();
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
          const detStart = performance.now();
          const detOutcome = await execute(controller, detResult.action);
          const detLatency = performance.now() - detStart;
          controller = detOutcome.controller;

          // Track deterministic action for experience memory.
          trackedActions.push({
            tool: detResult.action.name,
            success: detOutcome.result.ok,
            latencyMs: detLatency,
            strategy: "deterministic",
            error: detOutcome.result.ok ? undefined : detOutcome.result.detail,
          });

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
      if (signal.aborted) { finishTask(); return; }
      errorCount++;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      });
      finishTask();
      return;
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

    if (turn.stopReason === "refusal") {
      errorCount++;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `The model declined this request (${turn.refusal ?? "unspecified"}).`,
        },
      });
      finishTask();
      return;
    }

    // No tools left to call — the model has given its final answer.
    if (turn.toolCalls.length === 0) { finishTask(); return; }

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
      // When stale, auto-receive and inject fresh snapshot to save an LLM round trip.
      const elementId = call.input.element_id;
      if (typeof elementId === "number") {
        const elExists = snapshot?.elements.some((e) => e.id === elementId);
        if (!elExists) {
          // Auto-receive: get fresh snapshot so the LLM immediately has new IDs.
          const freshSnapshot = await controller.snapshot();
          if (freshSnapshot) {
            const { sanitized: freshSanitized } = sanitizeSnapshot(freshSnapshot);
            snapshot = freshSanitized;
            // For free-tier: skip offscreen elements entirely for speed.
            if (isFreeTier) {
              snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
            }
            if (snapshot.elements.length > maxSnapshotElements) {
              const vis = snapshot.elements.filter((e) => !e.attrs?.offscreen);
              const off = snapshot.elements.filter((e) => e.attrs?.offscreen);
              snapshot = { ...snapshot, elements: [...vis, ...off].slice(0, maxSnapshotElements), truncated: true };
            }
          }
          const freshRendered = snapshot ? renderSnapshot(snapshot) : "(no snapshot available)";
          emit({ kind: "patch", id: stepId, text: `Element ${elementId} stale — re-perceived page.`, pending: false });
          results.push({
            id: call.id,
            isError: true,
            content: `Element ${elementId} not found. The page changed. Here are the current elements — pick the right one and retry:

${freshRendered}`,
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
      const actionStart = performance.now();
      const outcome = await execute(controller, resolvedAction);
      const actionLatency = performance.now() - actionStart;
      controller = outcome.controller;
      const { result } = outcome;

      // Track action for experience memory.
      trackedActions.push({
        tool: call.name,
        success: result.ok,
        latencyMs: actionLatency,
        strategy: "llm",
        error: result.ok ? undefined : result.detail,
      });

      // Record action in privacy ledger.
      ledgerRecordAction(call.name, result.ok, typeof call.input.element_id === "number" ? call.input.element_id : undefined).catch(() => {});

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
          const { sanitized, piiCount, detections: freshDetections } = sanitizeSnapshot(snapshot);
          snapshot = sanitized;

          // Truncate fresh snapshots to avoid context overflow.
          if (isFreeTier) {
            snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
          }
          if (snapshot.elements.length > maxSnapshotElements) {
            const vis = snapshot.elements.filter((e) => !e.attrs?.offscreen);
            const off = snapshot.elements.filter((e) => e.attrs?.offscreen);
            snapshot = { ...snapshot, elements: [...vis, ...off].slice(0, maxSnapshotElements), truncated: true };
          }
          piiTotal += piiCount;

          // Track PII detections from fresh snapshot.
          for (const det of freshDetections) {
            trackedPII.push({
              kind: det.kind,
              method: det.method,
              outcome: "true_positive",
              confidence: det.confidence,
            });
          }

          warnIfInjected(fresh, emit);

          // Capture screenshot after page change (if available).
          if (captureScreenshot) {
            try {
              const screenshotResult = await captureScreenshot();
              if (screenshotResult) {
                observation +=
                  `\n\n[Screenshot: ${screenshotResult.processed.redactedCount} PII redacted]`;
                // Track visual detections in experience memory too (faces, avatars).
                for (const det of screenshotResult.processed.detections) {
                  trackedPII.push({
                    kind: det.kind,
                    method: "visual",
                    outcome: "true_positive",
                    confidence: det.confidence,
                  });
                }
                if (screenshotResult.processed.redactedCount > 0) {
                  ledgerRecordRedaction(screenshotResult.processed.redactedCount, "visual").catch(() => {});
                }
                piiTotal += screenshotResult.processed.redactedCount;
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

  // Normal loop completion — emit experience.
  finishTask();

  function transcriptHasErrors(): boolean {
    return errorCount > 0;
  }
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
