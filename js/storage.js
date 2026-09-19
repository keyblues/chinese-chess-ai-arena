const SETTINGS_KEY = "xq.settings";
const ACTIVE_KEY = "xq.active";
const MATCHES_KEY = "xq.matches";
const MATCH_LIMIT = 30;

export function makeProvider(data = {}) {
  return {
    id: data.id || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: data.name || "",
    baseUrl: data.baseUrl || "",
    apiKey: data.apiKey || "",
  };
}

function makePlayer(name, providerId, model) {
  return {
    name,
    providerId,
    model,
    contextTokens: 128000,
    maxOutputTokens: 38000,
  };
}

export const defaultSettings = {
  providers: [
    makeProvider({ id: "p1", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "" }),
  ],
  temperature: 0.4,
  mainMinutes: 60,
  incrementSeconds: 60,
  red: makePlayer("红方", "p1", "nvidia/nemotron-3-super-120b-a12b:free"),
  black: makePlayer("黑方", "p1", "deepseek/deepseek-v4-flash-0731:free"),
};

function normalizeProvider(data) {
  return {
    id: data.id || makeProvider().id,
    name: data.name || "",
    baseUrl: data.baseUrl || "",
    apiKey: data.apiKey || "",
  };
}

function normalizePlayer(saved, fallback) {
  return {
    ...fallback,
    ...(saved || {}),
    contextTokens: Number(saved?.contextTokens) > 0 ? Number(saved.contextTokens) : 128000,
    maxOutputTokens: Number(saved?.maxOutputTokens) > 0 ? Number(saved.maxOutputTokens) : 38000,
  };
}

// 旧版结构（单一 baseUrl/apiKey + 双方独立 key）迁移为供应商档案。
function migrateLegacy(saved, defaults) {
  const baseUrl = saved.baseUrl || defaults.providers[0].baseUrl;
  const providers = [normalizeProvider({ id: "p1", name: "OpenRouter", baseUrl, apiKey: saved.apiKey || "" })];
  let blackProviderId = "p1";
  if (saved.black?.key && saved.black.key !== saved.apiKey) {
    providers.push(normalizeProvider({ id: "p2", name: "OpenRouter · 黑方", baseUrl, apiKey: saved.black.key }));
    blackProviderId = "p2";
  }
  return {
    ...defaults,
    providers,
    temperature: Number.isFinite(saved.temperature) ? saved.temperature : defaults.temperature,
    mainMinutes: Number(saved.mainMinutes) > 0 ? saved.mainMinutes : defaults.mainMinutes,
    incrementSeconds: Number.isFinite(saved.incrementSeconds) ? saved.incrementSeconds : defaults.incrementSeconds,
    red: normalizePlayer(
      { name: saved.red?.name, model: saved.red?.model, providerId: "p1" },
      defaults.red,
    ),
    black: normalizePlayer(
      { name: saved.black?.name, model: saved.black?.model, providerId: blackProviderId },
      defaults.black,
    ),
  };
}

export function loadSettings() {
  const saved = read(SETTINGS_KEY, {});
  if (Array.isArray(saved.providers) && saved.providers.length) {
    return {
      ...defaultSettings,
      ...saved,
      providers: saved.providers.map(normalizeProvider),
      red: normalizePlayer(saved.red, defaultSettings.red),
      black: normalizePlayer(saved.black, defaultSettings.black),
    };
  }
  return migrateLegacy(saved, defaultSettings);
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

export function loadActive() {
  return read(ACTIVE_KEY, null);
}

export function saveActive(match) {
  write(ACTIVE_KEY, match);
}

export function clearActive() {
  localStorage.removeItem(ACTIVE_KEY);
}

export function loadMatches() {
  const matches = read(MATCHES_KEY, []);
  return Array.isArray(matches) ? matches : [];
}

export function saveMatch(match) {
  const next = [match, ...loadMatches().filter((item) => item.id !== match.id)].slice(0, MATCH_LIMIT);
  write(MATCHES_KEY, next);
  return next;
}

export function clip(text, limit) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
