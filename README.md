# VLESS Agent

**VLESS** (Vision-Language Edge Engine) — a privacy-preserving browser agent that runs
visual perception models on your device, detects and redacts PII before anything
crosses the wire, and delegates reasoning to a server-side VLM that only ever
sees sanitized data.

Built for **SIH 2026 Problem Statement #26171**:
*On-device Visual Perception for Light-weight Browser Agents* (ISRO).

## Architecture

```
┌─────────────────────── CLIENT (Extension) ───────────────────────┐
│                                                                  │
│  Side Panel ──task──▶ Service Worker ──▶ Planning Loop           │
│       ▲                     │                                    │
│       └── events ───────────┘                                    │
│                              │                                   │
│  Content Script              │                                   │
│  ├── perceive.ts (DOM)      │                                    │
│  ├── screenshot.ts (tab capture)                                │
│  ├── pii-detector.ts (on-device: face + credential)             │
│  ├── redaction.ts (canvas blur/mask)                            │
│  └── act.ts (real input replay)                                 │
│                                                                  │
│  Vision Pipeline (WebGPU / ONNX Runtime Web)                    │
│  ├── MobileNet ViT — screen understanding                       │
│  ├── Transformers.js — local tokenization                       │
│  └── On-device PII classification                               │
│                                                                  │
│  Offscreen Document (for WebGPU inference)                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                   Sanitized screenshot + DOM context
                              │
                              ▼
┌─────────────────────── SERVER ───────────────────────────────────┐
│  Express/Fastify server with                                    │
│  ├── VLM (Qwen2-VL / LLaVA) — understands sanitized visuals    │
│  ├── Action planner — returns UI commands                       │
│  └── Never sees unredacted data                                 │
└──────────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install && npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder.

Open the extension's **Details → Extension options**, pick a provider, and paste
its API key. Keys live in `chrome.storage.local` and are only ever sent to the
provider you selected.

| Provider | Key from | Notes |
|---|---|---|
| Anthropic | console.anthropic.com | Native tool-use. |
| OpenAI | platform.openai.com | Chat Completions with function calling. |
| OpenRouter | openrouter.ai | One key, 400+ models across vendors. |
| VLESS Server | Self-hosted | Privacy-preserving VLM processing. |

Click the toolbar icon to open the side panel, then give it a task.

During development, `npm run dev` rebuilds on save; hit the reload icon on the
extension card to pick up changes.

## How it works

### Perception Layer (Dual-Channel)

1. **DOM Perception** (`perceive.ts`): Flattens the page into numbered interactive
   elements with accessible names. This is the primary channel — fast, structured,
   and PII-aware.

2. **Visual Perception** (`screenshot.ts`): Captures the visible tab via
   `chrome.tabs.captureVisibleTab`, sends it to the offscreen document for
   on-device processing.

### Privacy Pipeline

Every piece of data that might cross a network boundary goes through:

1. **PII Detection** (`pii-detector.ts`):
   - **Face detection**: TensorFlow.js Face Landmarks Detection model
   - **Credential scanning**: Regex patterns for passwords, API keys, card numbers
   - **ID number detection**: Aadhaar, PAN, SSN, passport patterns
   - **DOM-based PII**: Labels, placeholders, and values matching sensitive patterns

2. **Redaction Engine** (`redaction.ts`):
   - Canvas-based Gaussian blur over detected face regions
   - Black-out masking for credential fields and ID numbers
   - Semantic obfuscation (replacing text with placeholders)
   - All redaction happens client-side before any network request

3. **Tokenization** (`tokenize.ts`):
   - Sensitive values are replaced with `<ORG_3>`, `<PERSON_5>` tokens
   - Token↔value vault held in memory only (never persisted)
   - Server can reference tokens but never resolve them

### Vision Model (On-Device)

Runs via WebGPU through ONNX Runtime Web in an offscreen document:

- **MobileNet ViT** — lightweight visual transformer for screen understanding
- **Transformers.js** — local tokenizer for text processing
- **TensorFlow.js Face Detection** — real-time face detection for redaction

### Server Component

The VLESS server (`/server`) receives only sanitized data:

- Redacted screenshots (faces blurred, credentials blacked)
- Tokenized DOM context (PII replaced with opaque tokens)
- Returns actionable commands: click, type, scroll, navigate

## Layout

```
src/
  manifest.json
  background/
    service-worker.ts    message routing, transcript, run lifecycle
    agent.ts             the perceive → plan → act → verify loop
    providers/
      types.ts           provider-neutral messages, tools, and turns
      anthropic.ts       content blocks ⇄ canonical
      openai.ts          tool_calls ⇄ canonical (OpenAI and OpenRouter)
      index.ts           picks the planner from settings
    tools.ts             the agent's entire action surface
    prompt.ts            system prompt
    executor.ts          routes actions to the page or the tabs API
    safety.ts            credential refusal, confirmation gate, injection detection
    pii-detector.ts      face detection + credential/ID pattern scanning
    redaction.ts         canvas-based blur/mask engine
    tokenizer.ts         PII ↔ opaque token mapping
  content/
    perceive.ts          DOM → numbered element list
    screenshot.ts        tab capture → offscreen processing
    act.ts               element id → real user input
    content.ts           message handler
  offscreen/
    index.html           offscreen document for WebGPU inference
    vision.ts            ONNX/ViT model runner
  sidepanel/             transcript UI
  options/               provider, keys, model, preferences, server config
  shared/
    types.ts             wire types and settings
    models.ts            provider catalogue and live model listing
  server/                Express server with VLM
    index.ts
    vlm.ts               VLM inference pipeline
    routes.ts            API endpoints
```

## Privacy Guarantees

- **No screenshots leave the device unredacted** — face detection + PII masking
  happens in the offscreen document before any network request
- **Server never sees raw credentials** — DOM tokenization replaces all sensitive
  values with opaque tokens before transmission
- **Token vault is ephemeral** — lives in memory only, never persisted to storage
- **Local inference first** — ViT model processes screen state on-device; only
  structured, sanitized context reaches the server
- **Gate runs before every action** — credential fields are blocked at code level,
  not just prompt level

## What it will not do

Refused in code, regardless of what the task says:

- Typing into password, CVV, card-number, OTP, Aadhaar, PAN, or API-key fields
- Typing a value that pattern-matches a key or a card number
- Sending unredacted screenshots to the server

Paused for your approval (when *Ask before anything irreversible* is on):

- Clicking anything labelled buy, pay, send, post, delete, confirm, subscribe,
  sign up, or accept
- Submitting a form that isn't a search

## Known limits

- One frame per tab — the content script does not run in iframes
- Chrome's own pages (`chrome://`, the Web Store) are off limits
- Face detection accuracy depends on lighting and angle in screenshots
- WebGPU availability varies by browser/OS
