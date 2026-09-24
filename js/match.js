import {
  applyMove,
  asciiBoard,
  inCheck,
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
import { clip } from "./storage.js";

const MAX_STEPS = 8;
const MAX_FAILURES = 3;
const DRAW_PLIES = 120;
// 输出被上限截断时不带半截文本重发，只抬高输出上限；连续截断超过这个次数就交给裁判代走
const MAX_TRUNCATIONS = 2;
const TRUNCATION_TOKEN_CAP = 64000;

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

function systemPrompt(side) {
  const name = sideName(side);
  return [
    `你是中国象棋智能体，本局执${name}。裁判在本地，你不能用文字宣称已经走子。`,
    "每步消息都会附上全部合法着法：比较后直接调用 commit_move 提交其中一步，move 必须逐字来自该列表。",
    "需要复核盘面时才调用 look_board 或 legal_moves，不要重复查询。",
    "分析不超过 150 字：从合法着法中选定一步，立即 commit_move，不要长篇推演。",
    "调用 commit_move 提交 ICCS 坐标，或调用 resign 认输。非法着法会被工具拒绝，然后你再选；连续多次违规或未落子时，裁判会从合法着法中随机代走一步（不会因此判负）。",
    "胜负由裁判裁定：将死、困毙、认输、超时。长将方负。同一局面三次重复且不是单方长将，则和棋。连续 120 步无吃子，和棋。",
  ].join("\n");
}

function turnPrompt(pos, records) {
  const round = Math.floor(records.length / 2) + 1;
  const recent = records
    .slice(-8)
    .map((item) => item.notation)
    .join(" ");
  return [
    `第 ${round} 回合，轮到${sideName(pos.side)}。`,
    recent ? `最近着法：${recent}` : "这是开局第一步。",
    `距上次吃子 ${pos.halfmove} 步。`,
    "请调用工具完成本步。不要只输出文字。",
  ].join("\n");
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
  constructor({ settings, hooks, saved }) {
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
  }

  providerOf(side) {
    const id = this.players[side]?.providerId;
    return this.providers.find((provider) => provider.id === id) || this.providers[0] || { baseUrl: "", apiKey: "" };
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
    this.hooks.onPersist(this.serialize());
  }

  serialize() {
    return {
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
    const baseCap = player.maxOutputTokens || 8000;
    let cap = Math.max(baseCap, this.capFloor[side] || 0);
    let hardCap = false; // 厂商拒过抬高后的上限：本回合不再抬
    this.traces[side] = [];
    this.preview = null;
    this.phase[side] = "请求中";
    this.phase[opposite(side)] = "等待";
    if (!this.turnStarted) this.turnStarted = Date.now();
    this.emit();

    const legalLines = legal.map((move) => `${move.iccs} ${toNotation(this.pos, move)}`).join("\n");
    const messages = [
      { role: "system", content: systemPrompt(side) },
      {
        role: "user",
        content: `${turnPrompt(this.pos, this.records)}\n\n全部合法着法（ICCS + 中文记谱），从中选择一步提交：\n${legalLines}`,
      },
    ];
    let failures = 0;
    let truncations = 0;

    // 输出被上限截断不是模型违规，也不是策略问题：半截文本/半截参数一律不回灌历史
    // （只会让下一次请求更长更慢、更像在自我重复），直接把输出上限翻倍重发一次。
    // 返回 null 表示已重发，返回对象表示该用裁判代走收场。
    const truncationRetry = (step, trace) => {
      truncations += 1;
      const givingUp = truncations > MAX_TRUNCATIONS;
      if (!hardCap) {
        cap = Math.min(cap * 2, TRUNCATION_TOKEN_CAP);
        this.capFloor[side] = cap;
      }
      traceAdd(trace, {
        id: `nudge-${step}`,
        ply: turnPly,
        kind: "tool",
        title: "裁判",
        body: "",
        result: givingUp
          ? `分析过长被截断未落子（第 ${truncations} 次）。连续被截断，裁判代走。`
          : hardCap
            ? `分析过长被截断未落子（第 ${truncations} 次）。该模型输出上限 ${Math.round(cap / 1000)}k 是硬顶，只能催它直接落子。`
            : `分析过长被截断未落子（第 ${truncations} 次）。已放宽输出上限到 ${Math.round(cap / 1000)}k 并催促直接落子。`,
        pending: false,
        ok: false,
      });
      if (givingUp) {
        this.phase[side] = "输出连续被截断";
        this.emit();
        return { kind: "random", reason: "输出连续被截断，裁判代走" };
      }
      this.phase[side] = hardCap
        ? `重试 · 输出被截断（上限 ${Math.round(cap / 1000)}k 硬顶）`
        : `重试 · 输出超长被截断（上限 ${Math.round(cap / 1000)}k）`;
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
        acc = await streamChat({
          baseUrl: this.providerOf(side).baseUrl,
          apiKey: this.providerOf(side).apiKey,
          model: player.model,
          messages: trimMessages(messages, player.contextTokens, this.echoReasoning),
          tools: TOOLS,
          temperature: this.temperature,
          maxTokens: cap,
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
        if (failures >= MAX_FAILURES) return { kind: "random", reason: executed.reason || "多次违规，裁判代走" };
      }
      if (finished) return finished;
      if (step >= 2) {
        messages.push({ role: "user", content: "信息已经足够。请立刻调用 commit_move 或 resign，不要再重复查询。" });
      }
    }
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
function trimMessages(messages, contextTokens, echoReasoning = false) {
  let list = messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (echoReasoning) {
      return typeof message.reasoning_content === "string" ? message : { ...message, reasoning_content: "" };
    }
    return message.reasoning_content ? { ...message, reasoning_content: undefined } : message;
  });
  const budget = Math.max(4096, Math.floor((Number(contextTokens) || 128000) * 0.7));
  while (list.length > 2 && messagesTokens(list) > budget) {
    let end = 3;
    while (end < list.length && list[end].role === "tool") end += 1;
    list = [list[0], list[1], ...list.slice(end)];
  }
  return list;
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
