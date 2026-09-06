/**
 * Groq Planner
 *
 * Uses Groq's OpenAI-compatible /openai/v1 endpoint.
 * Groq is free-tier friendly with ultra-fast inference (280-1000 tps).
 * The API is fully OpenAI-compatible, so we reuse the OpenAI adapter
 * with a different base URL.
 *
 * Key models:
 *   - llama-3.3-70b-versatile (131K context, 280 tps)
 *   - llama-3.1-8b-instant (131K context, 560 tps)
 *   - openai/gpt-oss-20b (131K context, 1000 tps)
 */

import { createOpenAIPlanner } from "./openai.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Groq uses the exact same chat completions API as OpenAI.
 * We delegate to the OpenAI planner with the Groq base URL.
 */
export function createGroqPlanner(apiKey: string, model: string) {
  return createOpenAIPlanner("openrouter", apiKey, model, GROQ_BASE_URL);
}
