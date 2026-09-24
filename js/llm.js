const TOOL_NAMES = new Set(["look_board", "legal_moves", "commit_move", "resign"]);

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "look_board",
      description: "查看当前棋盘、FEN、轮到谁、是否被将军，以及最近着法。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "legal_moves",
      description: "列出本方全部合法着法。回合消息已附上合法着法时一般不必再调；需要复核时再用。每行是 ICCS 坐标和中文记谱。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_move",
      description: "提交本步着法并结束本轮。move 必须是本回合合法着法列表中的 ICCS，例如 h2e2。",
      parameters: {
        type: "object",
        properties: {
          move: { type: "string", description: "ICCS 坐标，例如 h2e2" },
          thought: { type: "string", description: "不超过 80 字的取舍理由" },
        },
        required: ["move", "thought"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resign",
      description: "认输并结束本局。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "认输理由" },
        },
        required: ["thought"],
      },
    },
  },
];

function rootUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/$/, "");
}

// 思考强度：各家开关字段不同，按厂商地址挑方言；认不出的厂商一律不发，
// 免得未知字段被 400 拒掉（真被拒了也有兜底：match 会退回不带该参数重发）。
export function thinkingParams(baseUrl, thinking) {
  if (!thinking) return null;
  const level = ["off", "low", "medium", "high"].includes(thinking) ? thinking : "off";
  const host = String(baseUrl || "").toLowerCase();
  if (host.includes("openrouter.ai")) {
    return level === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: level } };
  }
  if (host.includes("bigmodel.cn") || host.includes("zhipu")) {
    return { thinking: { type: level === "off" ? "disabled" : "enabled" } };
  }
  if (host.includes("siliconflow.cn") || host.includes("dashscope") || host.includes("aliyuncs.com")) {
    return { enable_thinking: level !== "off" };
  }
  if (host.includes("moonshot.cn")) {
    return { thinking: { type: level === "off" ? "disabled" : "enabled" } };
  }
  return null;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (error?.name === "AbortError" || attempt >= retries) throw error;
      await wait(Math.min(1500 * 2 ** attempt, 12000));
      continue;
    }
    if (!RETRY_STATUS.has(response.status) || attempt >= retries) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const ms = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 15) * 1000
      : Math.min(1500 * 2 ** attempt, 12000);
    await wait(ms);
  }
}

export function formatFetchError(error) {
  if (error?.name === "AbortError") return error;
  const message = String(error?.message || error || "");
  if (message === "Failed to fetch" || error?.name === "TypeError") {
    return new Error("请求没有发出去，通常是该厂商不支持浏览器跨域直连（未返回 Access-Control-Allow-Origin 响应头）。地址和密钥再对也绕不过这道浏览器检查。已验证支持浏览器直连：SiliconFlow、DeepSeek、Kimi/Moonshot、智谱、OpenRouter。");
  }
  return error instanceof Error ? error : new Error(message);
}

function normalizeArguments(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function accumulate(acc, delta) {
  if (!delta) return;
  if (typeof delta.reasoning_content === "string") acc.reasoning += delta.reasoning_content;
  if (typeof delta.reasoning === "string") acc.reasoning += delta.reasoning;
  if (typeof delta.content === "string") acc.content += delta.content;
  for (const call of delta.tool_calls || []) {
    // 缺 index：有 id 则按 id 归槽（新 id 开新槽）；否则接到已有最后一槽。带 index 的并行调用不受影响。
    let index = call.index;
    if (typeof index === "string" && /^\d+$/.test(index)) index = Number(index);
    if (index == null || !Number.isFinite(index)) {
      if (call.id) {
        const existing = acc.toolCalls.findIndex((item) => item && item.id === call.id);
        index = existing >= 0 ? existing : acc.toolCalls.length;
      } else {
        index = acc.toolCalls.length ? acc.toolCalls.length - 1 : 0;
        while (index > 0 && !acc.toolCalls[index]) index -= 1;
      }
    }
    if (!acc.toolCalls[index]) acc.toolCalls[index] = { index, id: "", name: "", arguments: "" };
    const item = acc.toolCalls[index];
    if (call.id) item.id = call.id;
    if (call.function?.name) item.name = mergeDelta(item.name, String(call.function.name));
    if (call.function?.arguments != null) {
      item.arguments = mergeDelta(item.arguments, normalizeArguments(call.function.arguments));
    }
  }
}

function parsePayload(data) {
  const json = JSON.parse(data);
  if (json.error) {
    const message = json.error.message || JSON.stringify(json.error);
    throw new Error(message);
  }
  return json;
}

async function readStream(response, onDelta, markData) {
  const acc = { content: "", reasoning: "", toolCalls: [] };
  const reader = response.body?.getReader();
  if (!reader) {
    markData?.();
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const choice = json.choices?.[0] || {};
    const message = choice.message || {};
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    accumulate(acc, message);
    if (message.tool_calls) {
      acc.toolCalls = message.tool_calls.map((call, index) => ({
        index,
        id: call.id || "",
        name: call.function?.name || "",
        arguments: normalizeArguments(call.function?.arguments),
      }));
    }
    onDelta?.(snapshot(acc));
    return acc;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    const lines = (buffer + text).split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      // 只有 data 行才算“有效数据”：注释行与空行（keep-alive）不喂看门狗
      if (line.trimStart().startsWith("data:")) markData?.();
      consumeLine(line, acc, onDelta);
    }
  }
  if (buffer.trim()) consumeLine(buffer, acc, onDelta);
  return acc;
}

function consumeLine(line, acc, onDelta) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;
  let json;
  try {
    json = parsePayload(data);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  accumulate(acc, choice?.delta || choice?.message);
  onDelta?.(snapshot(acc));
}

function mergeDelta(current, next) {
  if (!next) return current;
  if (!current || next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  return current + next;
}

function snapshot(acc) {
  return {
    content: acc.content,
    reasoning: acc.reasoning,
    toolCalls: acc.toolCalls.filter(Boolean).map((call) => ({ ...call })),
    finishReason: acc.finishReason || null,
  };
}

function sliceJsonObject(text, start) {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") quote = false;
      continue;
    }
    if (ch === "\"") quote = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

export function textToolCalls(content) {
  const text = String(content || "");
  const found = [];
  const nameRe = /"name"\s*:\s*"(look_board|legal_moves|commit_move|resign)"/g;
  let match;
  while ((match = nameRe.exec(text))) {
    const name = match[1];
    const window = text.slice(Math.max(0, match.index - 80), match.index + 800);
    const argKey = window.search(/"arguments"\s*:/);
    let args = "{}";
    if (argKey >= 0) {
      const brace = window.indexOf("{", argKey);
      if (brace >= 0) args = sliceJsonObject(window, brace) || "{}";
    }
    if (TOOL_NAMES.has(name)) found.push({ index: found.length, id: "", name, arguments: args });
  }
  return found;
}

export function normalizeCalls(acc) {
  const native = (acc.toolCalls || []).filter((call) => call.name);
  if (native.length) return native;
  return textToolCalls(`${acc.reasoning || ""}\n${acc.content || ""}`);
}

function isTransientMessage(text) {
  return /HTTP (408|429|500|502|503|504)|overloaded|temporar|rate.?limit|too many requests/i.test(
    String(text || ""),
  );
}

class TransientError extends Error {}

const STALL_TIMEOUT_MS = 100000;
const MAX_ATTEMPTS = 4;
const RETRY_BUDGET_MS = 900000;

// 每日额度/余额类错误重试没有意义，直接判定为致命
function isFatalQuotaError(text) {
  return /per-day|daily limit|free-models-per-day|insufficient|add \d+ credits|balance/i.test(String(text || ""));
}

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

// 单次请求 = 看门狗保护下的完整对话。看门狗只认“有意义的 data 行”：
// 上游的注释行/keep-alive 空包不喂计时器，假死 100 秒即掐断；
// 数据仍在流动的长推理不设上限——真正的预算是对局时钟。
async function streamChatOnce({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens, thinking, signal, onDelta }) {
  const watchdog = new AbortController();
  let reason = null;
  let lastDataAt = Date.now();
  const markData = () => {
    lastDataAt = Date.now();
  };
  const stallTimer = setInterval(() => {
    if (Date.now() - lastDataAt > STALL_TIMEOUT_MS) {
      reason = "stall";
      watchdog.abort();
    }
  }, 3000);
  const onOuterAbort = () => {
    reason = "outer";
    watchdog.abort();
  };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let response;
    try {
      response = await fetchWithRetry(
        `${rootUrl(baseUrl)}/chat/completions`,
        {
          method: "POST",
          signal: watchdog.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            tools,
            temperature,
            max_tokens: maxTokens ?? 8000,
            stream: true,
            ...(thinkingParams(baseUrl, thinking) || {}),
          }),
        },
        3,
      );
    } catch (error) {
      if (reason === "stall") throw new TransientError("上游 100 秒无有效数据，已掐断");
      if (error instanceof TypeError) throw formatFetchError(error);
      throw error;
    }
    markData();
    if (!response.ok) {
      const text = await response.text();
      const message = `HTTP ${response.status}：${text.slice(0, 360)}`;
      if (RETRY_STATUS.has(response.status)) throw new TransientError(message);
      throw new Error(message);
    }
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const json = await response.json();
      if (json.error) {
        const message = json.error.message || JSON.stringify(json.error);
        if (isTransientMessage(message)) throw new TransientError(message);
        throw new Error(message);
      }
      const choice = json.choices?.[0] || {};
      const message = choice.message || {};
      const acc = {
        content: message.content || "",
        reasoning: message.reasoning_content || message.reasoning || "",
        toolCalls: (message.tool_calls || []).map((call, index) => ({
          index,
          id: call.id || "",
          name: call.function?.name || "",
          arguments: normalizeArguments(call.function?.arguments),
        })),
        finishReason: choice.finish_reason || undefined,
      };
      onDelta?.(snapshot(acc));
      return acc;
    }
    return await readStream(response, onDelta, markData);
  } catch (error) {
    if (reason === "stall") {
      throw new TransientError("流式响应 100 秒没有有效数据，已掐断重试");
    }
    throw error;
  } finally {
    clearInterval(stallTimer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function streamChat(options) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await streamChatOnce(options);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (isFatalQuotaError(error?.message)) throw error;
      const transient = error instanceof TransientError || isTransientMessage(error?.message);
      if (!transient) throw error;
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS || Date.now() - started > RETRY_BUDGET_MS) {
        throw error instanceof TransientError
          ? new Error(`上游持续不可用，已重试 ${attempt} 次：${error.message}`)
          : error;
      }
      await wait(Math.min(1500 * 2 ** attempt, 15000));
    }
  }
}

export async function testConnection({ baseUrl, apiKey, model, signal }) {
  const root = rootUrl(baseUrl);
  try {
    const listed = await fetch(`${root}/models`, {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (listed.ok) {
      const json = await listed.json();
      const ids = (json.data || []).map((item) => item.id).filter(Boolean);
      return { ok: true, message: ids.length ? `已连通，${ids.length} 个模型` : "已连通", models: ids };
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const wrapped = formatFetchError(error);
    if (wrapped.message.includes("跨域")) throw wrapped;
  }
  const acc = await streamChat({
    baseUrl,
    apiKey,
    model: model || "Qwen/Qwen3.8-27B",
    messages: [{ role: "user", content: "回复一个字：好" }],
    temperature: 0,
    maxTokens: 32,
    signal,
  });
  return { ok: true, message: acc.content ? "对话接口可用" : "接口有响应", models: [] };
}
