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

function systemPrompt(side) {
  const name = sideName(side);
  return [
    `你是中国象棋智能体，本局执${name}。裁判在本地，你不能用文字宣称已经走子。`,
    "每步消息都会附上全部合法着法：比较后直接调用 commit_move 提交其中一步，move 必须逐字来自该列表。",
    "需要复核盘面时才调用 look_board 或 legal_moves，不要重复查询。",
    "分析务必精炼：列出 2-4 个候选并直接选定，不要长篇推演，尽快落子。",
    "调用 commit_move 提交 ICCS 坐标，或调用 resign 认输。非法着法会被工具拒绝，然后你再选。",
    "胜负由裁判裁定：将死、困毙、认输、违规、超时。长将方负。同一局面三次重复且不是单方长将，则和棋。连续 120 步无吃子，和棋。",
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
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  const base = source.providerId ? source : fallback;
  return {
    name: source.name || fallback.name,
    providerId: source.providerId || fallback.providerId,
    model: source.model || fallback.model,
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
      moves: this.records,
      preview: this.preview,
      lastMove: this.lastMove,
      players: this.players,
      checkSide: inCheck(this.pos, this.pos.side) ? this.pos.side : null,
    };
  }

  emit() {
    this.hooks.onUpdate(this.snapshot());
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
        trace: (item.trace || []).slice(-8),
      })),
      clocks: this.clocks,
      traces: {
        r: clipTrace(this.traces.r),
        b: clipTrace(this.traces.b),
      },
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
          const repeated = repetition(this.records, this.positions);
          if (repeated) {
            this.finish(repeated);
            return;
          }
          if (this.pos.halfmove >= DRAW_PLIES) {
            this.finish({ winner: "draw", reason: "120步无吃子" });
            return;
          }
          const after = terminalStatus(this.pos);
          if (after) {
            this.finish(after);
            return;
          }
        } else if (outcome.kind === "resign") {
          this.finish({ winner: opposite(this.pos.side), reason: "认输", detail: outcome.thought });
          return;
        } else if (outcome.kind === "forfeit") {
          this.finish({ winner: opposite(this.pos.side), reason: "违规", detail: outcome.reason });
          return;
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

    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (this.remaining(side) <= 0) {
        this.stopReason = { winner: opposite(side), reason: "超时" };
        return null;
      }
      this.controller = new AbortController();
      const trace = this.traces[side];
      const think = { id: `think-${step}`, kind: "think", title: "思维链", body: "" };
      const say = { id: `say-${step}`, kind: "say", title: "输出", body: "" };
      let acc;
      try {
        this.phase[side] = failures ? `重试 ${failures}/${MAX_FAILURES}` : "思考中";
        this.emit();
        acc = await streamChat({
          baseUrl: this.providerOf(side).baseUrl,
          apiKey: this.providerOf(side).apiKey,
          model: player.model,
          messages: trimMessages(messages, player.contextTokens),
          tools: TOOLS,
          temperature: this.temperature,
          maxTokens: player.maxOutputTokens,
          signal: this.controller.signal,
          onDelta: (delta) => {
            if (delta.reasoning) {
              think.body = delta.reasoning;
              if (!trace.includes(think)) trace.push(think);
            }
            if (delta.content) {
              say.body = delta.content;
              if (!trace.includes(say)) trace.push(say);
            }
            delta.toolCalls.forEach((call, index) => {
              const id = `tool-${step}-${call.index ?? index}`;
              let item = trace.find((entry) => entry.id === id);
              if (!item) {
                item = { id, kind: "tool", title: "工具", body: "", result: "", pending: true, ok: true };
                trace.push(item);
              }
              item.title = call.name || "工具";
              item.body = call.arguments;
              const preview = previewMove(call, legalMap);
              if (preview) this.preview = preview;
            });
            this.phase[side] = delta.toolCalls.some((call) => call.name) ? "调用工具" : "思考中";
            this.emit();
          },
        });
      } finally {
        this.controller = null;
      }

      const calls = normalizeCalls(acc).map((call, index) => ({
        ...call,
        id: call.id || `call_${step}_${index}`,
      }));
      if (!calls.length) {
        failures += 1;
        messages.push({ role: "assistant", content: acc.content || "（没有调用工具）" });
        const truncated = acc.finishReason === "length";
        this.phase[side] = `重试 ${failures}/${MAX_FAILURES} · ${truncated ? "输出超长被截断" : "未调用工具"}`;
        trace.push({
          id: `nudge-${step}`,
          kind: "tool",
          title: "裁判",
          body: "",
          result: truncated
            ? "你的分析过长，输出被截断，未能落子。不要再写长分析，直接调用 commit_move 提交一步。"
            : "没有工具调用。请调用 legal_moves，再调用 commit_move。",
          pending: false,
          ok: false,
        });
        this.emit();
        if (failures >= MAX_FAILURES) return { kind: "forfeit", reason: truncated ? "多次输出超长未落子" : "连续未调用工具" };
        messages.push({
          role: "user",
          content: truncated
            ? "你上一轮的分析过长，输出在中途被截断，没有产生任何着法。不要再长篇推演，直接调用 commit_move 提交一步合法着法。"
            : "你没有调用工具。请先调用 legal_moves，再调用 commit_move 或 resign。不要只用文字给出着法。",
        });
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
      if (acc.reasoning) assistant.reasoning_content = acc.reasoning;
      messages.push(assistant);

      let finished = null;
      for (const call of calls) {
        const executed = this.executeTool(call, legalMap);
        const id = `tool-${step}-${call.index ?? 0}`;
        let item = trace.find((entry) => entry.id === id);
        if (!item) {
          item = { id, kind: "tool", title: call.name, body: call.arguments, pending: false, ok: true, result: "" };
          trace.push(item);
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
        if (failures >= MAX_FAILURES) return { kind: "forfeit", reason: executed.reason || "多次非法着法" };
      }
      if (finished) return finished;
      if (step >= 3) {
        messages.push({ role: "user", content: "信息已经足够。请立刻调用 commit_move 或 resign，不要再重复查询。" });
      }
    }
    return { kind: "forfeit", reason: "工具调用次数用尽仍未落子" };
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
      const raw = String(args.move || "");
      const found = raw.toLowerCase().match(/[a-i][0-9][a-i][0-9]/);
      const iccs = found ? found[0] : "";
      const chosen = legalMap.get(iccs);
      if (!chosen) {
        return {
          ok: false,
          failure: true,
          reason: "着法非法",
          text: `非法着法 ${raw || "（空）"}。请重新调用 legal_moves，再从列表中提交一步。`,
        };
      }
      const thought = String(args.thought || "").slice(0, 200);
      return {
        ok: true,
        done: true,
        text: `已接受 ${iccs} ${toNotation(this.pos, chosen)}`,
        outcome: { kind: "move", move: chosen, thought, iccs },
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

function estimateTokens(value) {
  return Math.ceil(String(value ?? "").length / 2);
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
function trimMessages(messages, contextTokens) {
  let list = messages.map((message) =>
    message.role === "assistant" && message.reasoning_content ? { ...message, reasoning_content: undefined } : message,
  );
  const budget = Math.max(4096, Math.floor((Number(contextTokens) || 128000) * 0.7));
  while (list.length > 2 && messagesTokens(list) > budget) {
    let end = 3;
    while (end < list.length && list[end].role === "tool") end += 1;
    list = [list[0], list[1], ...list.slice(end)];
  }
  return list;
}

function previewMove(call, legalMap) {  if (call.name && call.name !== "commit_move") return null;
  const found = String(call.arguments || "").toLowerCase().match(/[a-i][0-9][a-i][0-9]/);
  if (!found || !legalMap.has(found[0])) return null;
  const move = legalMap.get(found[0]);
  return { from: move.from, to: move.to, iccs: found[0] };
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
