const SETTINGS_KEY = "xq.settings";
const ACTIVE_KEY = "xq.active";
const MATCHES_KEY = "xq.matches";
const MATCH_LIMIT = 30;

export const defaultSettings = {
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "",
  temperature: 0.4,
  mainMinutes: 5,
  incrementSeconds: 15,
  red: {
    name: "红方",
    model: "Qwen/Qwen3.8-27B",
    style: "积极对攻，优先争取先手和攻势。",
  },
  black: {
    name: "黑方",
    model: "tencent/Hy4-preview",
    style: "稳守反击，避免无补偿的兑子。",
  },
};

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

export function loadSettings() {
  const saved = read(SETTINGS_KEY, {});
  return {
    ...defaultSettings,
    ...saved,
    red: { ...defaultSettings.red, ...(saved.red || {}) },
    black: { ...defaultSettings.black, ...(saved.black || {}) },
  };
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
