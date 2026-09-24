/** 设置页纯逻辑：便于单测，不碰 DOM。 */

export function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @returns {null | string} 警告文案；localhost/127.0.0.1 的 http 不警告 */
export function insecureBaseUrlWarning(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return "接口地址缺少协议（请使用 https://…）";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "接口地址格式无效";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return null;
    return "接口地址不是 HTTPS，API Key 会明文传输";
  }
  return "接口地址应使用 https://";
}

/**
 * 开局门闩：有未保存草稿则拒绝（开局只用已保存设置）。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function settingsForStart({ dirty }) {
  if (dirty) return { ok: false, reason: "dirty" };
  return { ok: true };
}

/** 取消设置：丢弃草稿，返回已保存快照的深拷贝 */
export function discardSettingsDraft(saved) {
  if (!saved) return saved;
  return JSON.parse(JSON.stringify(saved));
}

/**
 * 按 Base URL 判断思考强度实际能力：
 * - levels: OpenRouter（off/low/medium/high）
 * - toggle: 智谱 / Kimi / SiliconFlow 等（仅开/关）
 * - none: 不发送该参数（如 DeepSeek）
 */
export function thinkingCapability(baseUrl) {
  const host = String(baseUrl || "").toLowerCase();
  if (host.includes("openrouter.ai")) return "levels";
  if (
    host.includes("bigmodel.cn")
    || host.includes("zhipu")
    || host.includes("moonshot.cn")
    || host.includes("siliconflow.cn")
    || host.includes("dashscope")
    || host.includes("aliyuncs.com")
  ) {
    return "toggle";
  }
  return "none";
}

export function thinkingOptionsForCapability(capability) {
  if (capability === "levels") {
    return [
      { value: "off", label: "不思考" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
    ];
  }
  if (capability === "toggle") {
    return [
      { value: "off", label: "关" },
      { value: "high", label: "开" },
    ];
  }
  return [{ value: "off", label: "不支持（不发送）" }];
}

/** 规范化存档里的思考档位到当前厂商可选值 */
export function normalizeThinkingValue(value, capability) {
  const raw = ["off", "low", "medium", "high"].includes(value) ? value : "off";
  if (capability === "levels") return raw;
  if (capability === "toggle") return raw === "off" ? "off" : "high";
  return "off";
}

/** 按 id 查找供应商；找不到返回 null（绝不回落到列表第一项） */
export function resolveProvider(providers, id) {
  if (!id || !Array.isArray(providers)) return null;
  return providers.find((provider) => provider.id === id) || null;
}
