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
      description: "列出本方全部合法着法。正式落子前应先调用。每行是 ICCS 坐标和中文记谱。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_move",
      description: "提交本步着法并结束本轮。move 必须是 legal_moves 给出的 ICCS，例如 h2e2。",
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

function accumulate(acc, delta) {
  if (!delta) return;
  if (typeof delta.reasoning_content === "string") acc.reasoning += delta.reasoning_content;
  if (typeof delta.reasoning === "string") acc.reasoning += delta.reasoning;
  if (typeof delta.content === "string") acc.content += delta.content;
  for (const call of delta.tool_calls || []) {
    const index = call.index ?? acc.toolCalls.length;
    if (!acc.toolCalls[index]) acc.toolCalls[index] = { index, id: "", name: "", arguments: "" };
    const item = acc.toolCalls[index];
    if (call.id) item.id = call.id;
    if (call.function?.name) item.name = mergeDelta(item.name, String(call.function.name));
    if (call.function?.arguments != null) {
      const next = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments);
      item.arguments = mergeDelta(item.arguments, next);
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

async function readStream(response, onDelta) {
  const acc = { content: "", reasoning: "", toolCalls: [] };
  const reader = response.body?.getReader();
  if (!reader) {
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const message = json.choices?.[0]?.message || {};
    accumulate(acc, message);
    if (message.tool_calls) {
      acc.toolCalls = message.tool_calls.map((call, index) => ({
        index,
        id: call.id || "",
        name: call.function?.name || "",
        arguments: call.function?.arguments || "",
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
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line, acc, onDelta);
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
  accumulate(acc, json.choices?.[0]?.delta || json.choices?.[0]?.message);
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

function isTransientChatError(error) {
  if (error?.name === "AbortError") return false;
  return /HTTP (408|429|500|502|503|504)|overloaded|temporar|rate.?limit|too many requests/i.test(
    String(error?.message || ""),
  );
}

export async function streamChat(options) {
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await streamChatOnce(options);
    } catch (error) {
      if (!isTransientChatError(error)) throw error;
      last = error;
      await wait(Math.min(1500 * 2 ** attempt, 12000));
    }
  }
  throw last;
}

async function streamChatOnce({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens, signal, onDelta }) {
  let response;
  try {
    response = await fetchWithRetry(`${rootUrl(baseUrl)}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        temperature,
        max_tokens: maxTokens ?? 4096,
        stream: true,
      }),
    });
  } catch (error) {
    throw formatFetchError(error);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}：${text.slice(0, 360)}`);
  }
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const message = json.choices?.[0]?.message || {};
    const acc = {
      content: message.content || "",
      reasoning: message.reasoning_content || message.reasoning || "",
      toolCalls: (message.tool_calls || []).map((call, index) => ({
        index,
        id: call.id || "",
        name: call.function?.name || "",
        arguments: call.function?.arguments || "",
      })),
    };
    onDelta?.(snapshot(acc));
    return acc;
  }
  return readStream(response, onDelta);
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
