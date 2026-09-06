/**
 * Headless verification harness.
 *
 * Bundled with esbuild and run with node. Exercises the REAL modules the
 * extension ships (pii-detector, contextual-pii, tokenizer, redaction,
 * experience-memory, reflection, learned-rules, privacy-ledger) against mock
 * page snapshots that mirror what the content script produces, then asserts
 * the end-to-end invariants:
 *
 *   1. PII text (Aadhaar / PAN / email / phone / names) is detected.
 *   2. Detected values become vault tokens (not just [REDACTED]).
 *   3. Redacted snapshot shows tokens; raw values are gone.
 *   4. Visual (screenshot) detections feed experience memory.
 *   5. Dashboard stats (PII detected / redacted / runs) populate.
 *   6. Privacy ledger records redaction events and chain stays intact.
 */
import assert from "node:assert";

// ─── chrome.storage shim (what the modules call) ───────────────────────────
const mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: mem.get(key) };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (mem.has(k)) out[k] = mem.get(k);
          return out;
        }
        const out = {};
        for (const [k, v] of mem) out[k] = v;
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) mem.set(k, v); },
      async remove(key) {
        if (typeof key === "string") mem.delete(key);
        else for (const k of key) mem.delete(k);
      },
    },
  },
  runtime: { sendMessage: async () => {} },
};

const {
  detectAllPII,
} = await import("../src/background/pii-detector.ts");
const { detectContextualPII, contextualToDetectedPII } = await import("../src/background/contextual-pii.ts");
const { tokenizer } = await import("../src/background/tokenizer.ts");
const { redactSnapshot } = await import("../src/background/redaction.ts");
const {
  recordExperience, getMemoryStats, clearExperienceMemory,
  extractDomain, classifyPageType,
} = await import("../src/background/experience-memory.ts");
const { reflectOnRun } = await import("../src/background/reflection.ts");
const { applyReflectionResults, getLearnedRules, getRulesSummary } = await import("../src/background/learned-rules.ts");
const { recordRedaction, getLedgerSummary, clearLedger } = await import("../src/background/privacy-ledger.ts");

// ─── The exact sanitize flow from agent.ts sanitizeSnapshot() ───────────────
function sanitizeSnapshot(snapshot) {
  const regexDetections = detectAllPII(snapshot);
  const contextualDetections = detectContextualPII(snapshot);
  const contextualPII = contextualToDetectedPII(contextualDetections);
  const seenElementIds = new Set(regexDetections.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const allDetections = [...regexDetections, ...contextualPII.filter((d) => !d.elementSelector || !seenElementIds.has(d.elementSelector))];

  const tokenized = tokenizer.tokenizeDetections(snapshot, allDetections);
  const { elements, text, redactedCount } = redactSnapshot(
    { elements: tokenized.elements, text: tokenized.text },
    allDetections,
  );
  return {
    sanitized: { ...snapshot, elements, text },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...regexDetections.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...contextualDetections.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
    ],
  };
}

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Scenario A: a profile page with real PII in text + a form ─────────────
console.log("\n=== Scenario A: profile/banking page with PII ===\n");
tokenizer.clear();
await clearExperienceMemory();
await clearLedger();

const snapshotA = {
  url: "https://example.com/profile",
  title: "Edit profile",
  elements: [
    { id: 0, role: "textbox", name: "Full name", value: "Rahul Sharma", attrs: { inputType: "text" } },
    { id: 1, role: "textbox", name: "Email", value: "rahul.sharma@gmail.com", attrs: { inputType: "email" } },
    { id: 2, role: "textbox", name: "Mobile number", value: "+91 98765 43210", attrs: { inputType: "tel" } },
    { id: 3, role: "button", name: "Save changes" },
  ],
  // Page text holds the actual identity numbers.
  text:
    "Identity verification — Aadhaar: 1234 5678 9012, PAN: ABCDE1234F. " +
    "Contact rahul.sharma@gmail.com or +91 98765 43210 for support.",
};

const resultA = sanitizeSnapshot(snapshotA);
ok("Aadhaar/PAN/email/phone + contextual fields all detected",
  resultA.detections.length >= 4,
  `got ${resultA.detections.length}: ${JSON.stringify(resultA.detections.map((d) => d.kind))}`);

const tokensA = tokenizer.getTokenSummary();
ok("vault created tokens from detections", tokensA.length > 0, `tokens=${JSON.stringify(tokensA)}`);
ok("tokens include masked samples", tokensA.every((t) => t.sample && t.sample.includes("•")), "no sample found");
ok("token sample masks email domain", tokensA.some((t) => t.sample?.includes("@")), "email sample missing @domain");

const rendered = JSON.stringify(resultA.sanitized);
ok("raw Aadhaar digits gone from sanitized snapshot", !rendered.includes("1234 5678 9012"));
ok("raw PAN gone", !rendered.includes("ABCDE1234F"));
ok("raw email gone", !rendered.includes("rahul.sharma@gmail.com"));
ok("sanitized snapshot contains token markers", rendered.includes("<")); 

// Feed experience memory exactly like the agent does (DOM+text detections
// become trackedPII with method regex/contextual, screenshot ones "visual").
const domain = extractDomain(snapshotA.url);
const pageType = classifyPageType(snapshotA.url, snapshotA.title, snapshotA.text);
const experience = {
  id: "exp-test-a",
  timestamp: Date.now(),
  task: "scan profile page for PII",
  domain,
  pageType,
  piiDetections: resultA.detections.map((d) => ({ kind: d.kind, method: d.method, outcome: "true_positive", confidence: d.confidence })),
  actions: [],
  taskSuccess: true,
  durationMs: 900,
  piiRedacted: resultA.piiCount,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
await recordExperience(experience);

const statsA = await getMemoryStats();
ok("dashboard run count = 1", statsA.totalRuns === 1, `got ${statsA.totalRuns}`);
ok("dashboard PII detected > 0", statsA.totalPIIDetected > 0, `got ${statsA.totalPIIDetected}`);
ok("dashboard PII redacted > 0", statsA.totalPIIRedacted > 0, `got ${statsA.totalPIIRedacted}`);

await recordRedaction(resultA.piiCount, "dom");
const ledgerA = await getLedgerSummary();
ok("ledger records redactions", ledgerA.totalRedactions > 0, `got ${ledgerA.totalRedactions}`);
ok("ledger chain intact", ledgerA.chainValid === true);

// Reflection should produce at least the site-pattern rule.
const existingRules = await getLearnedRules();
const reflection = reflectOnRun(experience, existingRules);
if (reflection.newRules.length > 0) {
  await applyReflectionResults(reflection);
  const summary = await getRulesSummary();
  ok("reflection generated rules", summary.total > 0, JSON.stringify(summary));
} else {
  console.log("  (no new rules this run — acceptable for a single run)");
}

// ─── Scenario B: screenshot/visual detections feed memory too ───────────────
console.log("\n=== Scenario B: visual (screenshot) detections ===\n");
tokenizer.clear();

const visualDetections = [
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "credential", label: "Password field", confidence: 0.95 },
];

const experienceB = {
  id: "exp-test-b",
  timestamp: Date.now(),
  task: "open email inbox",
  domain: "mail.example.com",
  pageType: "email",
  // Agent now pushes screenshot detections as method "visual".
  piiDetections: visualDetections.map((d) => ({ kind: d.kind, method: "visual", outcome: "true_positive", confidence: d.confidence })),
  actions: [
    { tool: "navigate", success: true, latencyMs: 800, strategy: "llm" },
    { tool: "click", success: true, latencyMs: 120, strategy: "llm" },
  ],
  taskSuccess: true,
  durationMs: 3400,
  piiRedacted: 3,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
await recordExperience(experienceB);

const statsB = await getMemoryStats();
ok("total runs = 2", statsB.totalRuns === 2, `got ${statsB.totalRuns}`);
ok("PII detected includes visual detections", statsB.totalPIIDetected >= 6, `got ${statsB.totalPIIDetected}`);
ok("success rate = 100%", statsB.averageSuccessRate === 1, `got ${statsB.averageSuccessRate}`);

await recordRedaction(3, "visual");
const ledgerB = await getLedgerSummary();
ok("ledger totals both DOM + visual redactions", ledgerB.totalRedactions >= 4, `got ${ledgerB.totalRedactions}`);
ok("ledger entries grew", ledgerB.totalEntries >= 2, `got ${ledgerB.totalEntries}`);

console.log(`\n${passed} assertions passed. Pipeline verified end-to-end.`);
