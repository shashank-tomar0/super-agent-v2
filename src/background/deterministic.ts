/**
 * Deterministic Planner
 *
 * Before calling the LLM, check if the action can be resolved
 * deterministically. This saves tokens, reduces latency, and avoids
 * hallucination for simple tasks.
 *
 * The architecture diagram says: "deterministic planner can do it?
 * form fill by label match, click by text match"
 */

import type { PageSnapshot, AgentAction } from "../shared/types";

interface DeterministicResult {
  /** Whether the action was resolved deterministically. */
  resolved: boolean;
  /** The action to execute (with element_id resolved). */
  action?: AgentAction;
  /** Human-readable explanation of what was resolved. */
  explanation?: string;
}

/**
 * Try to resolve a task description into a concrete action without
 * using the LLM. Returns null if the task is too complex.
 *
 * Supports:
 * - "click <button text>" → find and click matching element
 * - "fill <field> with <value>" → find input near label and type
 * - "scroll down/up" → scroll action
 * - "go to <url>" → navigate action
 * - "press <key>" → key action
 */
export function tryDeterministic(
  task: string,
  snapshot: PageSnapshot | null,
): DeterministicResult {
  if (!snapshot) return { resolved: false };

  const lower = task.toLowerCase().trim();

  // ── Click by text match ──
  const clickMatch = lower.match(
    /^(?:click|tap|press|hit|select)\s+(?:on\s+|the\s+)?["']?(.+?)["']?\s*$/i,
  );
  if (clickMatch) {
    const needle = clickMatch[1].toLowerCase();
    const el = snapshot.elements.find((e) => {
      const name = e.name.toLowerCase();
      const role = e.role.toLowerCase();
      return name.includes(needle) || needle.includes(name) ||
             role.includes(needle) || needle.includes(role);
    });
    if (el) {
      return {
        resolved: true,
        action: { name: "click", input: { element_id: el.id, reason: `Deterministic: matched "${el.name}"` } },
        explanation: `Found element [${el.id}] "${el.name}" matching "${clickMatch[1]}"`,
      };
    }
  }

  // ── Fill field with value ──
  const fillMatch = lower.match(
    /^(?:fill|type|enter|input|write)\s+(.+?)\s+(?:with|into|in|:)\s+(.+)$/i,
  );
  if (fillMatch) {
    const fieldDesc = fillMatch[1].toLowerCase().trim();
    const value = fillMatch[2].trim();
    const el = snapshot.elements.find((e) => {
      const name = e.name.toLowerCase();
      const role = e.role.toLowerCase();
      return (name.includes(fieldDesc) || fieldDesc.includes(name)) &&
             (role === "textbox" || role === "password" || role === "combobox");
    });
    if (el) {
      return {
        resolved: true,
        action: { name: "type", input: { element_id: el.id, text: value, reason: `Deterministic: fill "${el.name}" with "${value.slice(0, 30)}"` } },
        explanation: `Found field [${el.id}] "${el.name}" matching "${fillMatch[1]}"`,
      };
    }
  }

  // ── Scroll ──
  const scrollMatch = lower.match(/^scroll\s+(down|up|top|bottom)$/i);
  if (scrollMatch) {
    const dir = scrollMatch[1].toLowerCase();
    if (dir === "top") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "up", amount: snapshot.scroll.y } },
        explanation: "Scrolled to top of page",
      };
    }
    if (dir === "bottom") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "down", amount: snapshot.scroll.maxY - snapshot.scroll.y } },
        explanation: "Scrolled to bottom of page",
      };
    }
    return {
      resolved: true,
      action: { name: "scroll", input: { direction: dir } },
      explanation: `Scrolled ${dir}`,
    };
  }

  // ── Navigate ──
  const navMatch = lower.match(
    /^(?:go to|open|navigate to|visit)\s+(.+)$/i,
  );
  if (navMatch) {
    const url = navMatch[1].trim();
    return {
      resolved: true,
      action: { name: "navigate", input: { url, reason: `Deterministic: navigate to "${url.slice(0, 50)}"` } },
      explanation: `Navigate to ${url.slice(0, 50)}`,
    };
  }

  // ── Press key ──
  const keyMatch = lower.match(
    /^(?:press|hit)\s+(enter|escape|tab|space|backspace|delete|arrowdown|arrowup|arrowleft|arrowright)$/i,
  );
  if (keyMatch) {
    return {
      resolved: true,
      action: { name: "key", input: { key: keyMatch[1] } },
      explanation: `Press ${keyMatch[1]}`,
    };
  }

  return { resolved: false };
}
