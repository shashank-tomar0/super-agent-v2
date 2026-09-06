var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/shared/checksums.ts
var checksums_exports = {};
__export(checksums_exports, {
  isAadhaarNumber: () => isAadhaarNumber,
  isCardNumber: () => isCardNumber,
  isIndianPhone: () => isIndianPhone,
  luhnValid: () => luhnValid,
  verhoeffCheckDigit: () => verhoeffCheckDigit,
  verhoeffValid: () => verhoeffValid
});
function digitsOnly(value) {
  return value.replace(/\D/g, "");
}
function verhoeffValid(value) {
  const n = digitsOnly(value);
  if (n.length < 2) return false;
  let c = 0;
  for (let i = n.length - 1, k = 0; i >= 0; i--, k++) {
    c = VERHOEFF_D[c][VERHOEFF_P[k % 8][Number(n[i])]];
  }
  return c === 0;
}
function verhoeffCheckDigit(seed) {
  const n = digitsOnly(seed);
  let c = 0;
  for (let i = n.length - 1, k = 1; i >= 0; i--, k++) {
    c = VERHOEFF_D[c][VERHOEFF_P[k % 8][Number(n[i])]];
  }
  return VERHOEFF_INV[c];
}
function isAadhaarNumber(value) {
  const n = digitsOnly(value);
  if (n.length !== 12) return false;
  if (n[0] === "0" || n[0] === "1") return false;
  return verhoeffValid(n);
}
function luhnValid(value) {
  const n = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(n)) return false;
  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
function isCardNumber(value) {
  return luhnValid(value);
}
function isIndianPhone(value) {
  const n = digitsOnly(value);
  return n.length === 10 && /^[6-9]/.test(n) && /^[6-9]\d{9}$/.test(n);
}
var VERHOEFF_D, VERHOEFF_P, VERHOEFF_INV;
var init_checksums = __esm({
  "src/shared/checksums.ts"() {
    "use strict";
    VERHOEFF_D = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
      [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
      [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
      [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
      [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
      [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
      [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    ];
    VERHOEFF_P = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
      [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
      [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
      [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
      [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
      [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
    ];
    VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
  }
});

// src/background/pii-detector.ts
var pii_detector_exports = {};
__export(pii_detector_exports, {
  detectAllPII: () => detectAllPII,
  detectAllPIIDetailed: () => detectAllPIIDetailed,
  detectDOMPII: () => detectDOMPII,
  detectFaces: () => detectFaces,
  detectTextPII: () => detectTextPII,
  detectTextPIIDetailed: () => detectTextPIIDetailed
});
async function getFaceDetector() {
  if (faceDetectorInstance) return faceDetectorInstance;
  if (typeof FaceDetector !== "undefined") {
    try {
      faceDetectorInstance = new FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
      return faceDetectorInstance;
    } catch {
    }
  }
  return void 0;
}
async function detectFaces(image, imageWidth, imageHeight) {
  const results = [];
  const detector = await getFaceDetector();
  if (!detector) {
    return results;
  }
  try {
    const faces = await detector.detect(image);
    for (const face of faces) {
      const box = face.boundingBox;
      results.push({
        kind: "face",
        box: {
          x: box.x / imageWidth,
          y: box.y / imageHeight,
          width: box.width / imageWidth,
          height: box.height / imageHeight
        },
        confidence: face.names.length > 0 ? 0.95 : 0.7,
        label: "Face detected"
      });
    }
  } catch {
  }
  return results;
}
function detectDOMPII(snapshot) {
  const results = [];
  for (const el of snapshot.elements) {
    const haystack = `${el.name} ${el.role} ${el.value ?? ""} ${Object.values(el.attrs ?? {}).join(" ")}`;
    for (const { pattern, label } of CREDENTIAL_PATTERNS) {
      if (pattern.test(haystack)) {
        results.push({
          kind: "credential",
          value: el.value,
          elementSelector: `[data-vless-id="${el.id}"]`,
          confidence: 0.9,
          label
        });
        break;
      }
    }
    if (el.value) {
      for (const { pattern, label } of API_KEY_PATTERNS) {
        if (pattern.test(el.value)) {
          results.push({
            kind: "api_key",
            value: el.value,
            elementSelector: `[data-vless-id="${el.id}"]`,
            confidence: 0.95,
            label
          });
          break;
        }
      }
      if (CARD_NUMBER_PATTERN.test(el.value)) {
        const cardish = /card|credit|debit|cc[-_\s]|card_/i.test(haystack);
        if (cardish || isCardNumber(el.value)) {
          results.push({
            kind: "credential",
            value: el.value,
            elementSelector: `[data-vless-id="${el.id}"]`,
            confidence: cardish ? 0.9 : 0.85,
            label: cardish ? "Card number in card field" : "Card number (Luhn valid)"
          });
        }
      }
    }
  }
  return results;
}
function detectTextPIIDetailed(text) {
  const detections = [];
  const rejected = [];
  const patterns = [
    ...INDIAN_ID_PATTERNS.map((p) => {
      const isAadhaar = p.label === "Possible Aadhaar number";
      return {
        pattern: p.pattern,
        kind: "id_number",
        label: isAadhaar ? "Aadhaar number (Verhoeff \u2713)" : p.label,
        validate: isAadhaar ? (m) => isAadhaarNumber(m) : void 0
      };
    }),
    ...INTERNATIONAL_ID_PATTERNS.map((p) => ({ pattern: p.pattern, kind: "id_number", label: p.label })),
    { pattern: EMAIL_PATTERN, kind: "credential", label: "Email address" },
    { pattern: PHONE_PATTERN, kind: "credential", label: "Phone number" }
  ];
  for (const { pattern, kind, label, validate } of patterns) {
    const globalRegex = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
    const matches = text.matchAll(globalRegex);
    for (const match of matches) {
      if (match.index === void 0) continue;
      if (validate && !validate(match[0])) {
        rejected.push({
          kind,
          value: match[0],
          confidence: 0.15,
          label: `${label} lookalike (checksum failed)`
        });
        continue;
      }
      detections.push({
        kind,
        value: match[0],
        confidence: kind === "credential" ? 0.9 : 0.7,
        label
      });
    }
  }
  return { detections, rejected };
}
function detectTextPII(text) {
  return detectTextPIIDetailed(text).detections;
}
function detectAllPIIDetailed(snapshot, faceDetections = []) {
  const text = detectTextPIIDetailed(snapshot.text);
  return {
    detections: [...faceDetections, ...detectDOMPII(snapshot), ...text.detections],
    rejected: text.rejected
  };
}
function detectAllPII(snapshot, faceDetections = []) {
  return detectAllPIIDetailed(snapshot, faceDetections).detections;
}
var faceDetectorInstance, CREDENTIAL_PATTERNS, API_KEY_PATTERNS, INDIAN_ID_PATTERNS, INTERNATIONAL_ID_PATTERNS, CARD_NUMBER_PATTERN, EMAIL_PATTERN, PHONE_PATTERN;
var init_pii_detector = __esm({
  "src/background/pii-detector.ts"() {
    "use strict";
    init_checksums();
    CREDENTIAL_PATTERNS = [
      { pattern: /\bpassword\b/i, label: "Password field" },
      { pattern: /\bpasscode\b/i, label: "Passcode field" },
      { pattern: /\bcvv\b/i, label: "CVV field" },
      { pattern: /\bcvc\b/i, label: "CVC field" },
      { pattern: /\bcard\s*number\b/i, label: "Card number field" },
      { pattern: /\bcredit\s*card\b/i, label: "Credit card field" },
      { pattern: /\bdebit\s*card\b/i, label: "Debit card field" },
      { pattern: /\bexpiry\b/i, label: "Expiry field" },
      { pattern: /\botp\b/i, label: "OTP field" },
      { pattern: /\bone[-\s]?time\s*(code|password)\b/i, label: "One-time code field" },
      { pattern: /\bsecret\b/i, label: "Secret field" },
      { pattern: /\bapi[-\s]?key\b/i, label: "API key field" }
    ];
    API_KEY_PATTERNS = [
      { pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
      { pattern: /^sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
      { pattern: /^ghp_[a-zA-Z0-9]{36}/, label: "GitHub personal access token" },
      { pattern: /^gho_[a-zA-Z0-9]{36}/, label: "GitHub OAuth token" },
      { pattern: /^ghs_[a-zA-Z0-9]{36}/, label: "GitHub server-to-server token" },
      { pattern: /^xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack token" },
      { pattern: /^AKIA[0-9A-Z]{16}/, label: "AWS access key" },
      { pattern: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./, label: "JWT token" }
    ];
    INDIAN_ID_PATTERNS = [
      // Aadhaar: 12 digits, may be grouped as XXXX XXXX XXXX
      { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: "Possible Aadhaar number" },
      // PAN: 5 letters + 4 digits + 1 letter
      { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card number" },
      // IFSC code
      { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" }
    ];
    INTERNATIONAL_ID_PATTERNS = [
      // SSN: XXX-XX-XXXX
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
      // Passport: 1-2 letters + 6-8 digits (simplified)
      { pattern: /\b[A-Z]{1,2}\d{6,8}\b/, label: "Possible passport number" }
    ];
    CARD_NUMBER_PATTERN = /\b(?:\d{4}[\s-]?){3}\d{4}\b/;
    EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
    PHONE_PATTERN = /\b(\+91[\s-]?)?[6-9]\d{9}\b/;
  }
});

// src/background/contextual-pii.ts
var contextual_pii_exports = {};
__export(contextual_pii_exports, {
  contextualToDetectedPII: () => contextualToDetectedPII,
  detectContextualPII: () => detectContextualPII
});
function looksLikePersonName(value) {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const nameWordPattern = /^([A-Z][a-z]+|[A-Z]\.?)$/;
  const prefixWords = /^(Mr|Mrs|Ms|Dr|Prof|Shri|Smt|Kumari|Sir|Madam)\.?$/i;
  let nameWords = 0;
  for (const word of words) {
    if (prefixWords.test(word) || nameWordPattern.test(word)) {
      nameWords++;
    }
  }
  return nameWords / words.length >= 0.7;
}
function looksLikeOrgName(value) {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 100) return false;
  const orgSuffixes = /\b(Inc|LLC|Ltd|Pvt|Corp|Co|Company|Solutions|Technologies|Tech|Services|Group|Associates|Partners|Enterprises|Stores|Traders|Trading)\b/i;
  if (orgSuffixes.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 6) {
    const hasNoDigits = !/\d/.test(trimmed);
    const allTitleCase = words.every((w) => /^[A-Z]/.test(w));
    if (hasNoDigits && allTitleCase) return true;
  }
  return false;
}
function looksLikeAddress(value) {
  const trimmed = value.trim();
  if (trimmed.length < 10 || trimmed.length > 200) return false;
  const addressIndicators = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|circle|way|nagar|colony|sector|block|floor|flat|apt|suite|building|house|no\.|number)\b/i;
  const hasNumbers = /\d/.test(trimmed);
  const hasComma = /,/.test(trimmed);
  return addressIndicators.test(trimmed) && hasNumbers && hasComma;
}
function looksLikePhoneInContext(value) {
  const trimmed = value.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{7,15}$/.test(trimmed)) return false;
  if (/^(\+?91)?[6-9]\d{9}$/.test(trimmed)) return true;
  if (/^1?\d{10}$/.test(trimmed)) return true;
  if (/^\d{8,12}$/.test(trimmed)) return true;
  return false;
}
function detectContextualPII(snapshot) {
  const results = [];
  for (const el of snapshot.elements) {
    if (!el.value || el.value.length < 2) continue;
    const haystack = `${el.name} ${el.role} ${JSON.stringify(el.attrs ?? {})}`.toLowerCase();
    const value = el.value;
    for (const { pattern, label, kind } of NAME_FIELD_PATTERNS) {
      if (pattern.test(haystack)) {
        if (kind === "person" && looksLikePersonName(value)) {
          results.push({ kind: "person", value, confidence: 0.85, label, elementId: el.id });
          break;
        }
        if (kind === "organization" && looksLikeOrgName(value)) {
          results.push({ kind: "organization", value, confidence: 0.8, label, elementId: el.id });
          break;
        }
      }
    }
    for (const { pattern, label } of ADDRESS_FIELD_PATTERNS) {
      if (pattern.test(haystack) && looksLikeAddress(value)) {
        results.push({ kind: "address", value, confidence: 0.8, label, elementId: el.id });
        break;
      }
    }
    for (const { pattern, label, kind } of CONTACT_FIELD_PATTERNS) {
      if (pattern.test(haystack)) {
        if (kind === "phone" && looksLikePhoneInContext(value)) {
          results.push({ kind: "phone", value, confidence: 0.85, label, elementId: el.id });
          break;
        }
        if (kind === "email" && value.includes("@") && value.includes(".")) {
          results.push({ kind: "email", value, confidence: 0.9, label, elementId: el.id });
          break;
        }
      }
    }
    for (const { pattern, label } of FINANCIAL_FIELD_PATTERNS) {
      if (pattern.test(haystack) && /\d/.test(value) && value.replace(/\D/g, "").length >= 8) {
        results.push({ kind: "financial", value, confidence: 0.85, label, elementId: el.id });
        break;
      }
    }
  }
  const nameKeywordPattern = /\b(from|to|sender|recipient|addressed to|sent by|name|company)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
  let match;
  while ((match = nameKeywordPattern.exec(snapshot.text)) !== null) {
    const name = match[2];
    if (looksLikePersonName(name)) {
      if (!results.some((r) => r.value === name)) {
        results.push({ kind: "person", value: name, confidence: 0.7, label: "Name in page text" });
      }
    }
  }
  return results;
}
function contextualToDetectedPII(detections) {
  return detections.map((d) => ({
    kind: d.kind === "person" || d.kind === "organization" ? "pii_text" : d.kind === "phone" || d.kind === "email" ? "credential" : d.kind === "address" ? "pii_text" : "credential",
    value: d.value,
    elementSelector: d.elementId !== void 0 ? `[data-vless-id="${d.elementId}"]` : void 0,
    confidence: d.confidence,
    label: d.label
  }));
}
var NAME_FIELD_PATTERNS, ADDRESS_FIELD_PATTERNS, CONTACT_FIELD_PATTERNS, FINANCIAL_FIELD_PATTERNS;
var init_contextual_pii = __esm({
  "src/background/contextual-pii.ts"() {
    "use strict";
    NAME_FIELD_PATTERNS = [
      { pattern: /\b(name|full\s*name|your\s*name|first\s*name|last\s*name|sender|from|recipient|to)\b/i, label: "Name field", kind: "person" },
      { pattern: /\b(company|organization|business|firm|vendor|supplier|client|employer)\b/i, label: "Organization field", kind: "organization" },
      { pattern: /\b(card\s*holder|account\s*holder|beneficiary)\b/i, label: "Account holder field", kind: "person" },
      { pattern: /\b(МЕСТО|Имя|ФИО)\b/, label: "Russian name field", kind: "person" }
    ];
    ADDRESS_FIELD_PATTERNS = [
      { pattern: /\b(address|street|city|state|zip|postal|country|billing|shipping|location)\b/i, label: "Address field" },
      { pattern: /\b(landmark|area|district|pin\s*code)\b/i, label: "Indian address field" }
    ];
    CONTACT_FIELD_PATTERNS = [
      { pattern: /\b(phone|mobile|tel|contact|cell|fax)\b/i, label: "Phone field", kind: "phone" },
      { pattern: /\b(email|e-mail|mail)\b/i, label: "Email field", kind: "email" }
    ];
    FINANCIAL_FIELD_PATTERNS = [
      { pattern: /\b(account|iban|routing|sort\s*code|bic|swift)\b/i, label: "Bank account field" },
      { pattern: /\b(card|credit|debit|visa|mastercard|amex)\b/i, label: "Card field" },
      { pattern: /\b(expiry|exp|valid\s*thru|cvc|cvv|cvv2)\b/i, label: "Card detail field" }
    ];
  }
});

// src/background/tokenizer.ts
var tokenizer_exports = {};
__export(tokenizer_exports, {
  PIITokenizer: () => PIITokenizer,
  maskSample: () => maskSample,
  tokenizer: () => tokenizer
});
function maskSample(value) {
  const v = String(value).trim();
  if (v.length === 0) return "\u2022\u2022";
  if (v.length <= 2) return "\u2022".repeat(Math.max(2, v.length));
  const at = v.indexOf("@");
  if (at > 0 && v.includes(".") && v.length > at + 2) {
    const local = v.slice(0, at);
    const domain2 = v.slice(at + 1);
    return `${local.slice(0, 2)}\u2022\u2022\u2022@${domain2}`;
  }
  const hasLetters = /[A-Za-z]/.test(v);
  const digitCount = (v.match(/\d/g) ?? []).length;
  const alnumCount = (v.match(/[A-Za-z0-9]/g) ?? []).length;
  if (hasLetters && digitCount > 0 && alnumCount >= 6 && !/\s/.test(v.trim())) {
    return maskAlnum(v);
  }
  if (digitCount >= 4) {
    return maskDigits(v);
  }
  return `${v.slice(0, 2)}${"\u2022".repeat(Math.min(10, Math.max(6, v.length - 2)))}`;
}
function maskDigits(value) {
  let out = "";
  for (const ch of value) {
    out += /\d/.test(ch) ? "\u2022" : ch;
  }
  return out;
}
function maskAlnum(value) {
  let out = "";
  for (const ch of value) {
    out += /[A-Za-z0-9]/.test(ch) ? "\u2022" : ch;
  }
  return out;
}
var TOKEN_PREFIXES, PIITokenizer, tokenizer;
var init_tokenizer = __esm({
  "src/background/tokenizer.ts"() {
    "use strict";
    TOKEN_PREFIXES = {
      face: "FACE",
      credential: "CRED",
      id_number: "ID",
      api_key: "KEY",
      pii_text: "PII"
    };
    PIITokenizer = class {
      vault = /* @__PURE__ */ new Map();
      counters = {};
      /**
       * Generate a unique token for a value.
       * If the value was already tokenized, return the existing token.
       */
      tokenize(value, kind) {
        const existing = this.findToken(value);
        if (existing) return existing.token;
        const prefix = TOKEN_PREFIXES[kind] ?? "PII";
        const count = (this.counters[prefix] ?? 0) + 1;
        this.counters[prefix] = count;
        const token = `<${prefix}_${count}>`;
        this.vault.set(token, {
          token,
          original: value,
          kind,
          createdAt: Date.now()
        });
        return token;
      }
      /**
       * Resolve a token back to its original value.
       * Only called at the last possible moment before executing an action.
       */
      resolve(token) {
        return this.vault.get(token)?.original;
      }
      /**
       * Check if a string contains any tokens.
       */
      containsTokens(text) {
        return /<[A-Z]+_\d+>/.test(text);
      }
      /**
       * Replace all tokens in a string with their original values.
       * Used when the server returns a command that references tokenized data.
       */
      resolveAll(text) {
        return text.replace(/<[A-Z]+_\d+>/g, (match) => {
          return this.resolve(match) ?? match;
        });
      }
      /**
       * Find the token for a value (reverse lookup).
       */
      findToken(value) {
        for (const entry of this.vault.values()) {
          if (entry.original === value) return entry;
        }
        return void 0;
      }
      /**
       * Tokenize all detected PII in a snapshot's elements and text.
       * Returns a new snapshot with tokens in place of sensitive values.
       */
      tokenizeSnapshot(snapshot) {
        let tokenCount = 0;
        const elements = snapshot.elements.map((el) => {
          const newEl = { ...el };
          if (newEl.value && this.shouldTokenizeValue(newEl)) {
            newEl.value = this.tokenize(newEl.value, "credential");
            tokenCount++;
          }
          return newEl;
        });
        let text = snapshot.text;
        const idPatterns = [
          { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, kind: "id_number" },
          { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, kind: "id_number" },
          { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "id_number" }
        ];
        for (const { pattern, kind } of idPatterns) {
          text = text.replace(pattern, (match) => {
            tokenCount++;
            return this.tokenize(match, kind);
          });
        }
        return { ...snapshot, elements, text, tokenCount };
      }
      /**
       * Tokenize values that the detectors actually flagged.
       *
       * Detection and tokenization were previously disconnected: the detectors
       * found names/emails/phones in fields and ID numbers in text, but the
       * tokenizer only knew about password-role inputs and its own hardcoded ID
       * patterns. As a result the vault stayed empty and the audit had no tokens
       * to show even when PII was found.
       *
       * This closes that gap: every detection with a value gets that value
       * replaced by a vault token (in its element and/or in the page text).
       */
      tokenizeDetections(snapshot, detections) {
        const TOKEN_RE = /^<[A-Z]+_\d+>$/;
        const elements = snapshot.elements.map((el) => ({ ...el }));
        let text = snapshot.text;
        let tokenCount = 0;
        const elementsById = new Map(elements.map((el) => [el.id, el]));
        for (const det of detections) {
          if (!det.value || det.kind === "face") continue;
          const val = det.value;
          if (TOKEN_RE.test(val)) continue;
          const tokenKind = det.kind === "pii_text" || det.kind === "person" || det.kind === "organization" ? "pii_text" : det.kind === "id_number" || det.kind === "api_key" || det.kind === "credential" ? det.kind : "credential";
          const token = this.tokenize(val, tokenKind);
          let replacedAny = false;
          const selMatch = det.elementSelector?.match(/data-vless-id="(\d+)"/);
          if (selMatch) {
            const el = elementsById.get(parseInt(selMatch[1], 10));
            if (el && el.value && el.value.includes(val) && !TOKEN_RE.test(el.value)) {
              el.value = el.value.split(val).join(token);
              replacedAny = true;
            }
          }
          if (val.length >= 4 && text.includes(val)) {
            const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const isAlpha = /^[A-Za-z ]+$/.test(val);
            const bounded = isAlpha ? new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, "g") : new RegExp(escaped, "g");
            const next = text.replace(bounded, (match, lead) => `${lead ?? ""}${token}`);
            if (next !== text) {
              text = next;
              replacedAny = true;
            }
          }
          if (replacedAny) tokenCount++;
        }
        return { ...snapshot, elements, text, tokenCount };
      }
      /**
       * Tokenize PII found in the user's task description.
       * This ensures the LLM sees the same tokens in the task as on screen,
       * so it can match "Sharma Traders" in the task to <ORG_3> on screen.
       */
      tokenizeTask(task) {
        let tokenCount = 0;
        let result = task;
        result = result.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, (match) => {
          tokenCount++;
          return this.tokenize(match, "credential");
        });
        result = result.replace(/(\+91[\s-]?)?\b\d{5}[\s-]?\d{5}\b/g, (match) => {
          tokenCount++;
          return this.tokenize(match, "credential");
        });
        const idPatterns = [
          { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, kind: "id_number" },
          // Aadhaar
          { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, kind: "id_number" },
          // PAN
          { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "id_number" },
          // SSN
          { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, kind: "credential" }
          // Card
        ];
        for (const { pattern, kind } of idPatterns) {
          result = result.replace(pattern, (match) => {
            tokenCount++;
            return this.tokenize(match, kind);
          });
        }
        const namePatterns = [
          { pattern: /\b(from|to|sender|recipient|addressed to|sent by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g, kind: "pii_text" },
          { pattern: /\b(name|company|business|firm|organization|vendor|supplier|client)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g, kind: "pii_text" }
        ];
        for (const { pattern, kind } of namePatterns) {
          result = result.replace(pattern, (match, prefix, name) => {
            tokenCount++;
            const token = this.tokenize(name, kind);
            return `${prefix} ${token}`;
          });
        }
        return { task: result, tokenCount };
      }
      /**
       * Determine if an element's value should be tokenized based on its
       * role and attributes.
       */
      shouldTokenizeValue(el) {
        if (el.role === "password") return true;
        if (el.attrs?.inputType === "password") return true;
        if (el.attrs?.inputType === "hidden") return false;
        const haystack = `${el.role} ${Object.values(el.attrs ?? {}).join(" ")}`;
        return /\b(password|secret|key|token|cvv|otp)\b/i.test(haystack);
      }
      /**
       * Get a summary of all tokenized values (for debugging/demo).
       * Does NOT expose the original values — just the token→kind mapping plus a
       * masked sample ("r•••@gmail.com") so the UI can show what was tokenized.
       */
      getTokenSummary() {
        return Array.from(this.vault.values()).map((entry) => ({
          token: entry.token,
          kind: entry.kind,
          sample: maskSample(entry.original)
        }));
      }
      /**
       * Clear the entire vault. Called when the task ends or the user resets.
       */
      clear() {
        this.vault.clear();
        this.counters = {};
      }
      /**
       * Number of tokens in the vault.
       */
      get size() {
        return this.vault.size;
      }
    };
    tokenizer = new PIITokenizer();
  }
});

// src/background/redaction.ts
var redaction_exports = {};
__export(redaction_exports, {
  blurRegion: () => blurRegion,
  labelRegion: () => labelRegion,
  maskRegion: () => maskRegion,
  pixelateRegion: () => pixelateRegion,
  redactImage: () => redactImage,
  redactSnapshot: () => redactSnapshot,
  redactToBlob: () => redactToBlob
});
function blurRegion(ctx, box, canvasWidth, canvasHeight, radius = 20) {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const w = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const h = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h);
  ctx.restore();
}
function maskRegion(ctx, box, canvasWidth, canvasHeight) {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const w = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const h = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, w, h);
}
function pixelateRegion(ctx, box, canvasWidth, canvasHeight, pixelSize = 10) {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const regionW = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const regionH = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));
  if (regionW <= 0 || regionH <= 0) return;
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d");
  const sw = Math.max(1, Math.round(regionW / pixelSize));
  const sh = Math.max(1, Math.round(regionH / pixelSize));
  tempCanvas.width = sw;
  tempCanvas.height = sh;
  tempCtx.drawImage(ctx.canvas, x, y, regionW, regionH, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tempCanvas, 0, 0, sw, sh, x, y, regionW, regionH);
  ctx.imageSmoothingEnabled = true;
}
function labelRegion(ctx, box, canvasWidth, canvasHeight, label) {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = `bold ${Math.max(10, Math.round(canvasHeight * 0.015))}px system-ui`;
  ctx.textBaseline = "top";
  const textWidth = ctx.measureText(label).width;
  const padding = 4;
  ctx.fillRect(x, y - 18 - padding, textWidth + padding * 2, 18 + padding * 2);
  ctx.fillStyle = "#c8362a";
  ctx.fillText(label, x + padding, y - 18);
  ctx.restore();
}
function redactImage(source, detections, options = DEFAULT_OPTIONS) {
  const width = "width" in source ? source.width : source.naturalWidth;
  const height = "height" in source ? source.height : source.naturalHeight;
  const CanvasClass = typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas : HTMLCanvasElement;
  const canvas = new CanvasClass(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D rendering context");
  ctx.drawImage(source, 0, 0);
  const faces = detections.filter((d) => d.kind === "face" && d.box);
  const credentials = detections.filter(
    (d) => (d.kind === "credential" || d.kind === "api_key") && d.box
  );
  if (options.blurFaces) {
    for (const face of faces) {
      const expanded = {
        x: Math.max(0, face.box.x - face.box.width * 0.1),
        y: Math.max(0, face.box.y - face.box.height * 0.1),
        width: face.box.width * 1.2,
        height: face.box.height * 1.2
      };
      blurRegion(ctx, expanded, width, height, options.blurRadius);
      if (options.showLabels) {
        labelRegion(ctx, expanded, width, height, "\u{1F534} Face");
      }
    }
  }
  if (options.maskCredentials) {
    for (const cred of credentials) {
      maskRegion(ctx, cred.box, width, height);
      if (options.showLabels) {
        labelRegion(ctx, cred.box, width, height, `\u{1F512} ${cred.label}`);
      }
    }
  }
  return canvas;
}
async function redactToBlob(source, detections, options = DEFAULT_OPTIONS) {
  const canvas = redactImage(source, detections, options);
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.85
    });
  }
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      0.85
    );
  });
}
function redactSnapshot(snapshot, detections) {
  let redactedCount = 0;
  const credentialIds = new Set(
    detections.filter((d) => d.kind === "credential" || d.kind === "api_key").map((d) => {
      const match = d.elementSelector?.match(/data-vless-id="(\d+)"/);
      return match ? parseInt(match[1], 10) : -1;
    }).filter((id) => id >= 0)
  );
  const TOKEN_RE = /^<[A-Z]+_\d+>$/;
  const elements = snapshot.elements.map((el) => {
    if (credentialIds.has(el.id)) {
      if (el.value && TOKEN_RE.test(el.value)) {
        return el;
      }
      redactedCount++;
      return {
        ...el,
        value: el.value ? "[REDACTED]" : void 0,
        attrs: el.attrs ? Object.fromEntries(
          Object.entries(el.attrs).map(
            ([k, v]) => k === "href" ? [k, "[REDACTED]"] : [k, v]
          )
        ) : void 0
      };
    }
    return el;
  });
  let text = snapshot.text;
  for (const det of detections.filter((d) => d.kind === "id_number" && d.value)) {
    text = text.replaceAll(det.value, "[ID_REDACTED]");
    redactedCount++;
  }
  return { elements, text, redactedCount };
}
var DEFAULT_OPTIONS;
var init_redaction = __esm({
  "src/background/redaction.ts"() {
    "use strict";
    DEFAULT_OPTIONS = {
      blurFaces: true,
      maskCredentials: true,
      showLabels: false,
      blurRadius: 20
    };
  }
});

// src/background/experience-memory.ts
var experience_memory_exports = {};
__export(experience_memory_exports, {
  classifyPageType: () => classifyPageType,
  clearExperienceMemory: () => clearExperienceMemory,
  extractDomain: () => extractDomain,
  getAllExperiences: () => getAllExperiences,
  getExperiencesForDomain: () => getExperiencesForDomain,
  getExperiencesForPageType: () => getExperiencesForPageType,
  getMemoryStats: () => getMemoryStats,
  getRecentExperiences: () => getRecentExperiences,
  recordExperience: () => recordExperience
});
async function getExperiences() {
  const { [STORAGE_KEY]: experiences } = await chrome.storage.local.get(STORAGE_KEY);
  return experiences ?? [];
}
async function saveExperiences(experiences) {
  if (experiences.length > MAX_EXPERIENCES) {
    experiences = experiences.slice(0, MAX_EXPERIENCES);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: experiences });
}
async function recordExperience(experience2) {
  const experiences = await getExperiences();
  experiences.unshift(experience2);
  await saveExperiences(experiences);
}
async function getAllExperiences() {
  return getExperiences();
}
async function getExperiencesForDomain(domain2) {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.domain === domain2);
}
async function getExperiencesForPageType(pageType2) {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.pageType === pageType2);
}
async function getRecentExperiences(n) {
  const experiences = await getExperiences();
  return experiences.slice(0, n);
}
async function getMemoryStats() {
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
      improvementDelta: 0
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
  const domains = /* @__PURE__ */ new Set();
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
  let improvementDelta = 0;
  if (totalRuns >= 4) {
    const win = Math.min(3, Math.floor(totalRuns / 2));
    const recent = experiences.slice(0, win);
    const previous = experiences.slice(win, win * 2);
    if (recent.length > 0 && previous.length > 0) {
      const recentWin = recent.reduce(
        (acc, e) => acc + (e.taskSuccess ? 1 : 0) + actionSuccessRate(e) * 0.5,
        0
      ) / recent.length;
      const prevWin = previous.reduce(
        (acc, e) => acc + (e.taskSuccess ? 1 : 0) + actionSuccessRate(e) * 0.5,
        0
      ) / previous.length;
      improvementDelta = (recentWin - prevWin) / 1.5;
    }
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
    improvementDelta
  };
}
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
function classifyPageType(url, title, text) {
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
function actionSuccessRate(experience2) {
  if (experience2.actions.length === 0) return 1;
  return experience2.actions.filter((a) => a.success).length / experience2.actions.length;
}
async function clearExperienceMemory() {
  await chrome.storage.local.remove(STORAGE_KEY);
}
var STORAGE_KEY, MAX_EXPERIENCES;
var init_experience_memory = __esm({
  "src/background/experience-memory.ts"() {
    "use strict";
    STORAGE_KEY = "vless-experience-memory";
    MAX_EXPERIENCES = 200;
  }
});

// src/background/reflection.ts
var reflection_exports = {};
__export(reflection_exports, {
  reflectOnRun: () => reflectOnRun
});
function reflectOnRun(experience2, existingRules2) {
  const newRules = [];
  const confirmedRules = [];
  const contradictedRules = [];
  let falsePositives = 0;
  let falseNegatives = 0;
  let strategyOptimizations = 0;
  let sitePatternsFound = 0;
  for (const pii of experience2.piiDetections) {
    if (pii.outcome === "false_positive") {
      falsePositives++;
      const rule = generateFalsePositiveRule(experience2, pii, existingRules2);
      if (rule) {
        newRules.push(rule);
      }
    }
    if (pii.outcome === "missed") {
      falseNegatives++;
      const rule = generateMissedPIIRule(experience2, pii, existingRules2);
      if (rule) {
        newRules.push(rule);
      }
    }
    if (pii.outcome === "true_positive" && pii.method === "learned_rule") {
      const matchingRule = existingRules2.find(
        (r) => r.category === "pii_detection" && r.pattern.condition.includes(pii.kind)
      );
      if (matchingRule) {
        confirmedRules.push(matchingRule.id);
      }
    }
  }
  const deterministicActions = experience2.actions.filter((a) => a.strategy === "deterministic");
  const llmActions = experience2.actions.filter((a) => a.strategy === "llm");
  if (deterministicActions.length > 0 && experience2.taskSuccess) {
    const rule = generateStrategyRule(experience2, "deterministic", existingRules2);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }
  if (llmActions.length > 0 && deterministicActions.length === 0 && experience2.taskSuccess) {
    const isSimpleTask = /^(click|fill|scroll|navigate|press)/i.test(experience2.task);
    if (isSimpleTask) {
      const rule = generateStrategyRule(experience2, "deterministic", existingRules2);
      if (rule) {
        newRules.push(rule);
        strategyOptimizations++;
      }
    }
  }
  if (!experience2.taskSuccess && deterministicActions.length > 0) {
    const rule = generateStrategyRule(experience2, "llm", existingRules2);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }
  if (experience2.domain && experience2.piiDetections.length > 0) {
    const piiKinds = [...new Set(experience2.piiDetections.map((p) => p.kind))];
    const rule = generateSitePatternRule(experience2, piiKinds, existingRules2);
    if (rule) {
      newRules.push(rule);
      sitePatternsFound++;
    }
  }
  if (experience2.reocrVerified && experience2.reocrLeakedPII && experience2.reocrLeakedPII.length > 0) {
    for (const leaked of experience2.reocrLeakedPII) {
      const rule = {
        id: `reocr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        category: "redaction",
        description: `Re-OCR detected leaked PII "${leaked.slice(0, 20)}..." in redacted image. Redaction needs strengthening.`,
        pattern: {
          domain: experience2.domain,
          pageType: experience2.pageType,
          condition: `reocr_leak:${leaked.slice(0, 30)}`,
          action: "strengthen_redaction"
        },
        confidence: 0.7,
        confirmedCount: 0,
        createdAt: Date.now(),
        lastConfirmedAt: Date.now()
      };
      newRules.push(rule);
    }
  }
  const summary = buildSummary(experience2, {
    falsePositives,
    falseNegatives,
    strategyOptimizations,
    sitePatternsFound,
    newRulesCount: newRules.length
  });
  return {
    newRules,
    confirmedRules,
    contradictedRules,
    summary,
    metrics: {
      falsePositives,
      falseNegatives,
      strategyOptimizations,
      sitePatternsFound
    }
  };
}
function generateFalsePositiveRule(experience2, pii, existingRules2) {
  const duplicate = existingRules2.find(
    (r) => r.category === "pii_detection" && r.pattern.condition.includes(`false_positive:${pii.kind}`) && r.pattern.domain === experience2.domain
  );
  if (duplicate) return null;
  return {
    id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "pii_detection",
    description: `False positive: ${pii.kind} detected by ${pii.method} on ${experience2.pageType} page is not actually sensitive.`,
    pattern: {
      domain: experience2.domain,
      pageType: experience2.pageType,
      condition: `false_positive:${pii.kind}:${pii.method}`,
      action: "reduce_confidence"
    },
    confidence: 0.5,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  };
}
function generateMissedPIIRule(experience2, pii, existingRules2) {
  const duplicate = existingRules2.find(
    (r) => r.category === "pii_detection" && r.pattern.condition.includes(`missed:${pii.kind}`) && r.pattern.domain === experience2.domain
  );
  if (duplicate) return null;
  return {
    id: `miss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "pii_detection",
    description: `Missed PII: ${pii.kind} on ${experience2.pageType} page was not detected. Add detection for this pattern.`,
    pattern: {
      domain: experience2.domain,
      pageType: experience2.pageType,
      condition: `missed:${pii.kind}:${pii.method}`,
      action: "add_detection"
    },
    confidence: 0.5,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  };
}
function generateStrategyRule(experience2, recommendedStrategy, existingRules2) {
  const duplicate = existingRules2.find(
    (r) => r.category === "strategy" && r.pattern.condition === `strategy:${recommendedStrategy}` && r.pattern.pageType === experience2.pageType
  );
  if (duplicate) return null;
  return {
    id: `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "strategy",
    description: `${recommendedStrategy} planner ${recommendedStrategy === "deterministic" ? "works" : "is needed"} for ${experience2.pageType} pages.`,
    pattern: {
      pageType: experience2.pageType,
      condition: `strategy:${recommendedStrategy}`,
      action: `use_${recommendedStrategy}`
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  };
}
function generateSitePatternRule(experience2, piiKinds, existingRules2) {
  const duplicate = existingRules2.find(
    (r) => r.category === "site_pattern" && r.pattern.domain === experience2.domain
  );
  if (duplicate) return null;
  return {
    id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "site_pattern",
    description: `${experience2.domain} commonly contains: ${piiKinds.join(", ")}.`,
    pattern: {
      domain: experience2.domain,
      condition: `site_pii:${piiKinds.join(",")}`,
      action: "prioritize_detection"
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  };
}
function buildSummary(experience2, metrics) {
  const parts = [];
  parts.push(`Task ${experience2.taskSuccess ? "succeeded" : "failed"} on ${experience2.pageType} page.`);
  if (metrics.falsePositives > 0) {
    parts.push(`${metrics.falsePositives} false positive(s) identified.`);
  }
  if (metrics.falseNegatives > 0) {
    parts.push(`${metrics.falseNegatives} missed PII item(s) found.`);
  }
  if (metrics.strategyOptimizations > 0) {
    parts.push(`${metrics.strategyOptimizations} strategy optimization(s) noted.`);
  }
  if (metrics.sitePatternsFound > 0) {
    parts.push(`New site pattern recorded for ${experience2.domain}.`);
  }
  if (metrics.newRulesCount > 0) {
    parts.push(`${metrics.newRulesCount} new rule(s) generated.`);
  }
  return parts.join(" ");
}
var init_reflection = __esm({
  "src/background/reflection.ts"() {
    "use strict";
  }
});

// src/background/learned-rules.ts
var learned_rules_exports = {};
__export(learned_rules_exports, {
  applyReflectionResults: () => applyReflectionResults,
  buildSuppressionKeys: () => buildSuppressionKeys,
  clearLearnedRules: () => clearLearnedRules,
  getApplicableRules: () => getApplicableRules,
  getLearnedRules: () => getLearnedRules,
  getRulesByCategory: () => getRulesByCategory,
  getRulesSummary: () => getRulesSummary,
  recommendsLLMOnly: () => recommendsLLMOnly
});
async function getRules() {
  const { [STORAGE_KEY2]: rules } = await chrome.storage.local.get(STORAGE_KEY2);
  return rules ?? [];
}
async function saveRules(rules) {
  if (rules.length > MAX_RULES) {
    rules.sort((a, b) => b.confidence - a.confidence);
    rules.length = MAX_RULES;
  }
  await chrome.storage.local.set({ [STORAGE_KEY2]: rules });
}
async function applyReflectionResults(results) {
  const rules = await getRules();
  for (const newRule of results.newRules) {
    const exists = rules.some(
      (r) => r.category === newRule.category && r.pattern.condition === newRule.pattern.condition && r.pattern.domain === newRule.pattern.domain
    );
    if (!exists) {
      rules.push(newRule);
    }
  }
  for (const ruleId of results.confirmedRules) {
    const rule = rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.confirmedCount++;
      rule.confidence = Math.min(1, rule.confidence + 0.1);
      rule.lastConfirmedAt = Date.now();
    }
  }
  for (const ruleId of results.contradictedRules) {
    const rule = rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.confidence = Math.max(0, rule.confidence - 0.2);
      if (rule.confidence < 0.1) {
        const idx = rules.indexOf(rule);
        if (idx >= 0) rules.splice(idx, 1);
      }
    }
  }
  await saveRules(rules);
}
async function getLearnedRules() {
  return getRules();
}
async function getApplicableRules(domain2, pageType2) {
  const rules = await getRules();
  return rules.filter((r) => {
    if (r.pattern.domain && r.pattern.domain !== domain2) return false;
    if (r.pattern.pageType && r.pattern.pageType !== pageType2) return false;
    return r.confidence >= 0.3;
  });
}
async function getRulesByCategory(category) {
  const rules = await getRules();
  return rules.filter((r) => r.category === category);
}
function buildSuppressionKeys(rules) {
  const keys = /* @__PURE__ */ new Set();
  for (const rule of rules) {
    if (rule.category !== "pii_detection" || rule.confidence < 0.5) continue;
    const m = rule.pattern.condition.match(/^false_positive:([^:]+):([^:]+)$/);
    if (m) keys.add(`${m[1]}:${m[2]}`);
  }
  return keys;
}
function recommendsLLMOnly(rules) {
  return rules.some(
    (r) => r.category === "strategy" && r.pattern.action === "use_llm" && r.confidence >= 0.5
  );
}
async function getRulesSummary() {
  const rules = await getRules();
  const oneHourAgo = Date.now() - 60 * 60 * 1e3;
  const byCategory = {};
  let highConfidence = 0;
  let recentlyCreated = 0;
  for (const rule of rules) {
    byCategory[rule.category] = (byCategory[rule.category] ?? 0) + 1;
    if (rule.confidence >= 0.7) highConfidence++;
    if (rule.createdAt > oneHourAgo) recentlyCreated++;
  }
  const recent = [...rules].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((r) => ({
    id: r.id,
    category: r.category,
    description: r.description,
    confidence: r.confidence,
    confirmedCount: r.confirmedCount,
    createdAt: r.createdAt
  }));
  return {
    total: rules.length,
    byCategory,
    highConfidence,
    recentlyCreated,
    recent
  };
}
async function clearLearnedRules() {
  await chrome.storage.local.remove(STORAGE_KEY2);
}
var STORAGE_KEY2, MAX_RULES;
var init_learned_rules = __esm({
  "src/background/learned-rules.ts"() {
    "use strict";
    STORAGE_KEY2 = "vless-learned-rules";
    MAX_RULES = 500;
  }
});

// src/background/privacy-ledger.ts
var privacy_ledger_exports = {};
__export(privacy_ledger_exports, {
  addEntry: () => addEntry,
  clearLedger: () => clearLedger,
  exportLedger: () => exportLedger,
  getLedger: () => getLedger,
  getLedgerSummary: () => getLedgerSummary,
  initLedger: () => initLedger,
  recordAction: () => recordAction,
  recordDetections: () => recordDetections,
  recordRedaction: () => recordRedaction,
  recordResolution: () => recordResolution,
  recordSnapshot: () => recordSnapshot,
  recordTokenization: () => recordTokenization,
  recordVerification: () => recordVerification
});
async function loadStore() {
  const { [STORAGE_KEY3]: store } = await chrome.storage.local.get(STORAGE_KEY3);
  if (store && Array.isArray(store.entries)) {
    return store;
  }
  return { entries: [], entryCounter: 0, lastHash: "0".repeat(64) };
}
async function saveStore(store) {
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
  }
  await chrome.storage.local.set({ [STORAGE_KEY3]: store });
}
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function initLedger() {
}
async function addEntry(type, data) {
  const store = await loadStore();
  const seq = store.entryCounter + 1;
  const timestamp = Date.now();
  const content = JSON.stringify({ seq, timestamp, type, data, prevHash: store.lastHash });
  const hash = await sha256(content);
  const entry = {
    seq,
    timestamp,
    type,
    data,
    hash,
    prevHash: store.lastHash
  };
  store.lastHash = hash;
  store.entryCounter = seq;
  store.entries.push(entry);
  await saveStore(store);
  return entry;
}
async function recordSnapshot(url, title, elementCount) {
  return addEntry("snapshot", { url, title, elementCount });
}
async function recordDetections(detections) {
  return addEntry("detection", {
    count: detections.length,
    kinds: [...new Set(detections.map((d) => d.kind))],
    methods: [...new Set(detections.map((d) => d.method))]
  });
}
async function recordTokenization(tokens) {
  return addEntry("tokenize", {
    count: tokens.length,
    tokenTypes: [...new Set(tokens.map((t) => t.kind))]
  });
}
async function recordRedaction(redactedCount, method) {
  return addEntry("redact", { redactedCount, method });
}
async function recordResolution(token, kind) {
  return addEntry("resolve", { token, kind });
}
async function recordAction(tool, success, elementId) {
  return addEntry("action", { tool, success, elementId });
}
async function recordVerification(passed2, regionsChecked, leakedCount) {
  return addEntry("verification", { passed: passed2, regionsChecked, leakedCount });
}
async function getLedger() {
  const store = await loadStore();
  const summary = {
    totalSnapshots: 0,
    totalDetections: 0,
    totalTokensCreated: 0,
    totalRedactions: 0,
    totalActions: 0,
    verificationPassed: true,
    chainValid: true
  };
  let prevHash = "0".repeat(64);
  for (const entry of store.entries) {
    if (entry.prevHash !== prevHash) {
      summary.chainValid = false;
    }
    const content = JSON.stringify({
      seq: entry.seq,
      timestamp: entry.timestamp,
      type: entry.type,
      data: entry.data,
      prevHash: entry.prevHash
    });
    const expectedHash = await sha256(content);
    if (expectedHash !== entry.hash) {
      summary.chainValid = false;
    }
    switch (entry.type) {
      case "snapshot":
        summary.totalSnapshots++;
        break;
      case "detection":
        summary.totalDetections += entry.data.count ?? 0;
        break;
      case "tokenize":
        summary.totalTokensCreated += entry.data.count ?? 0;
        break;
      case "redact":
        summary.totalRedactions += entry.data.redactedCount ?? 0;
        break;
      case "action":
        summary.totalActions++;
        break;
      case "verification":
        if (!entry.data.passed) summary.verificationPassed = false;
        break;
    }
    prevHash = entry.hash;
  }
  return {
    sessionId: `session-${store.entries[0]?.timestamp ?? Date.now()}`,
    entries: store.entries,
    summary
  };
}
async function getLedgerSummary() {
  const store = await loadStore();
  const entries = store.entries;
  let totalSnapshots = 0;
  let totalDetections = 0;
  let totalRedactions = 0;
  let totalActions = 0;
  let chainValid = true;
  let prevHash = "0".repeat(64);
  for (const entry of entries) {
    if (entry.prevHash !== prevHash) {
      chainValid = false;
    }
    switch (entry.type) {
      case "snapshot":
        totalSnapshots++;
        break;
      case "detection":
        totalDetections += entry.data.count ?? 0;
        break;
      case "redact":
        totalRedactions += entry.data.redactedCount ?? 0;
        break;
      case "action":
        totalActions++;
        break;
    }
    prevHash = entry.hash;
  }
  return {
    totalEntries: entries.length,
    chainValid,
    totalSnapshots,
    totalDetections,
    totalRedactions,
    totalActions,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : null
  };
}
async function exportLedger() {
  const ledger = await getLedger();
  return JSON.stringify(ledger, null, 2);
}
async function clearLedger() {
  await chrome.storage.local.remove(STORAGE_KEY3);
}
var STORAGE_KEY3, MAX_ENTRIES;
var init_privacy_ledger = __esm({
  "src/background/privacy-ledger.ts"() {
    "use strict";
    STORAGE_KEY3 = "vless-privacy-ledger";
    MAX_ENTRIES = 500;
  }
});

// src/background/reocr-verification.ts
var reocr_verification_exports = {};
__export(reocr_verification_exports, {
  detectPIIInText: () => detectPIIInText,
  emptyVerification: () => emptyVerification,
  piiKindFromOcrLabel: () => piiKindFromOcrLabel,
  regionDiffScore: () => regionDiffScore,
  regionVariance: () => regionVariance,
  solidBlackRatio: () => solidBlackRatio,
  verifyRegions: () => verifyRegions
});
function detectPIIInText(text) {
  const found = [];
  for (const { pattern, label } of PII_VERIFICATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    if (regex.test(text)) {
      found.push(label);
    }
  }
  return found;
}
function piiKindFromOcrLabel(label) {
  if (/aadhaar|pan|ssn|passport|ifsc/i.test(label)) return "id_number";
  if (/card|email|phone/i.test(label)) return "credential";
  if (/api key|jwt|github|aws|anthropic|openai|token/i.test(label)) return "api_key";
  return "pii_text";
}
function clampRegion(img, x, y, width, height) {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const right = Math.min(img.width, Math.round(x + width));
  const bottom = Math.min(img.height, Math.round(y + height));
  if (right - rx <= 0 || bottom - ry <= 0) return null;
  return { x: rx, y: ry, width: right - rx, height: bottom - ry };
}
function solidBlackRatio(img, x, y, width, height) {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;
  let blackPixels = 0;
  let total = 0;
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
      const idx = (py * img.width + px) * 4;
      const r = img.data[idx];
      const g = img.data[idx + 1];
      const b = img.data[idx + 2];
      if (r < 30 && g < 30 && b < 30) blackPixels++;
      total++;
    }
  }
  return total > 0 ? blackPixels / total : 0;
}
function regionDiffScore(original, redacted, x, y, width, height) {
  const region = clampRegion(original, x, y, width, height);
  if (!region || region.width === 0 || region.height === 0) return 0;
  let totalDiff = 0;
  let count = 0;
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
      const oi = (py * original.width + px) * 4;
      const ri = (py * redacted.width + px) * 4;
      if (oi + 2 >= original.data.length || ri + 2 >= redacted.data.length) continue;
      const rDiff = Math.abs(original.data[oi] - redacted.data[ri]);
      const gDiff = Math.abs(original.data[oi + 1] - redacted.data[ri + 1]);
      const bDiff = Math.abs(original.data[oi + 2] - redacted.data[ri + 2]);
      totalDiff += (rDiff + gDiff + bDiff) / 765;
      count++;
    }
  }
  return count > 0 ? totalDiff / count : 0;
}
function regionVariance(img, x, y, width, height) {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
      const idx = (py * img.width + px) * 4;
      const gray2 = (img.data[idx] + img.data[idx + 1] + img.data[idx + 2]) / 3;
      sum += gray2;
      sumSq += gray2 * gray2;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}
function verifyRegions(original, redacted, regions, timestamp = Date.now()) {
  let regionsChecked = 0;
  let regionsRedacted = 0;
  const leakedPatterns = [];
  for (const region of regions) {
    if (!clampRegion(redacted, region.x, region.y, region.width, region.height)) {
      continue;
    }
    regionsChecked++;
    const blackRatio = solidBlackRatio(redacted, region.x, region.y, region.width, region.height);
    if (original) {
      const origVariance = regionVariance(original, region.x, region.y, region.width, region.height);
      const diff = regionDiffScore(original, redacted, region.x, region.y, region.width, region.height);
      if (origVariance < 40) {
        regionsRedacted++;
        continue;
      }
      if (blackRatio > 0.5) {
        regionsRedacted++;
        continue;
      }
      if (diff > 0.12) {
        regionsRedacted++;
        continue;
      }
      leakedPatterns.push(
        `"${region.label}" (${region.kind}) at ${region.x},${region.y} was not visibly redacted \u2014 original content may still be visible.`
      );
    } else {
      if (blackRatio > 0.5 || regionVariance(redacted, region.x, region.y, region.width, region.height) < 400) {
        regionsRedacted++;
      } else {
        leakedPatterns.push(
          `"${region.label}" (${region.kind}) at ${region.x},${region.y} could not be confirmed redacted.`
        );
      }
    }
  }
  const verified = regionsChecked === 0 || regionsRedacted === regionsChecked;
  const confidence = regionsChecked > 0 ? regionsRedacted / regionsChecked : 1;
  const summary = verified ? `VERIFIED: ${regionsRedacted}/${regionsChecked} sensitive regions confirmed redacted. Zero PII leakage.` : `WARNING: ${regionsRedacted}/${regionsChecked} regions confirmed redacted; ${regionsChecked - regionsRedacted} may still contain sensitive content.`;
  return {
    verified,
    regionsChecked,
    regionsRedacted,
    leakedPatterns,
    confidence,
    summary,
    timestamp
  };
}
function emptyVerification(timestamp = Date.now()) {
  return {
    verified: true,
    regionsChecked: 0,
    regionsRedacted: 0,
    leakedPatterns: [],
    confidence: 1,
    summary: "VERIFIED: nothing sensitive on screen \u2014 zero regions required redaction.",
    timestamp
  };
}
var PII_VERIFICATION_PATTERNS;
var init_reocr_verification = __esm({
  "src/background/reocr-verification.ts"() {
    "use strict";
    PII_VERIFICATION_PATTERNS = [
      { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: "Aadhaar number" },
      { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card" },
      { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" },
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
      { pattern: /\b[A-Z]{1,2}\d{6,8}\b/, label: "Passport number" },
      { pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/, label: "Card number" },
      { pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/, label: "Anthropic API key" },
      { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, label: "OpenAI API key" },
      { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/, label: "GitHub token" },
      { pattern: /\b(AKIA[0-9A-Z]{16})\b/, label: "AWS key" },
      { pattern: /\b(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.)\b/, label: "JWT token" },
      { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: "Email address" },
      { pattern: /\b(\+?91[\s-]?\d{5}[\s-]?\d{5})\b/, label: "Indian phone" }
    ];
  }
});

// scripts/verify-pipeline.mjs
var mem = /* @__PURE__ */ new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: mem.get(key) };
        if (Array.isArray(key)) {
          const out2 = {};
          for (const k of key) if (mem.has(k)) out2[k] = mem.get(k);
          return out2;
        }
        const out = {};
        for (const [k, v] of mem) out[k] = v;
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) mem.set(k, v);
      },
      async remove(key) {
        if (typeof key === "string") mem.delete(key);
        else for (const k of key) mem.delete(k);
      }
    }
  },
  runtime: { sendMessage: async () => {
  } }
};
var {
  detectAllPII: detectAllPII2,
  detectAllPIIDetailed: detectAllPIIDetailed2
} = await Promise.resolve().then(() => (init_pii_detector(), pii_detector_exports));
var {
  verhoeffValid: verhoeffValid2,
  verhoeffCheckDigit: verhoeffCheckDigit2,
  isAadhaarNumber: isAadhaarNumber2,
  isCardNumber: isCardNumber2,
  luhnValid: luhnValid2
} = await Promise.resolve().then(() => (init_checksums(), checksums_exports));
var { detectContextualPII: detectContextualPII2, contextualToDetectedPII: contextualToDetectedPII2 } = await Promise.resolve().then(() => (init_contextual_pii(), contextual_pii_exports));
var { tokenizer: tokenizer2, maskSample: maskSample2 } = await Promise.resolve().then(() => (init_tokenizer(), tokenizer_exports));
var { redactSnapshot: redactSnapshot2 } = await Promise.resolve().then(() => (init_redaction(), redaction_exports));
var {
  recordExperience: recordExperience2,
  getMemoryStats: getMemoryStats2,
  clearExperienceMemory: clearExperienceMemory2,
  extractDomain: extractDomain2,
  classifyPageType: classifyPageType2
} = await Promise.resolve().then(() => (init_experience_memory(), experience_memory_exports));
var { reflectOnRun: reflectOnRun2 } = await Promise.resolve().then(() => (init_reflection(), reflection_exports));
var {
  applyReflectionResults: applyReflectionResults2,
  getLearnedRules: getLearnedRules2,
  getRulesSummary: getRulesSummary2,
  getApplicableRules: getApplicableRules2,
  buildSuppressionKeys: buildSuppressionKeys2,
  recommendsLLMOnly: recommendsLLMOnly2
} = await Promise.resolve().then(() => (init_learned_rules(), learned_rules_exports));
var { recordRedaction: recordRedaction2, recordVerification: recordVerification2, getLedgerSummary: getLedgerSummary2, clearLedger: clearLedger2 } = await Promise.resolve().then(() => (init_privacy_ledger(), privacy_ledger_exports));
var { verifyRegions: verifyRegions2, emptyVerification: emptyVerification2, piiKindFromOcrLabel: piiKindFromOcrLabel2, detectPIIInText: detectPIIInText2 } = await Promise.resolve().then(() => (init_reocr_verification(), reocr_verification_exports));
function sanitizeSnapshot(snapshot) {
  const regexDetections = detectAllPII2(snapshot);
  const contextualDetections = detectContextualPII2(snapshot);
  const contextualPII = contextualToDetectedPII2(contextualDetections);
  const seenElementIds = new Set(regexDetections.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const allDetections = [...regexDetections, ...contextualPII.filter((d) => !d.elementSelector || !seenElementIds.has(d.elementSelector))];
  const tokenized = tokenizer2.tokenizeDetections(snapshot, allDetections);
  const { elements, text, redactedCount } = redactSnapshot2(
    { elements: tokenized.elements, text: tokenized.text },
    allDetections
  );
  return {
    sanitized: { ...snapshot, elements, text },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...regexDetections.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...contextualDetections.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence }))
    ]
  };
}
var passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` \u2014 ${extra}` : ""}`);
  passed++;
  console.log(`  \u2713 ${name}`);
}
console.log("\n=== Scenario A: profile/banking page with PII ===\n");
tokenizer2.clear();
await clearExperienceMemory2();
await clearLedger2();
var aadhaarSeed = "23456789012";
var aadhaarDigits = aadhaarSeed + verhoeffCheckDigit2(aadhaarSeed);
var aadhaarFmt = `${aadhaarDigits.slice(0, 4)} ${aadhaarDigits.slice(4, 8)} ${aadhaarDigits.slice(8, 12)}`;
var badAadhaarSeed = aadhaarDigits.slice(0, 11) + (aadhaarDigits[11] === "9" ? "8" : String(Number(aadhaarDigits[11]) + 1));
var badAadhaarFmt = `${badAadhaarSeed.slice(0, 4)} ${badAadhaarSeed.slice(4, 8)} ${badAadhaarSeed.slice(8, 12)}`;
ok("known Verhoeff sample validates (236 \u2192 2363)", verhoeffValid2("2363") && verhoeffCheckDigit2("236") === 3);
ok("generated Aadhaar passes Verhoeff", isAadhaarNumber2(aadhaarDigits), aadhaarDigits);
ok("mutated Aadhaar fails Verhoeff", !isAadhaarNumber2(badAadhaarSeed), badAadhaarSeed);
ok("Visa test card passes Luhn", isCardNumber2("4111 1111 1111 1111"));
ok("mutated card fails Luhn", !isCardNumber2("4111 1111 1111 1112"));
var snapshotA = {
  url: "https://example.com/profile",
  title: "Edit profile",
  elements: [
    { id: 0, role: "textbox", name: "Full name", value: "Rahul Sharma", attrs: { inputType: "text" } },
    { id: 1, role: "textbox", name: "Email", value: "rahul.sharma@gmail.com", attrs: { inputType: "email" } },
    { id: 2, role: "textbox", name: "Mobile number", value: "+91 98765 43210", attrs: { inputType: "tel" } },
    { id: 3, role: "button", name: "Save changes" }
  ],
  // Page text holds a real Aadhaar, a PAN, a checksum-invalid Aadhaar
  // lookalike (must NOT be redacted), plus contact details.
  text: `Identity verification \u2014 Aadhaar: ${aadhaarFmt}, PAN: ABCDE1234F. Order ref: ${badAadhaarFmt}. Contact rahul.sharma@gmail.com or +91 98765 43210 for support.`
};
var resultA = sanitizeSnapshot(snapshotA);
ok(
  "Aadhaar/PAN/email/phone + contextual fields all detected",
  resultA.detections.length >= 4,
  `got ${resultA.detections.length}: ${JSON.stringify(resultA.detections.map((d) => d.kind))}`
);
var detailedA = detectAllPIIDetailed2(snapshotA);
ok(
  "checksum-invalid Aadhaar lookalike rejected, not detected",
  detailedA.rejected.some((r) => r.value === badAadhaarFmt),
  JSON.stringify(detailedA.rejected.map((r) => r.value))
);
var tokensA = tokenizer2.getTokenSummary();
ok("vault created tokens from detections", tokensA.length > 0, `tokens=${JSON.stringify(tokensA)}`);
ok("tokens include masked samples", tokensA.every((t) => t.sample && t.sample.includes("\u2022")), "no sample found");
ok("token sample masks email domain", tokensA.some((t) => t.sample?.includes("@")), "email sample missing @domain");
var rendered = JSON.stringify(resultA.sanitized);
ok("raw (valid) Aadhaar digits gone from sanitized snapshot", !rendered.includes(aadhaarFmt));
ok("checksum-invalid lookalike left untouched (no over-redaction)", rendered.includes(badAadhaarFmt));
ok("raw PAN gone", !rendered.includes("ABCDE1234F"));
ok("raw email gone", !rendered.includes("rahul.sharma@gmail.com"));
ok("sanitized snapshot contains token markers", rendered.includes("<"));
var domain = extractDomain2(snapshotA.url);
var pageType = classifyPageType2(snapshotA.url, snapshotA.title, snapshotA.text);
var experience = {
  id: "exp-test-a",
  timestamp: Date.now(),
  task: "scan profile page for PII",
  domain,
  pageType,
  piiDetections: [
    ...resultA.detections.map((d) => ({ kind: d.kind, method: d.method, outcome: "true_positive", confidence: d.confidence })),
    // The agent now records checksum-rejected lookalikes as measured FPs.
    { kind: "id_number", method: "checksum", outcome: "false_positive", confidence: 0.15 }
  ],
  actions: [],
  taskSuccess: true,
  durationMs: 900,
  piiRedacted: resultA.piiCount,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: []
};
await recordExperience2(experience);
var statsA = await getMemoryStats2();
ok("dashboard run count = 1", statsA.totalRuns === 1, `got ${statsA.totalRuns}`);
ok("dashboard PII detected > 0", statsA.totalPIIDetected > 0, `got ${statsA.totalPIIDetected}`);
ok("dashboard PII redacted > 0", statsA.totalPIIRedacted > 0, `got ${statsA.totalPIIRedacted}`);
ok("checksum rejects counted as false positives in memory", statsA.totalFalsePositives === 1, `got ${statsA.totalFalsePositives}`);
await recordRedaction2(resultA.piiCount, "dom");
var ledgerA = await getLedgerSummary2();
ok("ledger records redactions", ledgerA.totalRedactions > 0, `got ${ledgerA.totalRedactions}`);
ok("ledger chain intact", ledgerA.chainValid === true);
var existingRules = await getLearnedRules2();
var reflection = reflectOnRun2(experience, existingRules);
if (reflection.newRules.length > 0) {
  await applyReflectionResults2(reflection);
  const summary = await getRulesSummary2();
  ok("reflection generated rules", summary.total > 0, JSON.stringify(summary));
  ok(
    "rules summary exposes actual rule contents (not just counts)",
    Array.isArray(summary.recent) && summary.recent.length > 0 && summary.recent.every((r) => typeof r.description === "string" && r.description.length > 0),
    JSON.stringify(summary.recent)
  );
} else {
  console.log("  (no new rules this run \u2014 acceptable for a single run)");
}
console.log("\n=== Scenario B: visual (screenshot) detections ===\n");
tokenizer2.clear();
var visualDetections = [
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "credential", label: "Password field", confidence: 0.95 }
];
var experienceB = {
  id: "exp-test-b",
  timestamp: Date.now(),
  task: "open email inbox",
  domain: "mail.example.com",
  pageType: "email",
  // Agent now pushes screenshot detections as method "visual".
  piiDetections: visualDetections.map((d) => ({ kind: d.kind, method: "visual", outcome: "true_positive", confidence: d.confidence })),
  actions: [
    { tool: "navigate", success: true, latencyMs: 800, strategy: "llm" },
    { tool: "click", success: true, latencyMs: 120, strategy: "llm" }
  ],
  taskSuccess: true,
  durationMs: 3400,
  piiRedacted: 3,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: []
};
await recordExperience2(experienceB);
var statsB = await getMemoryStats2();
ok("total runs = 2", statsB.totalRuns === 2, `got ${statsB.totalRuns}`);
ok("PII detected includes visual detections", statsB.totalPIIDetected >= 6, `got ${statsB.totalPIIDetected}`);
ok("success rate = 100%", statsB.averageSuccessRate === 1, `got ${statsB.averageSuccessRate}`);
await recordRedaction2(3, "visual");
var ledgerB = await getLedgerSummary2();
ok("ledger totals both DOM + visual redactions", ledgerB.totalRedactions >= 4, `got ${ledgerB.totalRedactions}`);
ok("ledger entries grew", ledgerB.totalEntries >= 2, `got ${ledgerB.totalEntries}`);
console.log("\n=== Scenario C: masked token samples never leak raw values ===\n");
function noDigits(s) {
  return !/[0-9]/.test(s);
}
function noAlnum(s) {
  return !/[A-Za-z0-9]/.test(s);
}
tokenizer2.clear();
tokenizer2.tokenize("1234 5678 9012", "id_number");
tokenizer2.tokenize("4111-1111-1111-1111", "credential");
tokenizer2.tokenize("+91 98765 43210", "credential");
tokenizer2.tokenize("rahul.sharma@gmail.com", "credential");
tokenizer2.tokenize("ABCDE1234F", "id_number");
var samplesC = tokenizer2.getTokenSummary();
ok(
  "email sample keeps only 2 chars of local part",
  maskSample2("rahul.sharma@gmail.com") === "ra\u2022\u2022\u2022@gmail.com",
  `got ${maskSample2("rahul.sharma@gmail.com")}`
);
ok(
  "Aadhaar sample contains zero real digits",
  noDigits(maskSample2("1234 5678 9012")),
  `got ${maskSample2("1234 5678 9012")}`
);
ok(
  "Aadhaar sample keeps shape (spaces preserved)",
  /^•••• •••• ••••$/.test(maskSample2("1234 5678 9012")),
  `got ${maskSample2("1234 5678 9012")}`
);
ok(
  "card sample contains zero real digits",
  noDigits(maskSample2("4111-1111-1111-1111")),
  `got ${maskSample2("4111-1111-1111-1111")}`
);
ok(
  "phone sample contains zero real digits but keeps + separator",
  noDigits(maskSample2("+91 98765 43210")) && maskSample2("+91 98765 43210").includes("+"),
  `got ${maskSample2("+91 98765 43210")}`
);
ok(
  "PAN sample contains zero real letters or digits",
  noAlnum(maskSample2("ABCDE1234F")),
  `got ${maskSample2("ABCDE1234F")}`
);
ok(
  "SSN sample contains zero real digits",
  noDigits(maskSample2("123-45-6789")),
  `got ${maskSample2("123-45-6789")}`
);
ok(
  "name sample keeps at most 2 real characters",
  /^Ra•+$/.test(maskSample2("Rahul Sharma")),
  `got ${maskSample2("Rahul Sharma")}`
);
ok(
  "vault samples (incl. phone/Aadhaar values) contain no digits",
  samplesC.filter((t) => t.kind === "credential" || t.kind === "id_number").every((t) => noDigits(t.sample ?? "")),
  JSON.stringify(samplesC)
);
console.log("\n=== Scenario D: re-OCR pixel verification ===\n");
function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = fill(i % w, Math.floor(i / w));
    data[i * 4] = v[0];
    data[i * 4 + 1] = v[1];
    data[i * 4 + 2] = v[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
var white = () => [255, 255, 255];
var black = () => [0, 0, 0];
var gray = () => [200, 200, 200];
var origD1 = makeImage(40, 40, white);
var redD1 = makeImage(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30 ? black() : white());
var vD1 = verifyRegions2(origD1, redD1, [{ x: 10, y: 10, width: 20, height: 20, kind: "id_number", label: "Aadhaar" }]);
ok("blacked-out region verifies (solid mask)", vD1.verified && vD1.regionsRedacted === 1, JSON.stringify(vD1));
var origD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return (x + y) % 2 ? [215, 180, 160] : [180, 145, 130];
  return white();
});
var redD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return [70, 70, 70];
  return white();
});
var vD2 = verifyRegions2(origD2, redD2, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face detected" }]);
ok("content region that was blurred verifies via pixel diff", vD2.verified && vD2.regionsRedacted === 1, JSON.stringify(vD2));
var origD3 = makeImage(40, 40, white);
var redD3 = makeImage(40, 40, white);
var vD3 = verifyRegions2(origD3, redD3, [{ x: 10, y: 10, width: 20, height: 20, kind: "input_field", label: "Empty field" }]);
ok("blank region trivially verified (nothing to leak)", vD3.verified && vD3.regionsRedacted === 1, JSON.stringify(vD3));
var origD4 = makeImage(40, 40, (x, y) => {
  if (x >= 8 && x < 30 && y >= 8 && y < 30) {
    if (x >= 15 && x < 20 && y >= 15 && y < 20) return black();
    return gray();
  }
  return white();
});
var redD4 = makeImage(40, 40, (x, y) => {
  if (x >= 8 && x < 30 && y >= 8 && y < 30) {
    if (x >= 15 && x < 20 && y >= 15 && y < 20) return black();
    return gray();
  }
  return white();
});
var vD4 = verifyRegions2(origD4, redD4, [{ x: 8, y: 8, width: 22, height: 22, kind: "credential", label: "Card number" }]);
ok(
  "unchanged content region FAILS verification and reports leak",
  !vD4.verified && vD4.regionsRedacted === 0 && vD4.leakedPatterns.length === 1,
  JSON.stringify(vD4)
);
var origD5 = makeImage(40, 40, white);
var redD5 = makeImage(40, 40, (x, y) => x >= 30 && y >= 30 ? black() : white());
var vD5 = verifyRegions2(origD5, redD5, [{ x: 30, y: 30, width: 30, height: 30, kind: "credential", label: "Edge region" }]);
ok("clamped out-of-bounds region verifies", vD5.verified && vD5.regionsRedacted === 1, JSON.stringify(vD5));
ok("emptyVerification reports nothing-to-verify as verified", emptyVerification2().verified === true);
await recordVerification2(true, 4, 0);
var ledgerD = await getLedgerSummary2();
ok("ledger records verification entries", ledgerD.lastEntryType === "verification", `got ${ledgerD.lastEntryType}`);
ok("ledger chain still intact after verification", ledgerD.chainValid === true);
console.log("\n=== Scenario E: improvement delta from 4 runs ===\n");
await clearExperienceMemory2();
var mkExp = (id, taskSuccess, actionOk, actionTotal) => ({
  id,
  timestamp: Date.now(),
  task: id,
  domain: "example.com",
  pageType: "other",
  piiDetections: [],
  actions: Array.from({ length: actionTotal }, (_, i) => ({
    tool: "click",
    success: actionOk > i,
    latencyMs: 10,
    strategy: "llm"
  })),
  taskSuccess,
  durationMs: 100,
  piiRedacted: 0,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: []
});
await recordExperience2(mkExp("e1", false, 0, 2));
await recordExperience2(mkExp("e2", false, 0, 2));
await recordExperience2(mkExp("e3", true, 2, 2));
await recordExperience2(mkExp("e4", true, 1, 2));
var statsE = await getMemoryStats2();
ok(
  "improvement delta computed from only 4 runs",
  statsE.totalRuns === 4 && statsE.improvementDelta > 0,
  JSON.stringify(statsE)
);
console.log("\n=== Scenario F: learned rules consulted at runtime ===\n");
await applyReflectionResults2({
  newRules: [{
    id: "fp-test-1",
    category: "pii_detection",
    description: "False positive: id_number detected by regex on email page is not actually sensitive.",
    pattern: {
      domain: "example.com",
      pageType: "email",
      condition: "false_positive:id_number:regex",
      action: "reduce_confidence"
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  }, {
    id: "strat-test-1",
    category: "strategy",
    description: "llm planner is needed for email pages.",
    pattern: {
      pageType: "email",
      condition: "strategy:llm",
      action: "use_llm"
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now()
  }],
  confirmedRules: [],
  contradictedRules: [],
  summary: "test",
  metrics: { falsePositives: 0, falseNegatives: 0, strategyOptimizations: 0, sitePatternsFound: 0 }
});
var applicable = await getApplicableRules2("example.com", "email");
var fpKeys = buildSuppressionKeys2(applicable);
ok(
  "suppression keys include learned id_number:regex FP rule",
  fpKeys.has("id_number:regex"),
  JSON.stringify([...fpKeys])
);
ok(
  "learned strategy rule disables deterministic for the page type",
  recommendsLLMOnly2(applicable) === true
);
ok(
  "FP rule does NOT apply to a different domain",
  buildSuppressionKeys2(await getApplicableRules2("other.com", "email")).size === 0
);
ok(
  "verhoeffValid round-trips",
  verhoeffValid2(aadhaarDigits) && !verhoeffValid2(badAadhaarSeed) && luhnValid2("4111111111111111")
);
console.log("\n=== Scenario G: OCR leak \u2192 missed-outcome mapping ===\n");
ok("OCR card leak maps to credential", piiKindFromOcrLabel2("OCR: Card number still visible in the shipped image") === "credential");
ok("OCR Aadhaar leak maps to id_number", piiKindFromOcrLabel2("OCR: Aadhaar number still visible") === "id_number");
ok("OCR API-key leak maps to api_key", piiKindFromOcrLabel2("OCR: OpenAI API key still visible") === "api_key");
ok("unknown leak label falls back to pii_text", piiKindFromOcrLabel2("something weird") === "pii_text");
ok(
  "detectPIIInText finds card + email in OCR text",
  detectPIIInText2("Card 4111 1111 1111 1111 and rahul@gmail.com here").includes("Card number") && detectPIIInText2("Card 4111 1111 1111 1111 and rahul@gmail.com here").includes("Email address")
);
ok(
  "detectPIIInText finds nothing in clean redacted text",
  detectPIIInText2("Thanks for your order. Regards, Support").length === 0
);
console.log(`
${passed} assertions passed. Pipeline verified end-to-end.`);
