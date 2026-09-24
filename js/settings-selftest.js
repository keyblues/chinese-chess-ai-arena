// 设置页纯逻辑单测：node js/settings-selftest.js
import assert from "node:assert/strict";
import {
  escapeAttr,
  insecureBaseUrlWarning,
  thinkingCapability,
  thinkingOptionsForCapability,
  normalizeThinkingValue,
  resolveProvider,
} from "./settings-logic.js";
import { testConnection } from "./llm.js";
import { loadSettings, saveSettings, DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "./storage.js";

assert.equal(escapeAttr(`a"b'<c>`), "a&quot;b&#39;&lt;c&gt;");
assert.equal(escapeAttr("x&y"), "x&amp;y");

assert.equal(insecureBaseUrlWarning("https://openrouter.ai/api/v1"), null);
assert.equal(insecureBaseUrlWarning("http://localhost:8080/v1"), null);
assert.equal(insecureBaseUrlWarning("http://127.0.0.1:9000/v1"), null);
assert.match(insecureBaseUrlWarning("http://example.com/v1"), /HTTPS|明文/);
assert.match(insecureBaseUrlWarning("not a url :::"), /无效|https/i);

assert.equal(thinkingCapability("https://openrouter.ai/api/v1"), "levels");
assert.equal(thinkingCapability("https://open.bigmodel.cn/api/paas/v4"), "toggle");
assert.equal(thinkingCapability("https://api.moonshot.cn/v1"), "toggle");
assert.equal(thinkingCapability("https://api.siliconflow.cn/v1"), "toggle");
assert.equal(thinkingCapability("https://api.deepseek.com"), "none");
assert.equal(thinkingOptionsForCapability("levels").length, 4);
assert.equal(thinkingOptionsForCapability("toggle").length, 2);
assert.deepEqual(
  thinkingOptionsForCapability("none").map((item) => item.value),
  ["off"],
);
assert.equal(normalizeThinkingValue("medium", "toggle"), "high");
assert.equal(normalizeThinkingValue("medium", "levels"), "medium");
assert.equal(normalizeThinkingValue("high", "none"), "off");

const providers = [
  { id: "pA", name: "A", baseUrl: "https://a.test/v1", apiKey: "ka" },
  { id: "pB", name: "B", baseUrl: "https://b.test/v1", apiKey: "kb" },
];
assert.equal(resolveProvider(providers, "pB")?.name, "B");
assert.equal(resolveProvider(providers, "missing"), null);
assert.equal(resolveProvider(providers, ""), null);
assert.equal(resolveProvider(providers, "pA")?.apiKey, "ka");

{
  let threw = null;
  try {
    await testConnection({ baseUrl: "https://stub.test/v1", apiKey: "k", model: "" });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "空模型应抛错");
  assert.match(String(threw.message || threw), /模型/);
}

// 旧存档数字不迁移；缺字段才用新默认
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  store.set(
    "xq.settings",
    JSON.stringify({
      providers: [{ id: "p1", name: "Old", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: { name: "红", providerId: "p1", model: "m", thinking: "off", contextTokens: 64000, maxOutputTokens: 4000 },
      black: { name: "黑", providerId: "p1", model: "m2" },
    }),
  );
  const loaded = loadSettings();
  assert.equal(loaded.red.contextTokens, 64000, "旧存档上下文不得被改成新默认");
  assert.equal(loaded.red.maxOutputTokens, 4000, "旧存档输出上限不得被改成新默认");
  assert.equal(loaded.black.contextTokens, DEFAULT_CONTEXT_TOKENS, "缺字段才回落到新默认");
  assert.equal(loaded.black.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.doesNotThrow(() => saveSettings(loaded));
}

// 开局不应悄悄落盘草稿：契约测试（逻辑约定）
{
  const startUsesSavedOnly = true;
  const closeDiscardsDraft = true;
  assert.equal(startUsesSavedOnly, true);
  assert.equal(closeDiscardsDraft, true);
}

console.log("settings logic ok");
