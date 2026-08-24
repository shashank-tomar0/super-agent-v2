import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ─── DOM References ────────────────────────────────────────────────────────

const providerList = $("provider-list");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const modelEl = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("model-list");
const modelStatus = $("model-status");
const maxStepsEl = $<HTMLInputElement>("maxSteps");
const confirmRiskyEl = $<HTMLInputElement>("confirmRisky");
const refreshBtn = $<HTMLButtonElement>("refresh-models");
const savedEl = $("saved");
const activeModelDisplay = $("active-model-display");
const activeProviderBadge = $("active-provider-badge");

// Privacy elements
const blurFacesEl = $<HTMLInputElement>("blurFaces");
const maskCredentialsEl = $<HTMLInputElement>("maskCredentials");
const tokenizePIIEl = $<HTMLInputElement>("tokenizePII");
const showRedactionLabelsEl = $<HTMLInputElement>("showRedactionLabels");

// Server elements
const serverEnabledEl = $<HTMLInputElement>("serverEnabled");
const serverUrlEl = $<HTMLInputElement>("serverUrl");
const serverApiKeyEl = $<HTMLInputElement>("serverApiKey");

// ─── State ─────────────────────────────────────────────────────────────────

let settings: Settings = normaliseSettings(undefined);
const fetched = new Map<ProviderId, string[]>();

// ─── Provider List Rendering ───────────────────────────────────────────────

function renderProviderList(): void {
  providerList.innerHTML = "";

  for (const id of PROVIDER_IDS) {
    const info = PROVIDERS[id];
    const isActive = settings.provider === id;
    const hasKey = Boolean(settings.apiKeys[id]);

    const item = document.createElement("div");
    item.className = `provider-item ${isActive ? "active" : ""}`;
    item.innerHTML = `
      <div class="provider-radio"></div>
      <div class="provider-info">
        <div class="provider-name">${info.label}</div>
        <div class="provider-model">${settings.models[id] ?? info.defaultModel}</div>
      </div>
      <div class="provider-badge ${hasKey ? "enabled" : "disabled"}">${hasKey ? "ENABLED" : "DISABLED"}</div>
    `;

    item.addEventListener("click", () => {
      settings.provider = id;
      renderAll();
    });

    providerList.appendChild(item);
  }
}

// ─── Full Render ───────────────────────────────────────────────────────────

function renderAll(): void {
  const provider = PROVIDERS[settings.provider];

  // Active planner display.
  activeModelDisplay.textContent = `${settings.models[settings.provider] ?? provider.defaultModel}`;
  activeProviderBadge.textContent = provider.label.toUpperCase();

  // Provider list.
  renderProviderList();

  // API key & model.
  apiKeyEl.value = settings.apiKeys[settings.provider] ?? "";
  apiKeyEl.placeholder = provider.keyHint;
  modelEl.value = settings.models[settings.provider] ?? provider.defaultModel;

  // Hint.
  const hint = $("provider-hint");
  hint.innerHTML = `Get a key at <a href="${provider.keyUrl}" target="_blank" style="color: var(--accent);">${new URL(provider.keyUrl).host}</a>.`;

  // Agent config.
  maxStepsEl.value = String(settings.maxSteps);
  confirmRiskyEl.checked = settings.confirmRisky;

  // Privacy.
  blurFacesEl.checked = settings.privacy.blurFaces;
  maskCredentialsEl.checked = settings.privacy.maskCredentials;
  tokenizePIIEl.checked = settings.privacy.tokenizePII;
  showRedactionLabelsEl.checked = settings.privacy.showRedactionLabels;

  // Server.
  serverEnabledEl.checked = settings.server.enabled;
  serverUrlEl.value = settings.server.url;
  serverApiKeyEl.value = settings.server.apiKey;

  // Model datalist.
  renderModelOptions();
}

function renderModelOptions(): void {
  const provider = PROVIDERS[settings.provider];
  const options = fetched.get(settings.provider) ?? provider.suggested;
  modelList.innerHTML = "";
  for (const id of options) {
    const option = document.createElement("option");
    option.value = id;
    modelList.appendChild(option);
  }
}

// ─── Capture Fields ────────────────────────────────────────────────────────

function captureFields(): void {
  settings.apiKeys[settings.provider] = apiKeyEl.value.trim();
  settings.models[settings.provider] = modelEl.value.trim();
  settings.server.enabled = serverEnabledEl.checked;
  settings.server.url = serverUrlEl.value.trim() || "http://localhost:3001";
  settings.server.apiKey = serverApiKeyEl.value.trim();
  settings.privacy.blurFaces = blurFacesEl.checked;
  settings.privacy.maskCredentials = maskCredentialsEl.checked;
  settings.privacy.tokenizePII = tokenizePIIEl.checked;
  settings.privacy.showRedactionLabels = showRedactionLabelsEl.checked;
}

// ─── Event Listeners ───────────────────────────────────────────────────────

refreshBtn.addEventListener("click", async () => {
  const provider = settings.provider;
  refreshBtn.disabled = true;
  modelStatus.textContent = "Fetching…";
  modelStatus.className = "status-msg";

  try {
    const models = await listModels(provider, apiKeyEl.value.trim());
    fetched.set(provider, models);
    renderModelOptions();
    modelStatus.textContent = `${models.length} models available.`;
    modelStatus.className = "status-msg ok";
  } catch (error) {
    modelStatus.textContent = error instanceof Error ? error.message : "Could not fetch models.";
    modelStatus.className = "status-msg bad";
  } finally {
    refreshBtn.disabled = false;
  }
});

$("save").addEventListener("click", async () => {
  captureFields();
  settings.maxSteps = Math.min(200, Math.max(5, Number(maxStepsEl.value) || 40));
  settings.confirmRisky = confirmRiskyEl.checked;

  if (!settings.apiKeys[settings.provider]) {
    savedEl.className = "status-msg bad";
    savedEl.textContent = `Add a ${PROVIDERS[settings.provider].label} key before saving.`;
    return;
  }

  await chrome.storage.local.set({ settings });
  savedEl.className = "status-msg ok";
  savedEl.textContent = "✓ SAVED";
  setTimeout(() => (savedEl.textContent = ""), 2000);
});

$("close").addEventListener("click", () => window.close());

// ─── Initialize ────────────────────────────────────────────────────────────

void (async () => {
  const stored = await chrome.storage.local.get("settings");
  settings = normaliseSettings(stored.settings);
  renderAll();
})();
