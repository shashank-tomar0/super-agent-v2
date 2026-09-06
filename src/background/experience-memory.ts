/**
 * Experience Memory
 *
 * Stores structured data from every agent run so the reflection engine
 * can learn from successes and failures. The memory grows over time
 * and powers the self-improvement loop.
 *
 * Storage: chrome.storage.local (persists across sessions)
 * Key: "vless-experience-memory"
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PIIExperience {
  /** Type of PII detected (e.g., "credential", "id_number", "face"). */
  kind: string;
  /** Detection method that found it ("regex", "dom", "face_detector", "learned_rule"). */
  method: string;
  /** Whether it was a true positive or false positive. */
  outcome: "true_positive" | "false_positive" | "missed";
  /** Confidence score from the detector. */
  confidence: number;
}

export interface ActionExperience {
  /** Tool name (click, type, navigate, etc.). */
  tool: string;
  /** Whether the action succeeded. */
  success: boolean;
  /** Latency in ms. */
  latencyMs: number;
  /** Whether this was deterministic or LLM-planned. */
  strategy: "deterministic" | "llm";
  /** Error message if failed. */
  error?: string;
}

export interface SiteExperience {
  /** Domain of the site visited. */
  domain: string;
  /** Page type classification (inferred from content). */
  pageType: string;
  /** PII types commonly found on this site. */
  commonPII: string[];
  /** Whether the deterministic planner worked for this site. */
  deterministicWorks: boolean;
  /** Number of times this site has been visited. */
  visitCount: number;
}

export interface RunExperience {
  /** Unique run ID. */
  id: string;
  /** Timestamp. */
  timestamp: number;
  /** The task description. */
  task: string;
  /** Domain where the task was executed. */
  domain: string;
  /** Page type (banking, email, social, form, e-commerce, etc.). */
  pageType: string;
  /** PII detected during this run. */
  piiDetections: PIIExperience[];
  /** Actions taken during this run. */
  actions: ActionExperience[];
  /** Whether the task completed successfully. */
  taskSuccess: boolean;
  /** Total duration in ms. */
  durationMs: number;
  /** Total PII items redacted. */
  piiRedacted: number;
  /** Total tokens used (estimated from message lengths). */
  estimatedTokens: number;
  /** Whether re-OCR verification was run and passed. */
  reocrVerified?: boolean;
  /** Re-OCR results: PII found in redacted image. */
  reocrLeakedPII?: string[];
  /** Learned rules generated from this run. */
  rulesGenerated: string[];
  /** User corrections (if any). */
  userCorrections: string[];
}

export interface MemoryStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalPIIDetected: number;
  totalPIIRedacted: number;
  totalFalsePositives: number;
  totalMissedPII: number;
  averageSuccessRate: number;
  sitesVisited: number;
  rulesLearned: number;
  /** Improvement trend: success rate over last 5 runs vs first 5 runs. */
  improvementDelta: number;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "vless-experience-memory";
const MAX_EXPERIENCES = 200;

async function getExperiences(): Promise<RunExperience[]> {
  const { [STORAGE_KEY]: experiences } = await chrome.storage.local.get(STORAGE_KEY);
  return experiences ?? [];
}

async function saveExperiences(experiences: RunExperience[]): Promise<void> {
  // Trim to max size.
  if (experiences.length > MAX_EXPERIENCES) {
    experiences = experiences.slice(0, MAX_EXPERIENCES);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: experiences });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a completed run experience.
 */
export async function recordExperience(experience: RunExperience): Promise<void> {
  const experiences = await getExperiences();
  experiences.unshift(experience);
  await saveExperiences(experiences);
}

/**
 * Get all stored experiences.
 */
export async function getAllExperiences(): Promise<RunExperience[]> {
  return getExperiences();
}

/**
 * Get experiences for a specific domain.
 */
export async function getExperiencesForDomain(domain: string): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.domain === domain);
}

/**
 * Get experiences for a specific page type.
 */
export async function getExperiencesForPageType(pageType: string): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.pageType === pageType);
}

/**
 * Get the most recent N experiences.
 */
export async function getRecentExperiences(n: number): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.slice(0, n);
}

/**
 * Compute aggregate memory statistics.
 */
export async function getMemoryStats(): Promise<MemoryStats> {
  const experiences = await getExperiences();

  if (experiences.length === 0) {
    return {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalPIIDetected: 0,
      totalPIIRedacted: 0,
      totalFalsePositives: 0,
      totalMissedPII: 0,
      averageSuccessRate: 0,
      sitesVisited: 0,
      rulesLearned: 0,
      improvementDelta: 0,
    };
  }

  const totalRuns = experiences.length;
  const successfulRuns = experiences.filter((e) => e.taskSuccess).length;
  const failedRuns = totalRuns - successfulRuns;

  let totalPIIDetected = 0;
  let totalPIIRedacted = 0;
  let totalFalsePositives = 0;
  let totalMissedPII = 0;
  let totalRulesLearned = 0;

  const domains = new Set<string>();

  for (const exp of experiences) {
    domains.add(exp.domain);
    totalRulesLearned += exp.rulesGenerated.length;

    for (const pii of exp.piiDetections) {
      totalPIIDetected++;
      if (pii.outcome === "true_positive") totalPIIRedacted++;
      if (pii.outcome === "false_positive") totalFalsePositives++;
      if (pii.outcome === "missed") totalMissedPII++;
    }
  }

  // Improvement delta: compare success rate of last 5 runs vs first 5 runs.
  let improvementDelta = 0;
  if (totalRuns >= 10) {
    const first5 = experiences.slice(-5);
    const last5 = experiences.slice(0, 5);
    const firstRate = first5.filter((e) => e.taskSuccess).length / 5;
    const lastRate = last5.filter((e) => e.taskSuccess).length / 5;
    improvementDelta = lastRate - firstRate;
  }

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    totalPIIDetected,
    totalPIIRedacted,
    totalFalsePositives,
    totalMissedPII,
    averageSuccessRate: successfulRuns / totalRuns,
    sitesVisited: domains.size,
    rulesLearned: totalRulesLearned,
    improvementDelta,
  };
}

/**
 * Extract domain from a URL.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Classify page type from URL and content heuristics.
 */
export function classifyPageType(url: string, title: string, text: string): string {
  const combined = `${url} ${title} ${text}`.toLowerCase();

  if (/bank|finance|account|balance|transfer|payment|upi|neft|rtgs/.test(combined)) return "banking";
  if (/mail|inbox|compose|gmail|outlook|yahoo.*mail/.test(combined)) return "email";
  if (/login|signin|sign.in|auth|credential/.test(combined)) return "auth";
  if (/shop|cart|checkout|amazon|flipkart|product|buy/.test(combined)) return "ecommerce";
  if (/form|survey|quiz|填写|申请/.test(combined)) return "form";
  if (/social|feed|timeline|profile|tweet|post|facebook|twitter|instagram|linkedin/.test(combined)) return "social";
  if (/search|query|result|google|bing|duckduckgo/.test(combined)) return "search";
  if (/doc|sheet|slide|notion|confluence|wiki/.test(combined)) return "productivity";
  if (/gov|aadhaar|pan|passport|tax|return|filing/.test(combined)) return "government";

  return "other";
}

/**
 * Clear all experience memory.
 */
export async function clearExperienceMemory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
