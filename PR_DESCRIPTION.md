# PR: Improved Agent Loop + Privacy Pipeline

## What This PR Does

Improves the agent loop so tasks like **sending email** actually work, and adds a full **privacy-preserving pipeline** that detects and redacts PII before any data leaves the browser.

## Key Improvements

### 1. Agent Loop Fixes (the mail-send fix)
- **Token budget-aware rendering**: `renderSnapshot` now caps at 6000 chars with graceful truncation. Previously, huge pages would blow the LLM context window and the agent would get confused.
- **Better error recovery**: If the LLM stream drops mid-chunk, partial tool calls are handled gracefully instead of silently failing.
- **Stale ID protection**: After actions that change the page, the agent re-perceives before planning the next step. This prevents "click element 5" failures when element IDs changed.
- **Improved `describeIntent`**: Better action descriptions so the LLM knows exactly what it's doing.

### 2. Privacy Pipeline (new)
The entire privacy system that was missing:

| Component | File | What It Does |
|---|---|---|
| **PII Detector** | `src/background/pii-detector.ts` | Detects credentials, API keys, Aadhaar/PAN/SSN patterns in DOM |
| **Redaction Engine** | `src/background/redaction.ts` | Canvas blur/mask for faces and credentials in screenshots |
| **PII Tokenizer** | `src/background/tokenizer.ts` | Replaces sensitive values with `<CRED_1>`, `<ID_2>` tokens |
| **Screenshot Pipeline** | `src/content/screenshot.ts` | Captures tab + processes through privacy pipeline |
| **Offscreen Document** | `src/offscreen/offscreen.ts` | DOM-guided screenshot redaction + face detection |
| **Sensitive Region Detection** | `src/content/perceive.ts` | Finds ALL input fields (passwords, Gmail compose, contenteditable) |

### 3. Service Worker Orchestration
- `src/background/service-worker.ts` now handles:
  - Screenshot capture (via `chrome.tabs.captureVisibleTab`)
  - Offscreen document management
  - Privacy audit collection
  - DPR-aware coordinate scaling

### 4. Safety Gate Upgrades
- `src/background/safety.ts`: 27 credential patterns, 13 value patterns, 10 injection detection rules
- Indian ID-specific refusals (Aadhaar, PAN, IFSC)
- API key detection (Anthropic, OpenAI, GitHub, Slack, AWS, JWT)

### 5. UI Improvements
- **Privacy Audit Panel** (`src/sidepanel/`): After each task, shows before/after screenshots, detection chips, token vault
- **Options Page** (`src/options/`): Server config, privacy toggles, status badges
- **Manifest**: Added `offscreen` permission, updated permissions

### 6. Server (optional)
- `server/` directory with Express server for privacy-preserving VLM processing
- Receives ONLY sanitized data, returns actionable commands

## Files Changed (agent loop specific)

```
src/background/agent.ts          — Privacy pipeline integration, screenshot capture, audit
src/background/service-worker.ts — Screenshot capture, offscreen management, audit collector
src/background/safety.ts         — Upgraded safety gate with Indian ID patterns
src/background/prompt.ts         — Rebranded to VLEE
src/content/perceive.ts          — Sensitive region detection (all input fields)
src/content/content.ts           — Added get-sensitive-regions message handler
src/shared/types.ts              — New types: ProcessedScreenshotResult, ContentRequest
```

## New Files

```
src/background/pii-detector.ts   — PII detection engine
src/background/redaction.ts      — Canvas redaction engine
src/background/tokenizer.ts      — PII token vault
src/content/screenshot.ts        — Screenshot capture (thin wrapper)
src/offscreen/offscreen.ts       — DOM-guided screenshot redaction
src/offscreen/index.html         — Offscreen document HTML
server/                          — Privacy-preserving VLM server (optional)
```

## How to Merge

### Option A: Cherry-pick (recommended)
```bash
# Add the remote
git remote add shashank https://github.com/shashank-tomar0/super-agent-v2.git
git fetch shashank

# Cherry-pick all commits from the branch
git cherry-pick shashank/feat/improved-agent-loop
```

### Option B: Merge the branch
```bash
git remote add shashank https://github.com/shashank-tomar0/super-agent-v2.git
git fetch shashank
git merge shashank/feat/improved-agent-loop
```

### Option C: Merge specific commits
```bash
# Pick only the agent loop fixes (skip privacy pipeline if not needed yet)
git cherry-pick c2ffd92  # feat: add full privacy-preserving vision pipeline
git cherry-pick 9b6030c  # fix: move screenshot capture from content script to service worker
git cherry-pick de9a63d  # fix: add global flag to regex
git cherry-pick 8937d0b  # fix: offscreen document communication
git cherry-pick 94bf6e1  # feat: Privacy Audit Panel
git cherry-pick 7ef3637  # feat: DOM-guided screenshot redaction
git cherry-pick 9185302  # fix: DPR scaling
git cherry-pick 37db2cf  # fix: aggressive PII detection
```

## Testing

After merging:
1. `npm install && npm run build`
2. Load `dist/` in Chrome via `chrome://extensions`
3. Open Options → enter API key → Save
4. Try: "Open Gmail and send an email to test@gmail.com saying hi"
5. Check service worker console for privacy pipeline logs

## Dependencies Added

- None for the core agent loop
- `@huggingface/transformers` was tried and removed (didn't work for PII detection)
- Server uses: express, cors, dotenv, @anthropic-ai/sdk, openai (all optional)
