// 设置页纯逻辑单测：node js/settings-selftest.js
import assert from "node:assert/strict";
import {
  escapeAttr,
  insecureBaseUrlWarning,
  thinkingCapability,
  thinkingOptionsForCapability,
  normalizeThinkingValue,
  resolveProvider,
  settingsForStart,
  discardSettingsDraft,
} from "./settings-logic.js";
import { testConnection, thinkingParams } from "./llm.js";
import { loadSettings, saveSettings, DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "./storage.js";

assert.equal(escapeAttr(`a"b'<c>`), "a&quot;b&#39;&lt;c&gt;");
assert.equal(escapeAttr("x&y"), "x&amp;y");

assert.equal(insecureBaseUrlWarning("https://openrouter.ai/api/v1"), null);
assert.equal(insecureBaseUrlWarning("http://localhost:8080/v1"), null);
assert.equal(insecureBaseUrlWarning("http://127.0.0.1:9000/v1"), null);
assert.match(insecureBaseUrlWarning("http://example.com/v1"), /HTTPS|明文/);
assert.match(insecureBaseUrlWarning("not a url :::"), /缺少协议|无效|https/i);
assert.match(insecureBaseUrlWarning("api.example.com/v1"), /缺少协议/);
assert.match(insecureBaseUrlWarning("example.com"), /缺少协议/);

assert.equal(thinkingCapability("https://openrouter.ai/api/v1"), "levels");
assert.equal(thinkingCapability("https://open.bigmodel.cn/api/paas/v4"), "toggle");
assert.equal(thinkingCapability("https://api.moonshot.cn/v1"), "toggle");
assert.equal(thinkingCapability("https://api.siliconflow.cn/v1"), "toggle");
assert.equal(thinkingCapability("https://api.deepseek.com"), "none");
assert.equal(thinkingCapability("https://api.xiaomimimo.com/v1"), "toggle", "小米 MiMo 可开关思考");
assert.equal(thinkingCapability("https://api.xiaomimimo.com/v1/"), "toggle");
assert.equal(normalizeThinkingValue("off", thinkingCapability("https://api.xiaomimimo.com/v1")), "off");
assert.equal(normalizeThinkingValue("high", thinkingCapability("https://api.xiaomimimo.com/v1")), "high");
assert.deepEqual(
  thinkingParams("https://api.xiaomimimo.com/v1", "off"),
  { thinking: { type: "disabled" } },
  "MiMo off → thinking.type disabled",
);
assert.deepEqual(
  thinkingParams("https://api.xiaomimimo.com/v1", "high"),
  { thinking: { type: "enabled" } },
  "MiMo on → thinking.type enabled",
);
assert.equal(thinkingParams("https://api.deepseek.com", "off"), null, "未知/none 厂商不发思考字段");
assert.equal(thinkingParams("https://api.xiaomimimo.com/v1", null), null, "thinking 空值不发");
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

// 开局 / 取消：真实状态迁移（可失败的契约）
{
  assert.deepEqual(settingsForStart({ dirty: false }), { ok: true });
  assert.deepEqual(settingsForStart({ dirty: true }), { ok: false, reason: "dirty" });

  const saved = {
    providers: [{ id: "p1", name: "A", baseUrl: "https://a.test/v1", apiKey: "k" }],
    red: { name: "红", providerId: "p1", model: "m1", thinking: "off" },
    black: { name: "黑", providerId: "p1", model: "m2", thinking: "off" },
  };
  let draft = { ...saved, red: { ...saved.red, model: "draft-model" } };
  assert.notEqual(draft.red.model, saved.red.model);
  draft = discardSettingsDraft(saved);
  assert.equal(draft.red.model, "m1", "取消应恢复已保存模型");
  draft.red.model = "mutated";
  assert.equal(saved.red.model, "m1", "丢弃草稿不得改写已保存对象");
  assert.equal(settingsForStart({ dirty: false }).ok, true);
}

console.log("settings logic ok");
