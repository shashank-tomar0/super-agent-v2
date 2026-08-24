import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ─── LLM Provider Elements ──────────────────────────────────────────────────

const tabsEl = $("provider-tabs");
const providerHint = $("provider-hint");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const modelEl = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("model-list");
const modelStatus = $("model-status");
const maxStepsEl = $<HTMLInputElement>("maxSteps");
const confirmRiskyEl = $<HTMLInputElement>("confirmRisky");
const refreshBtn = $<HTMLButtonElement>("refresh-models");

// ─── Server Elements ────────────────────────────────────────────────────────

const serverEnabledEl = $<HTMLInputElement>("serverEnabled");
const serverUrlEl = $<HTMLInputElement>("serverUrl");
const serverApiKeyEl = $<HTMLInputElement>("serverApiKey");
const serverStatusEl = $("server-status");

// ─── Privacy Elements ───────────────────────────────────────────────────────

const blurFacesEl = $<HTMLInputElement>("blurFaces");
const maskCredentialsEl = $<HTMLInputElement>("maskCredentials");
const tokenizePIIEl = $<HTMLInputElement>("tokenizePII");
const showRedactionLabelsEl = $<HTMLInputElement>("showRedactionLabels");
const privacyStatusEl = $("privacy-status");

const savedEl = $("saved");

/** Working copy. Edits to the visible fields are folded in on provider switch. */
let settings: Settings = normaliseSettings(undefined);

/** Live model lists, per provider, once fetched. */
const fetched = new Map<ProviderId, string[]>();

function captureVisibleFields(): void {
  settings.apiKeys[settings.provider] = apiKeyEl.value.trim();
  settings.models[settings.provider] = modelEl.value.trim();

  // Server settings.
  settings.server.enabled = serverEnabledEl.checked;
  settings.server.url = serverUrlEl.value.trim() || "http://localhost:3001";
  settings.server.apiKey = serverApiKeyEl.value.trim();

  // Privacy settings.
  settings.privacy.blurFaces = blurFacesEl.checked;
  settings.privacy.maskCredentials = maskCredentialsEl.checked;
  settings.privacy.tokenizePII = tokenizePIIEl.checked;
  settings.privacy.showRedactionLabels = showRedactionLabelsEl.checked;
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

function updateStatusBadges(): void {
  serverStatusEl.textContent = settings.server.enabled ? "ON" : "OFF";
  serverStatusEl.className = `status-badge ${settings.server.enabled ? "active" : "inactive"}`;

  const anyPrivacyOn =
    settings.privacy.blurFaces ||
    settings.privacy.maskCredentials ||
    settings.privacy.tokenizePII;
  privacyStatusEl.textContent = anyPrivacyOn ? "ACTIVE" : "OFF";
  privacyStatusEl.className = `status-badge ${anyPrivacyOn ? "active" : "inactive"}`;
}

function render(): void {
  const provider = PROVIDERS[settings.provider];

  // LLM provider.
  tabsEl.querySelectorAll("button").forEach((button) => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.provider === settings.provider),
    );
  });

  providerHint.innerHTML =
    `Get a key at <a href="${provider.keyUrl}" target="_blank" rel="noreferrer">` +
    `${new URL(provider.keyUrl).host}</a>.` +
    (provider.id === "openrouter"
      ? " OpenRouter proxies many vendors' models behind one key."
      : "");

  apiKeyEl.value = settings.apiKeys[provider.id] ?? "";
  apiKeyEl.placeholder = provider.keyHint;
  modelEl.value = settings.models[provider.id] ?? provider.defaultModel;
  maxStepsEl.value = String(settings.maxSteps);
  confirmRiskyEl.checked = settings.confirmRisky;

  // Server.
  serverEnabledEl.checked = settings.server.enabled;
  serverUrlEl.value = settings.server.url;
  serverApiKeyEl.value = settings.server.apiKey;

  // Privacy.
  blurFacesEl.checked = settings.privacy.blurFaces;
  maskCredentialsEl.checked = settings.privacy.maskCredentials;
  tokenizePIIEl.checked = settings.privacy.tokenizePII;
  showRedactionLabelsEl.checked = settings.privacy.showRedactionLabels;

  renderModelOptions();
  updateStatusBadges();
}

// ─── Provider Tab Generation ────────────────────────────────────────────────

for (const id of PROVIDER_IDS) {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "tab";
  button.dataset.provider = id;
  button.textContent = PROVIDERS[id].label;
  button.addEventListener("click", () => {
    captureVisibleFields();
    settings.provider = id;
    modelStatus.textContent = "";
    render();
  });
  tabsEl.appendChild(button);
}

// ─── Event Listeners ────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", async () => {
  const provider = settings.provider;
  refreshBtn.disabled = true;
  modelStatus.textContent = "Fetching…";

  try {
    const models = await listModels(provider, apiKeyEl.value.trim());
    fetched.set(provider, models);
    renderModelOptions();
    modelStatus.textContent = `${models.length} models available. Click the field to browse them.`;
  } catch (error) {
    modelStatus.textContent =
      error instanceof Error ? `Could not fetch: ${error.message}` : "Could not fetch models.";
  } finally {
    refreshBtn.disabled = false;
  }
});

// Toggle handlers for status badges.
serverEnabledEl.addEventListener("change", updateStatusBadges);
blurFacesEl.addEventListener("change", updateStatusBadges);
maskCredentialsEl.addEventListener("change", updateStatusBadges);
tokenizePIIEl.addEventListener("change", updateStatusBadges);
showRedactionLabelsEl.addEventListener("change", updateStatusBadges);

$("save").addEventListener("click", async () => {
  captureVisibleFields();
  settings.maxSteps = Math.min(200, Math.max(5, Number(maxStepsEl.value) || 40));
  settings.confirmRisky = confirmRiskyEl.checked;

  if (!settings.apiKeys[settings.provider]) {
    savedEl.className = "bad";
    savedEl.textContent = `Add a ${PROVIDERS[settings.provider].label} key before saving.`;
    return;
  }

  await chrome.storage.local.set({ settings });
  savedEl.className = "ok";
  savedEl.textContent = "Saved";
  setTimeout(() => (savedEl.textContent = ""), 1800);
});

// ─── Initialize ─────────────────────────────────────────────────────────────

void (async () => {
  const stored = await chrome.storage.local.get("settings");
  settings = normaliseSettings(stored.settings);
  render();
})();
