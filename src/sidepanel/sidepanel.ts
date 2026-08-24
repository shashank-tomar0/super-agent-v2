import type { AgentEvent, PanelCommand, TranscriptEntry } from "../shared/types";

// ─── DOM References ────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const transcriptEl = $("transcript");
const emptyEl = $("empty");
const taskInput = $<HTMLTextAreaElement>("task-input");
const runBtn = $("run-btn");
const stopBtn = $("stop-btn");
const statusDot = $("status-dot");
const statusText = $("status-text");
const confirmEl = $("confirm");
const confirmText = $("confirm-text");
const privacyAuditEl = $("privacy-audit");
const egressBadge = $("egress-badge");
const perceptionCounter = $("perception-counter");

/** Rendered entries, so patches can find their node without a re-render. */
const nodes = new Map<string, HTMLElement>();
let pendingConfirmId: string | null = null;
let perceptionCount = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

function send(command: PanelCommand): Promise<unknown> {
  return chrome.runtime.sendMessage(command).catch(() => undefined);
}

function atBottom(): boolean {
  return (
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60
  );
}

function updatePerceptionCount() {
  perceptionCount++;
  perceptionCounter.textContent = `PERCEPTION N° ${String(perceptionCount).padStart(2, "0")}`;
}

// ─── Transcript Rendering ──────────────────────────────────────────────────

const GLYPHS: Record<string, string> = {
  click: "→",
  type: "⌨",
  select: "▾",
  scroll: "↕",
  key: "⏎",
  find_text: "⌕",
  wait: "◷",
  read_page: "◉",
  navigate: "⇢",
  go_back: "⇠",
  open_tab: "＋",
  switch_tab: "⇄",
  close_tab: "×",
  list_tabs: "☰",
};

function render(entry: TranscriptEntry): void {
  emptyEl.classList.add("hidden");
  const stick = atBottom();

  let node = nodes.get(entry.id);
  if (!node) {
    node = document.createElement("div");
    node.className = `entry ${entry.role}`;
    if (entry.role === "step") {
      node.innerHTML = `<span class="glyph"></span><span class="detail"></span>`;
    }
    nodes.set(entry.id, node);
    transcriptEl.appendChild(node);
  }

  if (entry.role === "step") {
    node.querySelector(".glyph")!.textContent = GLYPHS[entry.action ?? ""] ?? "•";
    const detail = node.querySelector(".detail");
    if (detail) detail.textContent = entry.text;
    node.classList.toggle("pending", entry.pending === true);
  } else {
    node.textContent = entry.text;
  }

  if (stick) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setRunning(running: boolean): void {
  statusDot.classList.toggle("running", running);
  statusText.textContent = running ? "RUNNING" : "IDLE";
  runBtn.classList.toggle("hidden", running);
  stopBtn.classList.toggle("hidden", !running);
  taskInput.disabled = running;
}

// ─── Privacy Audit Rendering ───────────────────────────────────────────────

const KIND_EMOJI: Record<string, string> = {
  face: "👤",
  credential: "🔑",
  id_number: "🪪",
  api_key: "🗝️",
  pii_text: "📝",
  input_field: "⌨",
};

function renderPrivacyAudit(audit: {
  screenshots: Array<{ original?: string; redacted?: string; timestamp: number }>;
  allDetections: Array<{ kind: string; label: string; confidence: number }>;
  allTokens: Array<{ token: string; kind: string }>;
  totalRedacted: number;
  totalScreenshots: number;
  totalPIIDetections: number;
  durationMs: number;
}): void {
  privacyAuditEl.classList.remove("hidden");

  // Summary stats.
  const summaryEl = $("audit-summary");
  summaryEl.innerHTML = `
    <div class="audit-stat">
      <span class="number">${audit.totalPIIDetections}</span>
      <span class="label">PII Detected</span>
    </div>
    <div class="audit-stat">
      <span class="number">${audit.totalRedacted}</span>
      <span class="label">Items Redacted</span>
    </div>
    <div class="audit-stat">
      <span class="number">${audit.allTokens.length}</span>
      <span class="label">Tokens Created</span>
    </div>
  `;

  // Screenshots before/after.
  const screenshotsEl = $("audit-screenshots");
  if (audit.screenshots.length > 0) {
    screenshotsEl.innerHTML = `<h4>Before / After Redaction</h4>`;
    for (const shot of audit.screenshots) {
      const pair = document.createElement("div");
      pair.className = "screenshot-pair";
      if (shot.original) {
        pair.innerHTML += `
          <div class="shot">
            <img src="${shot.original}" alt="Original" />
            <div class="shot-label">Original</div>
          </div>`;
      }
      if (shot.redacted) {
        pair.innerHTML += `
          <div class="shot">
            <img src="${shot.redacted}" alt="Redacted" />
            <div class="shot-label">🔒 Redacted</div>
          </div>`;
      }
      screenshotsEl.appendChild(pair);
    }
  } else {
    screenshotsEl.innerHTML = "";
  }

  // Detection chips.
  const detectionsEl = $("audit-detections");
  if (audit.allDetections.length > 0) {
    const unique = new Map<string, { kind: string; label: string; count: number }>();
    for (const d of audit.allDetections) {
      const existing = unique.get(d.label);
      if (existing) existing.count++;
      else unique.set(d.label, { kind: d.kind, label: d.label, count: 1 });
    }
    detectionsEl.innerHTML = `<h4>Detected PII</h4><div class="detection-list"></div>`;
    const list = detectionsEl.querySelector(".detection-list")!;
    for (const [, det] of unique) {
      const chip = document.createElement("span");
      chip.className = `detection-chip ${det.kind}`;
      chip.textContent = `${KIND_EMOJI[det.kind] ?? "•"} ${det.label}${det.count > 1 ? ` ×${det.count}` : ""}`;
      list.appendChild(chip);
    }
  } else {
    detectionsEl.innerHTML = "";
  }

  // Token vault.
  const tokensEl = $("audit-tokens");
  if (audit.allTokens.length > 0) {
    tokensEl.innerHTML = `<h4>Token Vault (values hidden)</h4><div class="token-list"></div>`;
    const list = tokensEl.querySelector(".token-list")!;
    for (const tok of audit.allTokens) {
      const chip = document.createElement("span");
      chip.className = "token-chip";
      chip.textContent = tok.token;
      chip.title = "Original value is never stored";
      list.appendChild(chip);
    }
  } else {
    tokensEl.innerHTML = "";
  }

  privacyAuditEl.scrollIntoView({ behavior: "smooth" });
}

// ─── Event Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((event: AgentEvent) => {
  switch (event.kind) {
    case "entry":
      render(event.entry);
      break;

    case "patch": {
      const node = nodes.get(event.id);
      if (!node) break;
      if (event.text !== undefined) {
        if (node.classList.contains("assistant")) {
          node.textContent = (node.textContent ?? "") + event.text;
        } else if (node.classList.contains("step")) {
          const detail = node.querySelector(".detail");
          if (detail) detail.textContent = event.text;
        } else {
          node.textContent = event.text;
        }
      }
      if (event.pending !== undefined) node.classList.toggle("pending", event.pending);
      if (atBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;
    }

    case "status":
      setRunning(event.running);
      break;

    case "confirm":
      pendingConfirmId = event.id;
      confirmText.textContent = event.summary;
      confirmEl.classList.remove("hidden");
      break;

    case "privacy-audit":
      renderPrivacyAudit(event.audit);
      break;
  }
});

// ─── Confirm Dialog ────────────────────────────────────────────────────────

function answerConfirm(approved: boolean): void {
  if (!pendingConfirmId) return;
  void send({ kind: "confirm-reply", id: pendingConfirmId, approved });
  pendingConfirmId = null;
  confirmEl.classList.add("hidden");
}

$("confirm-yes").addEventListener("click", () => answerConfirm(true));
$("confirm-no").addEventListener("click", () => answerConfirm(false));

// ─── Audit Close ───────────────────────────────────────────────────────────

$("audit-close").addEventListener("click", () => {
  privacyAuditEl.classList.add("hidden");
});

// ─── Task Submission ───────────────────────────────────────────────────────

async function submit(task?: string): Promise<void> {
  const text = task ?? taskInput.value.trim();
  if (!text) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  taskInput.value = "";
  taskInput.style.height = "auto";
  privacyAuditEl.classList.add("hidden");
  updatePerceptionCount();
  await send({ kind: "run", task: text, tabId: tab.id });
}

// Run button / Enter
runBtn.addEventListener("click", () => void submit());
taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

// Stop
stopBtn.addEventListener("click", () => void send({ kind: "stop" }));

// New task
$("new-task-btn").addEventListener("click", () => {
  void send({ kind: "reset" });
  nodes.clear();
  transcriptEl.querySelectorAll(".entry").forEach((n) => n.remove());
  emptyEl.classList.remove("hidden");
  privacyAuditEl.classList.add("hidden");
  setRunning(false);
  perceptionCount = 0;
  egressBadge.textContent = "0 KB EGRESS";
  perceptionCounter.textContent = "PERCEPTION N° 01";
});

// Settings
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Perception view (toggle audit)
$("btn-perception").addEventListener("click", () => {
  privacyAuditEl.classList.toggle("hidden");
});

// ─── Quick Actions ─────────────────────────────────────────────────────────

document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
  el.addEventListener("click", () => {
    const action = el.dataset.action;
    const taskMap: Record<string, string> = {
      "fill-form": "Fill all visible form fields on this page with appropriate data",
      "extract-data": "Extract all visible data from this page and list it",
      "scan-pii": "Scan this page for any PII (passwords, IDs, emails, phone numbers) and report what you find",
      "click-target": "Identify and click the primary action button on this page",
    };
    void submit(taskMap[action ?? ""] ?? "Do something on this page");
  });
});

// ─── Context Presets ───────────────────────────────────────────────────────

document.querySelectorAll<HTMLElement>("[data-preset]").forEach((el) => {
  el.addEventListener("click", () => {
    const preset = el.dataset.preset;
    const presetMap: Record<string, string> = {
      aadhaar: "Scan this page for Aadhaar numbers (12-digit) and redact them",
      pan: "Scan this page for PAN card numbers (5 letters + 4 digits + 1 letter) and redact them",
      contact: "Scan this page for contact information (emails, phone numbers, addresses) and list them",
    };
    void submit(presetMap[preset ?? ""] ?? "Scan for PII");
  });
});

// ─── Input Auto-grow ───────────────────────────────────────────────────────

taskInput.addEventListener("input", () => {
  taskInput.style.height = "auto";
  taskInput.style.height = `${Math.min(taskInput.scrollHeight, 120)}px`;
});

// ─── Restore State on Reopen ───────────────────────────────────────────────

void (async () => {
  const state = (await chrome.runtime.sendMessage({ kind: "get-state" })) as
    | { transcript: TranscriptEntry[]; running: boolean }
    | undefined;
  if (!state) return;
  state.transcript.forEach(render);
  setRunning(state.running);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
})();
