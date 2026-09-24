import {
  applyMove,
  asciiBoard,
  inCheck,
  pieceChar,
  legalMoves,
  opposite,
  parseIcCS,
  positionKey,
  sideName,
  startingPosition,
  terminalStatus,
  toFEN,
} from "./engine.js";
import { toNotation } from "./notation.js";
import { TOOLS, normalizeCalls, streamChat } from "./llm.js";
import { clip, DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "./storage.js";

const MAX_STEPS = 8;
const MAX_FAILURES = 3;
const DRAW_PLIES = 120;
// 输出被上限截断时不带半截文本重发，只在配置上限内抬高；连续截断超过这个次数就交给裁判代走
const MAX_TRUNCATIONS = 2;
/** 上下文占用达到窗口的该比例时开始压缩历史（再与「窗口 − 输出上限」取较小值） */
export const CONTEXT_COMPRESS_RATIO = 0.8;

/** 压缩/trim 预算：min(比例×窗口, 窗口−输出)，保证 请求+输出 不顶破上下文窗 */
export function contextBudget(contextTokens, maxOutputTokens = 0) {
  const ctx = Number(contextTokens) > 0 ? Number(contextTokens) : DEFAULT_CONTEXT_TOKENS;
  const out = Math.max(0, Number(maxOutputTokens) || 0);
  const byRatio = Math.floor(ctx * CONTEXT_COMPRESS_RATIO);
  const byWindow = ctx - out;
  return Math.max(0, Math.min(byRatio, byWindow));
}

function configuredOutputCap(player) {
  const ctx = Number(player?.contextTokens) > 0 ? Number(player.contextTokens) : DEFAULT_CONTEXT_TOKENS;
  const out = Number(player?.maxOutputTokens) > 0 ? Number(player.maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  // 输出上限不得超过配置值，也不得超过整个上下文窗
  return Math.max(256, Math.min(out, ctx));
}

/** 截断重试时裁判日志文案。
 * - givingUp / hardCap：原语义
 * - roomLimited：本请求实际 max_tokens（sendCap）低于当时配置 cap（上下文余量夹紧），不说「已放宽」
 * - raised：配置 cap 真的抬高了，且本次并非余量夹紧
 * - else：已在配置顶
 * sendCap 为触发截断的那次请求实际下发的 max_tokens；cap 为抬限尝试之后的配置软顶。
 */
export function truncationNudgeText({ truncations, givingUp, hardCap, raised, cap, sendCap, roomLimited }) {
  const k = Math.round(Number(cap) / 1000);
  const sk = Math.round(Number(sendCap ?? cap) / 1000);
  if (givingUp) {
    return `分析过长被截断未落子（第 ${truncations} 次）。连续被截断，裁判代走。`;
  }
  if (hardCap) {
    return `分析过长被截断未落子（第 ${truncations} 次）。该模型输出上限 ${sk}k 是硬顶，只能催它直接落子。`;
  }
  if (roomLimited) {
    return `分析过长被截断未落子（第 ${truncations} 次）。本请求实际输出上限 ${sk}k（配置 ${k}k，受上下文余量限制），只能催促直接落子。`;
  }
  if (raised) {
    return `分析过长被截断未落子（第 ${truncations} 次）。已放宽输出上限到 ${k}k 并催促直接落子。`;
  }
  return `分析过长被截断未落子（第 ${truncations} 次）。输出上限已是配置的 ${k}k，只能催促直接落子。`;
}

/** 截断重试时的 phase 文案：余量夹紧 / 未抬高时不暗示「放宽」 */
export function truncationRetryPhase({ hardCap, raised, cap, sendCap, roomLimited }) {
  const k = Math.round(Number(cap) / 1000);
  const sk = Math.round(Number(sendCap ?? cap) / 1000);
  if (hardCap) return `重试 · 输出被截断（上限 ${sk}k 硬顶）`;
  if (roomLimited) return `重试 · 输出被截断（实际上限 ${sk}k，上下文余量）`;
  if (raised) return `重试 · 输出超长被截断（上限 ${k}k）`;
  return `重试 · 输出被截断（已是配置上限 ${k}k）`;
}

const TRACE_KIND_ORDER = { think: 0, say: 1, tool: 2, nudge: 3 };

// 同一回合内的条目按（步序，类型）排出确定次序：流式回调的到达顺序不影响棋谱时序
function traceOrder(entry) {
  const match = String(entry?.id || "").match(/^(think|say|tool|nudge)-(\d+)(?:-(\d+))?$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const sub = match[3] ? Number(match[3]) : 0;
  return Number(match[2]) * 1000 + TRACE_KIND_ORDER[match[1]] * 100 + sub;
}

function traceAdd(trace, entry) {
  const order = traceOrder(entry);
  let at = trace.length;
  for (let i = 0; i < trace.length; i += 1) {
    if (traceOrder(trace[i]) > order) {
      at = i;
      break;
    }
  }
  trace.splice(at, 0, entry);
  return entry;
}

export function systemPrompt(side) {
  const name = sideName(side);
  return [
    `你是中国象棋智能体，本局执${name}。裁判在本地，你不能用文字宣称已经走子。`,
    "每步消息都会附上当前盘面、双方子力与全部合法着法；move 必须逐字来自该合法着法列表。",
    "look_board / legal_moves 仍可调用，但盘面与合法着法已附上，一般不必重复查询。",
    "请先在合法着法中寻找将军与吃子，尤其是将杀进攻以及对己方将/帅的威胁；再考虑防守与计划；想清楚后调用 commit_move 提交。",
    "调用 commit_move 提交 ICCS 坐标，或调用 resign 认输。非法着法会被工具拒绝，然后你再选；连续多次违规或未落子时，裁判会从合法着法中随机代走一步（不会因此判负）。",
    "胜负由裁判裁定：将死、困毙、认输、超时。长将方负。同一局面三次重复且不是单方长将，则和棋。连续 120 步无吃子，和棋。",
  ].join("\n");
}

const PIECE_TYPE_ORDER = ["K", "A", "B", "N", "R", "C", "P"];

export function piecesSummary(pos) {
  const summarize = (side) => {
    const groups = {};
    for (let rank = 0; rank < 10; rank += 1) {
      for (let file = 0; file < 9; file += 1) {
        const cell = pos.board[rank][file];
        if (!cell || cell.side !== side) continue;
        if (!groups[cell.type]) groups[cell.type] = { name: pieceChar(cell), squares: [] };
        groups[cell.type].squares.push(`${"abcdefghi"[file]}${rank}`);
      }
    }
    const parts = PIECE_TYPE_ORDER.filter((type) => groups[type]).map((type) => {
      const group = groups[type];
      return group.squares.length === 1
        ? `${group.name}${group.squares[0]}`
        : `${group.name}×${group.squares.length}（${group.squares.join("、")}）`;
    });
    return `${sideName(side)}：${parts.join(" ") || "无子"}`;
  };
  return `${summarize("r")}\n${summarize("b")}`;
}

export function buildTurnUserMessage(pos, records, legal) {
  const round = Math.floor(records.length / 2) + 1;
  const last = records.length ? records[records.length - 1] : null;
  const legalLines = legal.map((move) => `${move.iccs} ${toNotation(pos, move)}`).join("\n");
  const opponentLine = last
    ? `对方上一手：${last.notation}（${last.iccs}）${last.substitute ? " · 裁判代走" : ""}${last.thought ? `；想法：${last.thought}` : ""}`
    : "这是开局第一步。";
  return [
    `第 ${round} 回合，轮到${sideName(pos.side)}。`,
    opponentLine,
    `被将军：${inCheck(pos, pos.side) ? "是" : "否"}`,
    `距上次吃子 ${pos.halfmove} 步。`,
    `FEN：${toFEN(pos)}`,
    "双方子力：",
    piecesSummary(pos),
    "棋盘（文件 a-i，行号即 ICCS 的数字）：",
    asciiBoard(pos),
    "",
    "全部合法着法（ICCS + 中文记谱），从中选择一步提交：",
    legalLines || "（无）",
    "请调用 commit_move 提交，或 resign 认输。不要只输出文字。",
  ].join("\n");
}

/** 压缩时至少保留的最近完整回合数（含 tool 对） */
export const KEEP_RECENT_TURNS = 2;

const COMPACT_SYSTEM = [
  "你是中国象棋对局的记忆压缩器，正在为同一名执棋智能体浓缩更早的对话。",
  "请根据提供的历史，用简洁中文写出一份给未来自己的摘要，保留：",
  "己方计划与意图、看到的威胁与战术主题、对手倾向、关键交换/失子、当前形势判断。",
  "不要列出全部着法，不要调用工具，不要续写下一手。只输出摘要正文。",
].join("");

function cloneMessages(messages) {
  return (messages || []).map((message) => {
    const copy = { ...message };
    if (message.tool_calls) copy.tool_calls = message.tool_calls.map((call) => ({ ...call, function: call.function ? { ...call.function } : call.function }));
    if (message._meta) copy._meta = { ...message._meta };
    return copy;
  });
}

/** 完整保留会话（不再折叠盘面、不截断 reasoning） */
export function packMemory(messages) {
  return cloneMessages(messages);
}

export function rebuildMemoryFromRecords(side, records) {
  const messages = [{ role: "system", content: systemPrompt(side) }];
  (records || []).forEach((record, index) => {
    if (record.side !== side) return;
    const turnPly = index;
    messages.push({
      role: "user",
      content: `（第${Math.floor(turnPly / 2) + 1}回合盘面未存档；你走了 ${record.iccs} ${record.notation}${record.substitute ? " · 裁判代走" : ""}。想法：${record.thought || "无"}）`,
      _meta: { kind: "turn", turnPly, full: false },
    });
    if (record.substitute) {
      messages.push({
        role: "user",
        content: `（裁判代走）因模型未有效落子，裁判替你走了 ${record.iccs} ${record.notation}。`,
        _meta: { kind: "substitute", turnPly },
      });
      return;
    }
    const callId = `restored_${side}_${turnPly}_${record.iccs}`;
    messages.push({
      role: "assistant",
      content: record.thought || "",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: "commit_move",
            arguments: JSON.stringify({ move: record.iccs, thought: record.thought || "" }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: callId,
      name: "commit_move",
      content: `已接受 ${record.iccs} ${record.notation}`,
    });
  });
  return messages;
}

function findTurnStarts(list) {
  const starts = [];
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].role === "user" && list[i]._meta?.kind === "turn") starts.push(i);
  }
  return starts;
}

function keepStartIndex(list, keepTurns = KEEP_RECENT_TURNS) {
  const starts = findTurnStarts(list);
  if (starts.length <= keepTurns) return 1;
  return starts[starts.length - keepTurns];
}

/** 压缩摘要里每条 reasoning 最多保留的字符，避免把积压的思维链整段再送进 compact 请求 */
export const DIGEST_REASONING_CLIP = 500;

export function digestForCompaction(messages) {
  return (messages || [])
    .map((message) => {
      const bits = [`[${message.role}]`];
      if (message.content) bits.push(String(message.content));
      if (typeof message.reasoning_content === "string" && message.reasoning_content) {
        // 完整 reasoning 已在 memory；摘要只需意向片段。不裁会把数万 token 思维链再次计费。
        const raw = message.reasoning_content;
        const clipped = raw.length > DIGEST_REASONING_CLIP ? `${raw.slice(0, DIGEST_REASONING_CLIP)}…` : raw;
        bits.push(`(reasoning) ${clipped}`);
      }
      if (message.tool_calls?.length) bits.push(`(tool_calls) ${JSON.stringify(message.tool_calls)}`);
      if (message.role === "tool") bits.push(`(tool_call_id=${message.tool_call_id}) name=${message.name || ""}`);
      return bits.join("\n");
    })
    .join("\n---\n");
}

function dropUntilFit(messages, budget) {
  let list = cloneMessages(messages);
  let guard = 0;
  while (messagesTokens(list) > budget && list.length > 2 && guard < 64) {
    guard += 1;
    const currentStart = findCurrentTurnStart(list);
    if (currentStart <= 1) break;
    const next = dropOldestTurn(list, currentStart);
    if (next.length >= list.length) break;
    list = next;
  }
  return sanitizeToolProtocol(list);
}

/**
 * 阈值内：原样返回。超阈值：让模型摘要更早回合，保留最近 KEEP_RECENT_TURNS 个完整回合。
 * 摘要失败则回退为按整回合丢弃（dropUntilFit）。
 */
export async function compactMessages({
  messages,
  contextTokens,
  maxOutputTokens,
  compactRequest,
}) {
  const budget = contextBudget(contextTokens, maxOutputTokens);
  const list = cloneMessages(messages);
  if (messagesTokens(list) <= budget) {
    return { messages: list, compacted: false, fallback: false };
  }
  const keepFrom = keepStartIndex(list, KEEP_RECENT_TURNS);
  const older = list.slice(1, keepFrom);
  const recent = list.slice(keepFrom);
  if (!older.length) {
    return { messages: dropUntilFit(list, budget), compacted: false, fallback: true };
  }
  try {
    if (typeof compactRequest !== "function") throw new Error("no compactRequest");
    const summary = String((await compactRequest(older)) || "").trim() || "（无摘要内容）";
    let next = [
      list[0],
      {
        role: "user",
        content: `【此前对局历史摘要——由你先前的思考压缩而成，供后续回合参考】\n${summary}`,
        _meta: { kind: "summary" },
      },
      ...recent,
    ];
    let fallback = false;
    if (messagesTokens(next) > budget) {
      next = dropUntilFit(next, budget);
      fallback = true;
    }
    return { messages: next, compacted: true, fallback };
  } catch (error) {
    return {
      messages: dropUntilFit(list, budget),
      compacted: false,
      fallback: true,
      error,
    };
  }
}

function stripUnmetToolCalls(result, pending) {
  if (!pending.size || !result.length) return;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const message = result[i];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const kept = message.tool_calls.filter((call) => !pending.has(call.id));
    if (!kept.length) {
      const { tool_calls, ...rest } = message;
      result[i] = rest;
    } else if (kept.length !== message.tool_calls.length) {
      result[i] = { ...message, tool_calls: kept };
    }
    break;
  }
}

function sanitizeToolProtocol(messages) {
  const result = [];
  let pending = new Set();
  for (const message of messages) {
    if (message.role === "assistant") {
      // 上一轮 tool_calls 尚未收齐就又来了 assistant：先削掉未完成的调用
      stripUnmetToolCalls(result, pending);
      const calls = message.tool_calls || [];
      pending = new Set(calls.map((call) => call.id).filter(Boolean));
      result.push(message);
      continue;
    }
    if (message.role === "tool") {
      if (pending.has(message.tool_call_id)) {
        result.push(message);
        pending.delete(message.tool_call_id);
      }
      continue;
    }
    // user / system / 其他：打断未完成的 tool 协议
    stripUnmetToolCalls(result, pending);
    pending = new Set();
    result.push(message);
  }
  stripUnmetToolCalls(result, pending);
  return result;
}

function findCurrentTurnStart(list) {
  for (let i = list.length - 1; i >= 1; i -= 1) {
    if (list[i].role === "user" && list[i]._meta?.kind === "turn") return i;
  }
  for (let i = list.length - 1; i >= 1; i -= 1) {
    if (list[i].role === "user") return i;
  }
  return Math.min(1, Math.max(0, list.length - 1));
}

function dropOldestTurn(list, currentStart) {
  if (currentStart <= 1) return list;
  let start = -1;
  for (let i = 1; i < currentStart; i += 1) {
    if (list[i].role === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return list;
  let end = start + 1;
  while (end < currentStart) {
    const message = list[end];
    if (message.role === "user" && (message._meta?.kind === "turn" || message._meta?.kind === "substitute")) break;
    end += 1;
  }
  return sanitizeToolProtocol([list[0], ...list.slice(end)]);
}

function parseArgs(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  const raw = String(text ?? "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 只接受整串 ICCS（去空白、大小写不敏感），且必须在当前合法着法表里；拒绝子串匹配。
function parseLegalIcCS(raw, legalMap) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-i][0-9][a-i][0-9]$/.test(text)) return null;
  return legalMap.get(text) || null;
}

// 落子后裁定：将死/困毙优先于重复局面，再才是 120 步无吃子（避免将死步碰巧撞上 halfmove=120 被记成和棋）。
export function resolveAfterMove(pos, records, positions) {
  const terminal = terminalStatus(pos);
  if (terminal) return terminal;
  const repeated = repetition(records, positions);
  if (repeated) return repeated;
  if (pos.halfmove >= DRAW_PLIES) return { winner: "draw", reason: "120步无吃子" };
  return null;
}

// 有些厂商/模型的输出上限是硬顶（例如 deepseek-chat 只收 8k）：把上限抬上去会被 400 直接拒掉。
// 这不是模型的问题，认出来退回原上限接着下，别让整局因为一次抬高而中断。
function capRejected(error) {
  const text = String(error?.message || "");
  return /HTTP 4\d\d/.test(text) && /max_?tokens|max_completion_tokens|max(imum)? output/i.test(text);
}

// DeepSeek 官方 API 在带 tools 时要求把上一轮的推理原文（reasoning_content）原样回传，不带会 400。
// 默认不回传（越长的历史越慢），被拒一次之后整局都带上。
function reasoningRejected(error) {
  const text = String(error?.message || "");
  return /HTTP 4\d\d/.test(text) && /reasoning_content/i.test(text);
}

// 厂商不认思考强度那个字段（各家叫法不一）：整局不再发，别让一次 400 把对局打断
function thinkingRejected(error) {
  const text = String(error?.message || "");
  return /HTTP 4\d\d/.test(text) && /reasoning|thinking|enable_thinking/i.test(text) && !/reasoning_content/i.test(text);
}

function repetition(records, positions) {
  const key = positions[positions.length - 1];
  const indices = [];
  positions.forEach((item, index) => {
    if (item === key) indices.push(index);
  });
  if (indices.length < 3) return null;
  const prev = indices[indices.length - 2];
  const last = indices[indices.length - 1];
  let redMoves = 0;
  let redChecks = 0;
  let blackMoves = 0;
  let blackChecks = 0;
  for (let i = prev; i < last; i += 1) {
    const move = records[i];
    if (!move) continue;
    if (move.side === "r") {
      redMoves += 1;
      if (move.gaveCheck) redChecks += 1;
    } else {
      blackMoves += 1;
      if (move.gaveCheck) blackChecks += 1;
    }
  }
  const redPerpetual = redMoves > 0 && redChecks === redMoves;
  const blackPerpetual = blackMoves > 0 && blackChecks === blackMoves;
  if (redPerpetual && !blackPerpetual) return { winner: "b", reason: "长将" };
  if (blackPerpetual && !redPerpetual) return { winner: "r", reason: "长将" };
  return { winner: "draw", reason: "重复局面" };
}

function replay(moves) {
  let pos = startingPosition();
  const positions = [positionKey(pos)];
  const records = [];
  for (const move of moves || []) {
    const parsed = parseIcCS(move.iccs);
    if (!parsed) continue;
    const next = applyMove(pos, parsed);
    records.push({
      ...move,
      side: move.side || pos.side,
      gaveCheck: inCheck(next, next.side),
    });
    positions.push(positionKey(next));
    pos = next;
  }
  return { pos, positions, records };
}

function shapePlayer(raw, fallback) {
  const source = raw || {};
  return {
    name: source.name || fallback.name,
    providerId: source.providerId || fallback.providerId,
    model: source.model || fallback.model,
    thinking: source.thinking || fallback.thinking || "off",
    contextTokens: Number(source.contextTokens) > 0 ? Number(source.contextTokens) : fallback.contextTokens,
    maxOutputTokens: Number(source.maxOutputTokens) > 0 ? Number(source.maxOutputTokens) : fallback.maxOutputTokens,
  };
}

export class Match {
  constructor({ settings, hooks, saved, memory }) {
    this.hooks = hooks;
    this.id = saved?.id || `m_${Date.now()}`;
    this.startedAt = saved?.startedAt || Date.now();
    this.temperature = saved?.temperature ?? settings.temperature;
    this.providers = settings.providers || [];
    this.incrementMs = saved?.incrementMs ?? settings.incrementSeconds * 1000;
    this.players = saved?.players
      ? { r: shapePlayer(saved.players.r, settings.red), b: shapePlayer(saved.players.b, settings.black) }
      : { r: shapePlayer(settings.red, settings.red), b: shapePlayer(settings.black, settings.black) };
    const restored = replay(saved?.moves || []);
    this.pos = restored.pos;
    this.positions = restored.positions;
    this.records = restored.records;
    const main = (saved?.mainMinutes ?? settings.mainMinutes) * 60 * 1000;
    this.mainMinutes = saved?.mainMinutes ?? settings.mainMinutes;
    this.clocks = saved?.clocks || { r: main, b: main };
    // 时钟封顶于起始时制：加秒只补耗时，不让时间倒涨
    this.clocks.r = Math.min(this.clocks.r, main);
    this.clocks.b = Math.min(this.clocks.b, main);
    this.traces = { r: saved?.traces?.r || [], b: saved?.traces?.b || [] };
    // 每条 trace 属于哪一手：没有它，恢复对局后上一手的卡片会被当成新一手的卡片再画一遍。
    // 老存档没记这个字段，按"上一手"算——persist 就发生在落子之后。
    const lastPly = Math.max(0, this.records.length - 1);
    this.tracePly = {
      r: Number.isFinite(saved?.tracePly?.r) ? saved.tracePly.r : lastPly,
      b: Number.isFinite(saved?.tracePly?.b) ? saved.tracePly.b : lastPly,
    };
    this.phase = { r: "", b: "" };
    this.preview = null;
    this.lastMove = this.records[this.records.length - 1] || null;
    this.result = saved?.result || null;
    this.status = "idle";
    this.paused = false;
    this.turnStarted = null;
    this.controller = null;
    this.stopReason = null;
    this.resumeWait = null;
    this.running = false;
    this.timer = 0;
    this.emitTimer = 0;
    // 被截断过的模型不用每回合重新学一遍：把抬高过的输出上限记在手上，下回合直接从这里起步
    this.capFloor = { r: 0, b: 0 };
    // 该接口是否要求把推理原文回传（DeepSeek 官方带 tools 时要求），见 reasoningRejected
    this.echoReasoning = false;
    // 厂商不认思考强度字段时整局不再发，见 thinkingRejected
    this.dropThinking = false;
    // 双方跨回合会话：完整保留。优先 IndexedDB 注入的 memory，其次旧存档里的 memory，否则按棋谱重建。
    const fromIdb = memory && (Array.isArray(memory.r) || Array.isArray(memory.b));
    const fromSaved = saved?.memory && (Array.isArray(saved.memory.r) || Array.isArray(saved.memory.b));
    this.memory = {
      r: fromIdb && memory.r?.length
        ? memory.r
        : fromSaved && saved.memory.r?.length
          ? saved.memory.r
          : rebuildMemoryFromRecords("r", this.records),
      b: fromIdb && memory.b?.length
        ? memory.b
        : fromSaved && saved.memory.b?.length
          ? saved.memory.b
          : rebuildMemoryFromRecords("b", this.records),
    };
  }

  providerOf(side) {
    const id = this.players[side]?.providerId;
    return this.providers.find((provider) => provider.id === id) || null;
  }

  /** 设置页保存后同步到进行中的对局，避免「修好供应商点继续」仍用构造时的旧 providers */
  rebindSettings(settings) {
    if (!settings) return;
    this.providers = settings.providers || [];
    if (settings.temperature != null) this.temperature = settings.temperature;
    this.players = {
      r: shapePlayer(settings.red, this.players.r),
      b: shapePlayer(settings.black, this.players.b),
    };
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      paused: this.paused,
      result: this.result,
      pos: this.pos,
      fen: toFEN(this.pos),
      clocks: this.displayClocks(),
      active: this.status === "finished" || this.status === "idle" ? null : this.pos.side,
      phase: { ...this.phase },
      traces: { r: this.traces.r, b: this.traces.b },
      tracePly: { ...this.tracePly },
      moves: this.records,
      preview: this.preview,
      lastMove: this.lastMove,
      players: this.players,
      checkSide: inCheck(this.pos, this.pos.side) ? this.pos.side : null,
    };
  }

  emit() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = 0;
    }
    this.hooks.onUpdate(this.snapshot());
  }

  // 流式期间每个 token 都重绘会把主线程占满（回合一多就是越下越卡），合并成约每 80ms 一次
  scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = 0;
      this.emit();
    }, 80);
  }

  remaining(side) {
    let ms = this.clocks[side];
    if (this.turnStarted && this.pos.side === side && !this.paused) ms -= Date.now() - this.turnStarted;
    return Math.max(0, ms);
  }

  displayClocks() {
    return { r: this.remaining("r"), b: this.remaining("b") };
  }

  tick() {
    if (this.status !== "playing") return;
    const clocks = this.displayClocks();
    this.hooks.onClock?.(clocks);
    if (this.paused || !this.turnStarted) return;
    if (clocks[this.pos.side] <= 0) {
      this.clocks[this.pos.side] = 0;
      this.turnStarted = null;
      this.stopReason = { winner: opposite(this.pos.side), reason: "超时" };
      this.controller?.abort();
    }
  }

  settleClock() {
    if (!this.turnStarted) return;
    const spent = Date.now() - this.turnStarted;
    const side = this.pos.side;
    this.clocks[side] = Math.max(0, this.clocks[side] - spent);
    this.turnStarted = null;
  }

  persist() {
    // 棋谱等轻量状态进 localStorage；完整会话进 IndexedDB（经 onPersistMemory）
    const ok = this.hooks.onPersist?.(this.serialize({ omitMemory: true }));
    const mem = { r: packMemory(this.memory.r), b: packMemory(this.memory.b) };
    try {
      const result = this.hooks.onPersistMemory?.(this.id, mem);
      if (result && typeof result.then === "function") {
        result.catch?.(() => this.hooks.onMemoryWarn?.("对局记忆写入失败，刷新后可能只按棋谱重建"));
      } else if (result === false) {
        this.hooks.onMemoryWarn?.("对局记忆写入失败，刷新后可能只按棋谱重建");
      }
    } catch {
      this.hooks.onMemoryWarn?.("对局记忆写入失败，刷新后可能只按棋谱重建");
    }
    return ok;
  }

  serialize(options = {}) {
    const data = {
      id: this.id,
      startedAt: this.startedAt,
      temperature: this.temperature,
      incrementMs: this.incrementMs,
      mainMinutes: this.mainMinutes,
      players: this.players,
      moves: this.records.map((item) => ({
        side: item.side,
        iccs: item.iccs,
        notation: item.notation,
        thought: clip(item.thought, 500),
        timeMs: item.timeMs,
        ...(item.substitute ? { substitute: true } : {}),
        trace: (item.trace || []).slice(-8),
      })),
      clocks: this.clocks,
      traces: {
        r: clipTrace(this.traces.r),
        b: clipTrace(this.traces.b),
      },
      tracePly: { ...this.tracePly },
      result: this.result,
    };
    // 默认不把完整会话塞进 localStorage；测试 / 导出可显式 includeMemory
    if (options.includeMemory) {
      data.memory = { r: packMemory(this.memory.r), b: packMemory(this.memory.b) };
    }
    return data;
  }

  appendSubstituteNote(side, move, reason, notation, turnPly = Math.max(0, this.records.length - 1)) {
    if (!this.memory[side]?.length) {
      this.memory[side] = [{ role: "system", content: systemPrompt(side) }];
    }
    this.memory[side].push({
      role: "user",
      content: `（裁判代走）因「${reason || "模型未落子"}」，裁判替你走了 ${move.iccs} ${notation}。请在后续回合基于此局面继续。`,
      _meta: { kind: "substitute", turnPly },
    });
  }

  start() {
    if (this.running) {
      this.resume();
      return;
    }
    this.status = "playing";
    this.paused = false;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 200);
    this.persist();
    this.emit();
    this.run();
  }

  pause() {
    if (this.status !== "playing" || this.paused) return;
    this.settleClock();
    this.paused = true;
    this.phase[this.pos.side] = "已暂停";
    this.controller?.abort();
    this.persist();
    this.emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.stopReason = null;
    this.status = "playing";
    if (!this.running) this.start();
    else this.resumeWait?.();
    this.emit();
  }

  stop() {
    this.stopReason = { winner: null, reason: "中止" };
    this.paused = false;
    this.resumeWait?.();
    if (this.controller) this.controller.abort();
    else if (this.status !== "finished") this.finish(this.stopReason);
  }

  async run() {
    try {
      while (this.status === "playing") {
        if (this.stopReason) {
          this.finish(this.stopReason);
          return;
        }
        if (this.paused) {
          await new Promise((resolve) => {
            this.resumeWait = resolve;
          });
          this.resumeWait = null;
          continue;
        }
        const before = terminalStatus(this.pos);
        if (before) {
          this.finish(before);
          return;
        }
        const provider = this.providerOf(this.pos.side);
        if (!provider?.baseUrl || !provider?.apiKey) {
          this.pause();
          this.hooks.onNeedSettings?.(
            `${this.pos.side === "r" ? "红方" : "黑方"}供应商已失效或缺少密钥，请在设置里重新选择后再继续`,
          );
          continue;
        }
        let outcome;
        try {
          outcome = await this.playTurn();
        } catch (error) {
          if (error?.name === "AbortError") {
            if (this.stopReason) {
              this.finish(this.stopReason);
              return;
            }
            continue;
          }
          this.finish({ winner: null, reason: "中断", detail: error.message || String(error) });
          return;
        }
        if (this.stopReason) {
          this.finish(this.stopReason);
          return;
        }
        if (!outcome) continue;
        if (outcome.kind === "move") {
          this.applyCommitted(outcome);
          const after = resolveAfterMove(this.pos, this.records, this.positions);
          if (after) {
            this.finish(after);
            return;
          }
        } else if (outcome.kind === "resign") {
          this.finish({ winner: opposite(this.pos.side), reason: "认输", detail: outcome.thought });
          return;
        } else if (outcome.kind === "random") {
          // 模型行为失当不终结比赛：裁判从合法着法中随机代走一步，并在棋谱上标出
          const legal = legalMoves(this.pos);
          if (!legal.length) {
            const terminal = terminalStatus(this.pos);
            this.finish(terminal || { winner: opposite(this.pos.side), reason: "无合法着法" });
            return;
          }
          const move = legal[Math.floor(Math.random() * legal.length)];
          const side = this.pos.side;
          const turnPly = this.records.length;
          const reason = outcome.reason || "模型未落子";
          const notation = toNotation(this.pos, move);
          traceAdd(this.traces[side], {
            id: `nudge-sub-${turnPly}`,
            ply: turnPly,
            kind: "tool",
            title: "裁判",
            body: "",
            result: `裁判代走 ${move.iccs} ${notation}（${reason}）`,
            pending: false,
            ok: false,
          });
          // 代走说明必须在 persist 之前写入 memory，否则刷新后存档里没有这条说明
          this.appendSubstituteNote(side, move, reason, notation, turnPly);
          this.applyCommitted({
            move,
            iccs: move.iccs,
            thought: `裁判代走（${reason}）`,
            substitute: true,
          });
          const after = resolveAfterMove(this.pos, this.records, this.positions);
          if (after) {
            this.finish(after);
            return;
          }
        }
      }
    } finally {
      this.running = false;
      clearInterval(this.timer);
    }
  }

  async playTurn() {
    const side = this.pos.side;
    const player = this.players[side];
    const legal = legalMoves(this.pos);
    const legalMap = new Map(legal.map((move) => [move.iccs, move]));
    // 本回合在棋谱里的序号（0 基）：日志条目带着它，回合之间就不会串位
    const turnPly = this.records.length;
    this.tracePly[side] = turnPly;
    const baseCap = configuredOutputCap(player);
    let cap = Math.min(baseCap, this.capFloor[side] > 0 ? this.capFloor[side] : baseCap);
    let hardCap = false; // 厂商拒过抬高后的上限：本回合不再抬
    this.traces[side] = [];
    this.preview = null;
    this.phase[side] = "请求中";
    this.phase[opposite(side)] = "等待";
    if (!this.turnStarted) this.turnStarted = Date.now();
    this.emit();

    if (!this.memory[side]?.length) {
      this.memory[side] = [{ role: "system", content: systemPrompt(side) }];
    }
    const turnUser = {
      role: "user",
      content: buildTurnUserMessage(this.pos, this.records, legal),
      _meta: { kind: "turn", turnPly, full: true },
    };
    // 回合开始前压缩：超阈值则摘要旧回合，失败则整回合丢弃；不在回合中途打断 tool 协议
    const projected = [...this.memory[side], turnUser];
    const budget = contextBudget(player.contextTokens, cap);
    if (messagesTokens(projected) > budget) {
      this.phase[side] = "压缩上下文";
      this.emit();
      const endpoint = this.providerOf(side);
      const result = await compactMessages({
        messages: this.memory[side],
        contextTokens: player.contextTokens,
        maxOutputTokens: cap,
        compactRequest: async (older) => {
          if (!endpoint?.baseUrl || !endpoint?.apiKey) throw new Error("no provider");
          const digest = digestForCompaction(older);
          const acc = await streamChat({
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey,
            model: player.model,
            messages: [
              { role: "system", content: COMPACT_SYSTEM },
              { role: "user", content: digest.slice(0, 120000) },
            ],
            temperature: Math.min(0.3, this.temperature),
            maxTokens: Math.min(4096, baseCap),
            // 必须显式 off：thinking 为 null 时不发禁用字段，小米 MiMo 等会默认开思考再烧一轮
            thinking: "off",
            signal: this.controller?.signal,
          });
          return acc.content || "";
        },
      });
      this.memory[side] = result.messages;
      const note = result.compacted
        ? result.fallback
          ? "上下文已压缩（摘要后仍超限，已再丢弃旧回合）"
          : "上下文已压缩"
        : result.fallback
          ? "上下文压缩失败，已丢弃旧回合"
          : "";
      if (note) {
        traceAdd(this.traces[side], {
          id: `nudge-compact-${turnPly}`,
          ply: turnPly,
          kind: "nudge",
          title: "裁判",
          body: "",
          result: note,
          pending: false,
          ok: result.compacted && !result.fallback,
        });
        this.emit();
      }
    }
    // 本回合在工作副本上推进：截断半截输出仍不回灌；成功或代走后再写回长期记忆
    const messages = [...this.memory[side], turnUser];
    const commitMemory = () => {
      this.memory[side] = cloneMessages(messages);
    };
    let failures = 0;
    let truncations = 0;

    // 输出被上限截断不是模型违规，也不是策略问题：半截文本/半截参数一律不回灌历史
    // （只会让下一次请求更长更慢、更像在自我重复），尝试在配置上限内翻倍后重发。
    // 注意：若本回合一开始就已是 baseCap（默认 32k），翻倍会被夹住、实际抬不上去——
    // 思考默认开时单次即可烧光 max_tokens，连续截断最多约 1+MAX_TRUNCATIONS 次全额 completion。
    // 返回 null 表示已重发，返回对象表示该用裁判代走收场。
    let lastSendCap = cap;
    const truncationRetry = (step, trace) => {
      truncations += 1;
      const givingUp = truncations > MAX_TRUNCATIONS;
      const hitSendCap = lastSendCap;
      const capBefore = cap;
      let raised = false;
      if (!hardCap) {
        // 不超过配置的输出上限，也不超过上下文窗；只有真的抬高了才说「已放宽」
        const next = Math.min(cap * 2, baseCap);
        raised = next > cap;
        cap = next;
        this.capFloor[side] = cap;
      }
      // 触发截断的那次请求：sendCap = min(capBefore, room)。余量夹紧时抬配置顶也救不了当次上限。
      const roomLimited = hitSendCap < capBefore;
      const nudgeArgs = {
        truncations,
        givingUp,
        hardCap,
        raised,
        cap,
        sendCap: hitSendCap,
        roomLimited,
      };
      traceAdd(trace, {
        id: `nudge-${step}`,
        ply: turnPly,
        kind: "tool",
        title: "裁判",
        body: "",
        result: truncationNudgeText(nudgeArgs),
        pending: false,
        ok: false,
      });
      if (givingUp) {
        this.phase[side] = "输出连续被截断";
        this.emit();
        commitMemory();
        return { kind: "random", reason: "输出连续被截断，裁判代走" };
      }
      this.phase[side] = truncationRetryPhase(nudgeArgs);
      messages.push({
        role: "user",
        content: "你上一轮在输出上限处被截断，没有提交着法，那次输出已作废。不要再写分析，直接调用 commit_move 提交一步合法着法。",
      });
      this.emit();
      return null;
    };

    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (this.remaining(side) <= 0) {
        this.stopReason = { winner: opposite(side), reason: "超时" };
        return null;
      }
      this.controller = new AbortController();
      const trace = this.traces[side];
      const think = { id: `think-${step}`, ply: turnPly, kind: "think", title: "思维链", body: "" };
      const say = { id: `say-${step}`, ply: turnPly, kind: "say", title: "输出", body: "" };
      let acc;
      try {
        this.phase[side] = failures ? `重试 ${failures}/${MAX_FAILURES}` : "思考中";
        this.emit();
        const endpoint = this.providerOf(side);
        if (!endpoint?.baseUrl || !endpoint?.apiKey) {
          this.pause();
          this.hooks.onNeedSettings?.("供应商已失效，请在设置里重新选择");
          return null;
        }
        const ctxWindow = Number(player.contextTokens) > 0 ? Number(player.contextTokens) : DEFAULT_CONTEXT_TOKENS;
        const outbound = trimMessages(messages, player.contextTokens, this.echoReasoning, cap);
        // 请求 token + max_tokens 不得超过上下文窗（小窗口/输出≈窗口时尤其关键）
        const room = ctxWindow - messagesTokens(outbound);
        const sendCap = Math.max(1, Math.min(cap, room));
        lastSendCap = sendCap;
        acc = await streamChat({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          model: player.model,
          messages: outbound,
          tools: TOOLS,
          temperature: this.temperature,
          maxTokens: sendCap,
          thinking: this.dropThinking ? null : player.thinking,
          signal: this.controller.signal,
          onDelta: (delta) => {
            if (delta.reasoning) {
              if (!think.body) traceAdd(trace, think);
              think.body = delta.reasoning;
            }
            if (delta.content) {
              if (!say.body) traceAdd(trace, say);
              say.body = delta.content;
            }
            delta.toolCalls.forEach((call, index) => {
              const id = `tool-${step}-${call.index ?? index}`;
              let item = trace.find((entry) => entry.id === id);
              if (!item) {
                item = traceAdd(trace, { id, ply: turnPly, kind: "tool", title: "工具", body: "", result: "", pending: true, ok: true });
              }
              item.title = call.name || "工具";
              item.body = call.arguments;
              const preview = previewMove(call, legalMap);
              if (preview) this.preview = preview;
            });
            this.phase[side] = delta.toolCalls.some((call) => call.name) ? "调用工具" : "思考中";
            this.scheduleEmit();
          },
        });
      } catch (error) {
        // 输出上限被厂商拒了（400）：本轮不再抬，压到厂商肯收的档位重发。
        // 抬高被拒就退回已知可用的基准上限；基准上限本身被拒（用户配得比模型上限还大）就往下压，
        // 不能让它一路抛成"中断"把整局终结掉。
        if (capRejected(error)) {
          const rejected = cap;
          const next = cap > baseCap ? baseCap : cap > 8192 ? 8192 : Math.floor(cap / 2);
          if (next >= 1024 && next < cap) {
            hardCap = true;
            cap = next;
            this.capFloor[side] = 0;
            traceAdd(trace, {
              id: `nudge-${step}`,
              ply: turnPly,
              kind: "tool",
              title: "裁判",
              body: "",
              result: `厂商拒绝了 ${Math.round(rejected / 1000)}k 的输出上限。压到 ${Math.round(cap / 1000)}k 重发。`,
              pending: false,
              ok: false,
            });
            messages.push({ role: "user", content: "不要写分析，直接调用 commit_move 提交一步合法着法。" });
            this.emit();
            continue;
          }
        }
        // 该接口要求回传推理原文：开启后重发，本局后续都带着
        if (!this.echoReasoning && reasoningRejected(error)) {
          this.echoReasoning = true;
          traceAdd(trace, {
            id: `nudge-${step}`,
            ply: turnPly,
            kind: "tool",
            title: "裁判",
            body: "",
            result: "该接口要求把推理原文回传给模型（DeepSeek 官方带 tools 时如此）。已开启后重发。",
            pending: false,
            ok: false,
          });
          this.emit();
          continue;
        }
        // 这家厂商不认思考强度字段：整局不再发这个参数，重发当前这一步
        if (!this.dropThinking && thinkingRejected(error)) {
          this.dropThinking = true;
          traceAdd(trace, {
            id: `nudge-${step}`,
            ply: turnPly,
            kind: "tool",
            title: "裁判",
            body: "",
            result: "该厂商不接受思考强度参数，本局不再发送（思考强度设置对这家无效）。",
            pending: false,
            ok: false,
          });
          this.emit();
          continue;
        }
        throw error;
      } finally {
        this.controller = null;
      }

      const calls = normalizeCalls(acc).map((call, index) => ({
        ...call,
        id: call.id || `call_${step}_${index}`,
      }));
      if (!calls.length) {
        if (acc.finishReason === "length") {
          const stop = truncationRetry(step, trace);
          if (stop) return stop;
          continue;
        }
        messages.push({ role: "assistant", content: acc.content || "（没有调用工具）" });
        traceAdd(trace, {
          id: `nudge-${step}`,
          ply: turnPly,
          kind: "tool",
          title: "裁判",
          body: "",
          result: "没有工具调用。请调用 legal_moves，再调用 commit_move。",
          pending: false,
          ok: false,
        });
        failures += 1;
        this.phase[side] = `重试 ${failures}/${MAX_FAILURES} · 未调用工具`;
        if (failures >= MAX_FAILURES) {
          this.emit();
          commitMemory();
          return { kind: "random", reason: "连续未调用工具，裁判代走" };
        }
        messages.push({
          role: "user",
          content: "你没有调用工具。请先调用 legal_moves，再调用 commit_move 或 resign。不要只用文字给出着法。",
        });
        this.emit();
        continue;
      }

      // 工具调用被上限掐在半截 JSON 上时，同上：不算违规，抬高上限重发
      if (acc.finishReason === "length" && calls.every((call) => parseArgs(call.arguments) === null)) {
        const stop = truncationRetry(step, trace);
        if (stop) return stop;
        continue;
      }

      const assistant = {
        role: "assistant",
        content: acc.content || "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        })),
      };
      // 推理原文默认不回传历史（DeepSeek 官方建议不传，且越长的上下文只会让下一手越慢）；
      // 是否随请求发出、要不要补空串，统一由 trimMessages 按 echoReasoning 决定
      if (acc.reasoning) assistant.reasoning_content = acc.reasoning;
      messages.push(assistant);

      let finished = null;
      for (const call of calls) {
        const executed = this.executeTool(call, legalMap);
        const id = `tool-${step}-${call.index ?? 0}`;
        let item = trace.find((entry) => entry.id === id);
        if (!item) {
          item = traceAdd(trace, { id, ply: turnPly, kind: "tool", title: "工具", body: "", result: "", pending: false, ok: true });
        }
        item.title = call.name;
        item.body = call.arguments || "";
        item.result = executed.text;
        item.ok = executed.ok;
        item.pending = false;
        messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: executed.text });
        if (executed.failure) {
          failures += 1;
          this.phase[side] = `重试 ${failures}/${MAX_FAILURES} · ${executed.reason}`;
        }
        this.emit();
        if (executed.done) {
          finished = executed.outcome;
          break;
        }
        if (failures >= MAX_FAILURES) {
          commitMemory();
          return { kind: "random", reason: executed.reason || "多次违规，裁判代走" };
        }
      }
      if (finished) {
        commitMemory();
        return finished;
      }
      if (step >= 2) {
        messages.push({ role: "user", content: "盘面信息已经足够。请选定一步，调用 commit_move 或 resign，不必再重复查询。" });
      }
    }
    commitMemory();
    return { kind: "random", reason: "多轮未落子，裁判代走" };
  }

  executeTool(call, legalMap) {
    const args = parseArgs(call.arguments);
    if (args === null) {
      return { ok: false, failure: true, reason: "参数无法解析", text: "参数不是合法 JSON。请重新调用工具。" };
    }
    if (call.name === "look_board") {
      return { ok: true, text: this.boardReport() };
    }
    if (call.name === "legal_moves") {
      const lines = [...legalMap.entries()].map(([iccs, move]) => `${iccs} ${toNotation(this.pos, move)}`);
      return { ok: true, text: lines.length ? `共 ${lines.length} 着\n${lines.join("\n")}` : "没有合法着法。" };
    }
    if (call.name === "resign") {
      return {
        ok: true,
        done: true,
        text: "已认输。",
        outcome: { kind: "resign", thought: String(args.thought || "").slice(0, 200) },
      };
    }
    if (call.name === "commit_move") {
      const raw = args.move;
      const chosen = parseLegalIcCS(raw, legalMap);
      if (!chosen) {
        return {
          ok: false,
          failure: true,
          reason: "着法非法",
          text: `非法着法 ${raw == null || raw === "" ? "（空）" : String(raw)}。请重新调用 legal_moves，再从列表中提交一步（move 须为整串 ICCS）。`,
        };
      }
      const thought = String(args.thought || "").slice(0, 200);
      return {
        ok: true,
        done: true,
        text: `已接受 ${chosen.iccs} ${toNotation(this.pos, chosen)}`,
        outcome: { kind: "move", move: chosen, thought, iccs: chosen.iccs },
      };
    }
    return {
      ok: false,
      failure: true,
      reason: "未知工具",
      text: `没有名为 ${call.name} 的工具。可用：look_board、legal_moves、commit_move、resign。`,
    };
  }

  boardReport() {
    const recent = this.records
      .slice(-8)
      .map((item, index) => `${this.records.length - this.records.slice(-8).length + index + 1}. ${item.notation}`)
      .join("\n");
    return [
      `轮到：${sideName(this.pos.side)}`,
      `被将军：${inCheck(this.pos, this.pos.side) ? "是" : "否"}`,
      `无吃子步数：${this.pos.halfmove}`,
      `FEN：${toFEN(this.pos)}`,
      recent ? `最近着法：\n${recent}` : "最近着法：无",
      "棋盘（文件 a-i，行号即 ICCS 的数字）：",
      asciiBoard(this.pos),
    ].join("\n");
  }

  applyCommitted(outcome) {
    const side = this.pos.side;
    const spent = this.turnStarted ? Date.now() - this.turnStarted : 0;
    this.settleClock();
    this.clocks[side] = Math.min(this.clocks[side] + this.incrementMs, this.mainMinutes * 60 * 1000);
    const notation = toNotation(this.pos, outcome.move);
    const next = applyMove(this.pos, outcome.move);
    const record = {
      side,
      iccs: outcome.iccs,
      notation,
      thought: outcome.thought,
      timeMs: spent,
      gaveCheck: inCheck(next, next.side),
      substitute: Boolean(outcome.substitute),
      trace: clipTrace(this.traces[side]),
    };
    this.records.push(record);
    this.positions.push(positionKey(next));
    this.pos = next;
    this.lastMove = record;
    this.preview = null;
    this.phase[side] = notation;
    this.persist();
    this.emit();
  }

  finish(result) {
    if (this.status === "finished") return;
    this.settleClock();
    this.status = "finished";
    this.paused = false;
    this.result = result;
    this.preview = null;
    this.phase[this.pos.side] = result.reason || "结束";
    clearInterval(this.timer);
    this.running = false;
    this.hooks.onFinish(this.exportMatch());
    this.emit();
  }

  exportMatch() {
    return {
      ...this.serialize(),
      endedAt: Date.now(),
      result: this.result,
    };
  }
}

// 粗略估 token：中日韩字符约 1 token/字，其余按 2 字符/token（按 len/2 估中文会低估一倍，
// 上下文预算就形同虚设）
function estimateTokens(value) {
  const text = String(value ?? "");
  const wide = (text.match(/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.ceil(wide + (text.length - wide) / 2);
}

function messagesTokens(messages) {
  return messages.reduce(
    (sum, message) =>
      sum +
      estimateTokens(message.content) +
      estimateTokens(message.reasoning_content) +
      estimateTokens(message.tool_calls ? JSON.stringify(message.tool_calls) : ""),
    0,
  );
}

// 轮内对话逼近模型上下文时，先丢推理原文，再从最旧的一组（assistant + 其 tool 结果）开始丢。
// echoReasoning 为真（该接口要求回传推理原文）时反过来：每条 assistant 都补齐这个字段（没有推理也要空串），
// 只按上下文预算丢旧组。
export function trimMessages(messages, contextTokens, echoReasoning = false, maxOutputTokens = 0) {
  let list = messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (echoReasoning) {
      return typeof message.reasoning_content === "string" ? message : { ...message, reasoning_content: "" };
    }
    return message.reasoning_content ? { ...message, reasoning_content: undefined } : message;
  });
  const reservedOut = Math.max(0, Number(maxOutputTokens) || 0);
  const budget = contextBudget(contextTokens, reservedOut);
  let guard = 0;
  while (messagesTokens(list) > budget && list.length > 2 && guard < 64) {
    guard += 1;
    const currentStart = findCurrentTurnStart(list);
    if (currentStart <= 1) break;
    const next = dropOldestTurn(list, currentStart);
    if (next.length >= list.length) break;
    list = next;
  }
  // 对外请求不得携带内部 _meta（部分 OpenAI 兼容接口会拒未知字段）
  return sanitizeToolProtocol(list).map((message) => {
    if (!message || typeof message !== "object" || !("_meta" in message)) return message;
    const { _meta, ...rest } = message;
    return rest;
  });
}

function previewMove(call, legalMap) {
  if (call.name && call.name !== "commit_move") return null;
  const args = parseArgs(call.arguments);
  let raw = args?.move;
  // 流式半截 JSON 解析失败时，仍只从 move 字段取值（整串），绝不扫整段 arguments 做子串匹配
  if (raw == null && typeof call.arguments === "string") {
    const match = call.arguments.match(/"move"\s*:\s*"([^"]*)"/);
    if (match) raw = match[1];
  }
  const move = parseLegalIcCS(raw, legalMap);
  if (!move) return null;
  return { from: move.from, to: move.to, iccs: move.iccs };
}

function clipTrace(items) {
  return (items || []).slice(-8).map((item) => ({
    kind: item.kind,
    title: item.title,
    body: clip(item.body, 240),
    result: clip(item.result, 180),
    ok: item.ok,
  }));
}

export function resultText(result) {
  if (!result) return "进行中";
  if (result.winner === "draw") return `和棋 · ${result.reason}`;
  if (result.winner === "r") return `红胜 · ${result.reason}`;
  if (result.winner === "b") return `黑胜 · ${result.reason}`;
  return result.detail ? `${result.reason} · ${result.detail}` : result.reason || "结束";
}
