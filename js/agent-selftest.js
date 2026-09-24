// Agent 循环的行为测试：用假 fetch 喂固定 SSE，检查"被截断"这一类情况的处理。
// 跑法：node js/agent-selftest.js
import assert from "node:assert/strict";
import { fromFEN, legalMoves, positionKey, startingPosition } from "./engine.js";
import {
  Match,
  resolveAfterMove,
  systemPrompt,
  buildTurnUserMessage,
  piecesSummary,
  trimMessages,
  rebuildMemoryFromRecords,
  contextBudget,
  CONTEXT_COMPRESS_RATIO,
  compactMessages,
  KEEP_RECENT_TURNS,
  packMemory,
  truncationNudgeText,
  truncationRetryPhase,
  digestForCompaction,
  DIGEST_REASONING_CLIP,
} from "./match.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "./storage.js";
import { saveGameMemory, loadGameMemory, resetMemoryStoreForTests } from "./memory-store.js";

const encoder = new TextEncoder();

function sse(lines) {
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function reasoning(text, finish = "stop") {
  return sse([
    { choices: [{ delta: { reasoning_content: text } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ]);
}

function toolCall(name, args, finish = "tool_calls") {
  const call = { index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } };
  return sse([
    { choices: [{ delta: { tool_calls: [call] } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ]);
}

// 工具调用被输出上限掐在半截 JSON 上
function brokenToolCall(name, partialArgs) {
  const call = { index: 0, id: "call_1", function: { name, arguments: partialArgs } };
  return sse([
    { choices: [{ delta: { tool_calls: [call] } }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
  ]);
}

function httpError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

function jsonChat(message, finish_reason = "stop") {
  return new Response(
    JSON.stringify({ choices: [{ message, finish_reason }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let script = [];
let requests = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  const next = script.shift();
  assert.ok(next, "测试脚本用完了响应，但 Agent 又发了一次请求");
  return typeof next === "function" ? next(body) : next;
};

function makeMatch(maxOutputTokens = 8000, baseUrl = "https://stub.test/v1", thinking = "off") {
  const player = (name) => ({ name, providerId: "p", model: "stub-model", thinking, contextTokens: 128000, maxOutputTokens });
  return new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl, apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: player("红"),
      black: player("黑"),
    },
    hooks: { onUpdate() {}, onClock() {}, onPersist() {}, onFinish() {} },
  });
}

async function play(scripted, maxOutputTokens, baseUrl, thinking) {
  script = scripted;
  requests = [];
  const match = makeMatch(maxOutputTokens, baseUrl, thinking);
  const outcome = await match.playTurn();
  return { match, outcome };
}

const caps = () => requests.map((body) => body.max_tokens);
const roles = (index) => requests[index].messages.map((message) => message.role);

// 1) 正常一手：一次请求、一次工具调用
{
  const { match, outcome } = await play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })]);
  assert.equal(outcome.kind, "move", "应当直接落子");
  assert.equal(outcome.iccs, "h2e2");
  assert.equal(outcome.thought, "炮二平五");
  assert.equal(requests.length, 1, "正常一手只该发一次请求");
  assert.equal(caps()[0], 8000, "首次请求用配置的输出上限");
  assert.equal(match.traces.r[0].ply, 0, "日志条目必须带回合号");
}

// 2) 首轮被截断：不带半截分析重发；固定配置 k，不得翻倍、不得说已放宽
{
  const { match, outcome } = await play([
    reasoning("我在想……先比较一下马八进七和炮二平五，然后……", "length"),
    toolCall("commit_move", { move: "b0c2", thought: "马八进七" }),
  ]);
  assert.equal(outcome.kind, "move", "截断重试后应当能落子");
  assert.equal(outcome.iccs, "b0c2");
  assert.deepEqual(caps(), [8000, 8000], "截断重试必须保持同一配置 k，不得翻倍");
  assert.equal(requests[1].messages.some((message) => message.role === "assistant"), false, "半截分析不许回灌历史");
  assert.match(requests[1].messages.at(-1).content, /截断/, "重发时要明确告知上一轮被截断");
  assert.match(requests[1].messages.at(-1).content, /commit_move/, "截断重发须催促直接落子");
  const nudge = match.traces.r.map((item) => item.result || "").join(" ");
  assert.match(nudge, /输出上限已是配置的 8k，只能催促直接落子/, "固定 k 时须报配置上限");
  assert.equal(/已放宽/.test(nudge), false, "固定 k 不得出现「已放宽」");
}

// 3) 连续被截断：有界重试后交裁判代走，不会把 8 步全烧在重试上
{
  const { outcome } = await play([
    reasoning("长分析一", "length"),
    reasoning("长分析二", "length"),
    reasoning("长分析三", "length"),
    reasoning("长分析四", "length"),
  ]);
  assert.deepEqual(outcome, { kind: "random", reason: "输出连续被截断，裁判代走" });
  assert.deepEqual(caps(), [8000, 8000, 8000], "最多重试两次且不得超过配置上限");
}

// 4) 工具参数被截断（半截 JSON）同样按截断处理，不算违规
{
  const { outcome } = await play([
    brokenToolCall("commit_move", '{"move":"h2'),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ]);
  assert.equal(outcome.kind, "move");
  assert.deepEqual(caps(), [8000, 8000]);
  assert.equal(requests[1].messages.some((message) => message.role === "assistant"), false, "半截工具调用不许回灌历史");
}

// 5) 非法着法仍然算违规并重试（别被上面几条改坏）：a0a5 被 a3 的兵挡住
{
  const { outcome } = await play([
    toolCall("commit_move", { move: "a0a5", thought: "乱走" }),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ]);
  assert.equal(outcome.kind, "move");
  assert.equal(outcome.iccs, "h2e2");
  assert.equal(requests.length, 2, "非法着法后应当再问一次");
  assert.deepEqual(roles(1).slice(0, 2), ["system", "user"]);
  assert.ok(roles(1).includes("tool"), "正常的工具往返要保留在历史里");
  assert.match(requests[1].messages.find((message) => message.role === "tool").content, /非法着法/);
}

// 6) 纯截断不写 capFloor（无抬限阶梯）；下一手仍用配置 k
{
  const match = makeMatch();
  script = [reasoning("想很久", "length"), toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })];
  requests = [];
  const first = await match.playTurn();
  assert.equal(first.kind, "move");
  assert.deepEqual(caps(), [8000, 8000]);
  assert.equal(match.capFloor.r, 0, "截断重试不得写入抬限 capFloor");
  requests = [];
  script = [toolCall("commit_move", { move: "b0c2", thought: "马八进七" })];
  const second = await match.playTurn();
  assert.equal(second.kind, "move");
  assert.deepEqual(caps(), [8000], "下一回合仍用配置输出上限");
}

// 7) 厂商把过高的输出上限 400 拒掉时不许把整局打挂：压档后继续下
{
  script = [
    httpError(400, "max_tokens is too large: 32768"),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ];
  requests = [];
  const match = makeMatch(32768);
  const outcome = await match.playTurn();
  assert.equal(outcome.kind, "move", "被 400 拒绝后仍要把这一步走完");
  assert.equal(caps()[0], 32768);
  assert.ok(caps()[1] < 32768, "应压到更低档位重发");
  assert.match(match.traces.r.map((item) => item.result || "").join(" "), /压到/);
}

// 8) DeepSeek 官方带 tools 时要求回传推理原文：先 400 一次，认出后整局都带上
{
  const strict = (body) => {
    const assistants = body.messages.filter((message) => message.role === "assistant");
    if (assistants.some((message) => typeof message.reasoning_content !== "string")) {
      return httpError(400, "reasoning_content is required when tools are provided");
    }
    if (assistants.length === 0) return toolCall("legal_moves", {});
    return toolCall("commit_move", { move: "h2e2", thought: "炮二平五" });
  };
  const { match, outcome } = await play([strict, strict, strict]);
  assert.equal(outcome.kind, "move", "认出口径后要把这一步走完");
  assert.equal(requests.length, 3, "400 之后重发一次就该成功");
  assert.equal(requests[1].messages.some((message) => message.role === "assistant" && !("reasoning_content" in message)), true, "默认不回传推理原文");
  const echoed = requests[2].messages.filter((message) => message.role === "assistant");
  assert.ok(echoed.length > 0);
  assert.equal(echoed.every((message) => typeof message.reasoning_content === "string"), true, "被拒之后所有 assistant 消息都带推理原文");
  assert.equal(match.echoReasoning, true);
}

// 9) 用户把输出上限配得比模型硬顶还大：往下压到厂商肯收的档位，不许把整局抛成"中断"
{
  const strict = (body) =>
    body.max_tokens > 8192
      ? httpError(400, "max_tokens is too large, maximum is 8192")
      : toolCall("commit_move", { move: "h2e2", thought: "炮二平五" });
  // 输出上限不得超上下文窗：200k 配置在 128k 窗口下会被收成 128k
  const { match, outcome } = await play([strict, strict], 200000);
  assert.equal(outcome.kind, "move", "压到硬顶之后要把这一步走完");
  assert.equal(caps()[0] <= 128000, true, "先受上下文窗约束（还要给 prompt 留位）");
  assert.ok(caps()[0] > 100000, "大窗口下输出上限应接近窗宽");
  assert.equal(caps()[1], 8192, "再一次压到常见硬顶");
  assert.match(match.traces.r.map((item) => item.result || "").join(" "), /压到 8k/);
}

// 10) 思考强度：按厂商方言发送，默认不思考；厂商不认就整局退回不带该参数
{
  const play3 = () => play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000);
  const openrouter = (thinking) => play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000, "https://openrouter.ai/api/v1", thinking);

  const { outcome } = await play3();
  assert.equal(outcome.kind, "move");
  assert.equal("reasoning" in requests[0], false, "认不出的厂商一个多余字段都不发");

  const { outcome: off } = await openrouter("off");
  assert.equal(off.kind, "move");
  assert.deepEqual(requests[0].reasoning, { enabled: false }, "默认不思考要明确关掉推理");

  const { outcome: high } = await openrouter("high");
  assert.equal(high.kind, "move");
  assert.deepEqual(requests[0].reasoning, { effort: "high" }, "思考强度要按档位发");

  const { outcome: zhipu } = await play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000, "https://open.bigmodel.cn/api/paas/v4", "off");
  assert.equal(zhipu.kind, "move");
  assert.deepEqual(requests[0].thinking, { type: "disabled" }, "智谱用 thinking 字段");

  const { outcome: mimoOff } = await play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000, "https://api.xiaomimimo.com/v1", "off");
  assert.equal(mimoOff.kind, "move");
  assert.deepEqual(requests[0].thinking, { type: "disabled" }, "小米 MiMo 关思考必须显式 disabled（默认会开思考烧光输出）");

  const { outcome: mimoOn } = await play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000, "https://api.xiaomimimo.com/v1", "high");
  assert.equal(mimoOn.kind, "move");
  assert.deepEqual(requests[0].thinking, { type: "enabled" }, "小米 MiMo 开思考发 enabled");

  const { outcome: plain } = await play([toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })], 8000, "https://api.deepseek.com", "high");
  assert.equal(plain.kind, "move");
  assert.equal("reasoning" in requests[0] || "thinking" in requests[0] || "enable_thinking" in requests[0], false);
}

// 11) 厂商 400 拒绝思考强度字段：整局退回不带该参数，仍然把这步走完
{
  const strict = (body) =>
    "reasoning" in body
      ? httpError(400, 'Invalid parameter: "reasoning" is not supported by this model')
      : toolCall("commit_move", { move: "h2e2", thought: "炮二平五" });
  const { match, outcome } = await play([strict, strict], 8000, "https://openrouter.ai/api/v1", "off");
  assert.equal(outcome.kind, "move", "被拒之后要把这一步走完");
  assert.equal("reasoning" in requests[0], true);
  assert.equal("reasoning" in requests[1], false, "退回时不带思考强度参数");
  assert.equal(match.dropThinking, true);
}

console.log("agent loop ok");


// ---------- 回归：终局裁定次序 / 代走可见 / 工具解析 ----------

// 12) 将死优先于 120 步无吃子；困毙同理
{
  const mateAt120 = fromFEN("R3k4/9/4P4/2N3N2/9/9/9/9/9/4K4 b - - 120 1");
  assert.deepEqual(
    resolveAfterMove(mateAt120, [], [positionKey(mateAt120)]),
    { winner: "r", reason: "将死" },
    "halfmove=120 的将死不能记成无吃子和棋",
  );
  const stalemateAt120 = fromFEN("3k5/9/9/9/9/9/9/9/3p1p3/4K4 w - - 120 1");
  assert.deepEqual(
    resolveAfterMove(stalemateAt120, [], [positionKey(stalemateAt120)]),
    { winner: "b", reason: "困毙" },
    "halfmove=120 的困毙不能记成无吃子和棋",
  );
  const quietAt120 = fromFEN("4k4/9/9/9/9/9/9/9/9/4K4 w - - 120 1");
  assert.deepEqual(
    resolveAfterMove(quietAt120, [], [positionKey(quietAt120)]),
    { winner: "draw", reason: "120步无吃子" },
    "非终局且 120 步无吃子才判和",
  );
}

// 13) 子串 ICCS 必须拒绝：'先别 a0a1，我想 h2e2' 不得吃到 a0a1
{
  const match = makeMatch();
  const legalMap = new Map(legalMoves(match.pos).map((move) => [move.iccs, move]));
  const bad = match.executeTool(
    { name: "commit_move", arguments: JSON.stringify({ move: "先别 a0a1，我想 h2e2", thought: "试探" }) },
    legalMap,
  );
  assert.equal(bad.ok, false, "含子串的 move 必须拒绝");
  assert.equal(bad.failure, true);
  const good = match.executeTool(
    { name: "commit_move", arguments: JSON.stringify({ move: "h2e2", thought: "炮二平五" }) },
    legalMap,
  );
  assert.equal(good.ok, true);
  assert.equal(good.outcome.iccs, "h2e2");
  const spaced = match.executeTool(
    { name: "commit_move", arguments: JSON.stringify({ move: "  H2E2  ", thought: "炮二平五" }) },
    legalMap,
  );
  assert.equal(spaced.ok, true, "整串去空白+大小写不敏感仍应接受");
  assert.equal(spaced.outcome.iccs, "h2e2");
}

// 14) 对象形态的 function.arguments：parseArgs / 非流式 ingest 都能吃
{
  const match = makeMatch();
  const legalMap = new Map(legalMoves(match.pos).map((move) => [move.iccs, move]));
  const executed = match.executeTool(
    { name: "commit_move", arguments: { move: "h2e2", thought: "炮二平五" } },
    legalMap,
  );
  assert.equal(executed.ok, true, "arguments 直接是对象时也要能解析");
  assert.equal(executed.outcome.iccs, "h2e2");

  const { outcome } = await play([
    jsonChat({
      tool_calls: [
        {
          id: "call_obj",
          type: "function",
          function: { name: "commit_move", arguments: { move: "b0c2", thought: "马八进七" } },
        },
      ],
    }, "tool_calls"),
  ]);
  assert.equal(outcome.kind, "move");
  assert.equal(outcome.iccs, "b0c2", "JSON 非流式路径要把对象 arguments 规范化");
}

// 15) 缺 index 的 tool_calls delta：接到同一槽，不能拆成两次调用
{
  const split = sse([
    { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "commit_move", arguments: '{"move":"h2e2"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: ',"thought":"炮二平五"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const { outcome } = await play([split]);
  assert.equal(outcome.kind, "move", "缺 index 的后续 delta 应拼回同一调用");
  assert.equal(outcome.iccs, "h2e2");
  assert.equal(outcome.thought, "炮二平五");
}

// 16) JSON 非流式响应也要带上 finish_reason，截断才能触发抬限重试
{
  const { outcome } = await play([
    jsonChat({ content: "分析被掐断……" }, "length"),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ]);
  assert.equal(outcome.kind, "move");
  assert.deepEqual(caps(), [8000, 8000], "JSON 路径的 length 也要重发且不超过配置上限");
}

// 17) 裁判代走要打上 substitute 标记；旧存档无该字段仍可恢复
{
  const { match, outcome } = await play([
    reasoning("只说不做"),
    reasoning("还是不调用工具"),
    reasoning("第三次了"),
  ]);
  assert.equal(outcome.kind, "random");
  const legal = legalMoves(match.pos);
  const move = legal[0];
  match.applyCommitted({
    move,
    iccs: move.iccs,
    thought: `裁判代走（${outcome.reason}）`,
    substitute: true,
  });
  assert.equal(match.records[0].substitute, true, "代走记录必须带 substitute");
  const saved = match.serialize().moves[0];
  assert.equal(saved.substitute, true, "序列化要保留 substitute");

  const legacy = {
    id: "old",
    players: match.players,
    moves: [{ side: "r", iccs: "h2e2", notation: "炮二平五", thought: "老存档", timeMs: 10 }],
    clocks: { r: 60000, b: 60000 },
    mainMinutes: 60,
  };
  const again = new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl: "https://stub.test/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: match.players.r,
      black: match.players.b,
    },
    hooks: match.hooks,
    saved: legacy,
  });
  assert.equal(again.records[0].substitute, undefined, "旧存档无 substitute 字段时不得臆造");
  assert.equal(again.records[0].iccs, "h2e2");
}

// 18) 带 index 的并行 tool_calls 不得被缺 index 逻辑打乱
{
  const parallel = sse([
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "c0", function: { name: "legal_moves", arguments: "{}" } },
      { index: 1, id: "c1", function: { name: "commit_move", arguments: '{"move":"h2e2","thought":"炮二平五"}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const { outcome } = await play([parallel]);
  assert.equal(outcome.kind, "move");
  assert.equal(outcome.iccs, "h2e2", "并行调用应按 index 分槽，最终仍能 commit");
}

// 19) 缺 index 但带新 id：应开新槽，不能并进上一调用
{
  const byId = sse([
    { choices: [{ delta: { tool_calls: [{ id: "c0", function: { name: "legal_moves", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "commit_move", arguments: '{"move":"b0c2","thought":"马八进七"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const { outcome } = await play([byId]);
  assert.equal(outcome.kind, "move");
  assert.equal(outcome.iccs, "b0c2", "新 id 缺 index 时应开新槽");
}


// ---------- 盘面上下文与跨回合记忆（harness 风格：原文保留 + 阈值摘要） ----------

// 20) 回合用户消息含盘面 / 子力 / FEN / 合法着法；系统提示去掉 150 字限制
{
  const pos = startingPosition();
  const legal = legalMoves(pos);
  const body = buildTurnUserMessage(pos, [], legal);
  assert.match(body, /FEN：/);
  assert.match(body, /双方子力/);
  assert.match(body, /帅e0|帅/);
  assert.match(body, /棋盘（文件 a-i/);
  assert.match(body, /全部合法着法/);
  assert.match(body, /h2e2/);
  assert.match(piecesSummary(pos), /红方：/);
  const sys = systemPrompt("r");
  assert.equal(/150\s*字/.test(sys), false, "系统提示不得再限制 150 字");
  assert.match(sys, /将杀|将军/);
}

// 21) 同方两回合：第二次请求带上第一回合原文；旧盘面不再折叠
{
  const match = makeMatch();
  script = [toolCall("commit_move", { move: "h2e2", thought: "先开中炮试探" })];
  requests = [];
  const first = await match.playTurn();
  assert.equal(first.kind, "move");
  match.applyCommitted(first);
  assert.match(requests[0].messages.find((m) => m.role === "user").content, /棋盘（文件/);
  script = [toolCall("commit_move", { move: "h7e7", thought: "对中炮" })];
  requests = [];
  const black = await match.playTurn();
  assert.equal(black.kind, "move");
  match.applyCommitted(black);
  script = [toolCall("commit_move", { move: "b0c2", thought: "马八进七接续" })];
  requests = [];
  const second = await match.playTurn();
  assert.equal(second.kind, "move");
  const msgs = requests[0].messages;
  assert.equal(msgs[0].role, "system");
  const users = msgs.filter((m) => m.role === "user" && m.content.includes("全部合法着法"));
  assert.ok(users.length >= 2, "应至少有两个完整盘面用户消息");
  assert.equal(
    msgs.some((m) => m.role === "user" && /盘面与合法着法已省略|盘面已省略/.test(m.content || "")),
    false,
    "不得再折叠旧盘面",
  );
  const hasPriorTool = msgs.some(
    (m) => m.role === "assistant" && JSON.stringify(m.tool_calls || []).includes("h2e2"),
  );
  assert.equal(hasPriorTool, true, "第二回合应带上此前着法");
  assert.equal(msgs.every((m) => !("_meta" in m)), true, "出站不得带 _meta");
}

// 22) packMemory 原样保留 reasoning_content 与长盘面
{
  const longBoard = "棋盘".repeat(500);
  const packed = packMemory([
    {
      role: "assistant",
      content: longBoard,
      reasoning_content: "R".repeat(2500),
      tool_calls: [{ id: "c1", type: "function", function: { name: "commit_move", arguments: "{}" } }],
    },
  ]);
  assert.equal(packed[0].content.length, longBoard.length);
  assert.equal(packed[0].reasoning_content.length, 2500);
}

// 23) trimMessages：扣减 maxOutputTokens；不丢 system/当前回合；不留孤儿 tool；剥 _meta
{
  const sys = { role: "system", content: "system" };
  const oldUser = {
    role: "user",
    content: "old " + "盘面".repeat(2000),
    _meta: { kind: "turn", turnPly: 0, full: true },
  };
  const oldAsst = {
    role: "assistant",
    content: "分析",
    tool_calls: [{ id: "c_old", type: "function", function: { name: "commit_move", arguments: "{}" } }],
  };
  const oldTool = { role: "tool", tool_call_id: "c_old", name: "commit_move", content: "ok" };
  const curUser = {
    role: "user",
    content: "current-turn-marker " + "现".repeat(50),
    _meta: { kind: "turn", turnPly: 2, full: true },
  };
  const curAsst = {
    role: "assistant",
    content: "now",
    tool_calls: [
      { id: "c_new", type: "function", function: { name: "look_board", arguments: "{}" } },
      { id: "c_miss", type: "function", function: { name: "legal_moves", arguments: "{}" } },
    ],
  };
  const curTool = { role: "tool", tool_call_id: "c_new", name: "look_board", content: "board" };
  const orphan = { role: "tool", tool_call_id: "ghost", name: "legal_moves", content: "orphan" };
  const trimmed = trimMessages(
    [sys, oldUser, oldAsst, oldTool, curUser, curAsst, curTool, orphan],
    8000,
    false,
    7000,
  );
  assert.equal(trimmed[0].role, "system");
  assert.ok(trimmed.some((m) => /current-turn-marker/.test(m.content || "")));
  assert.equal(trimmed.some((m) => m.role === "tool" && m.tool_call_id === "ghost"), false);
  assert.equal(trimmed.some((m) => m.role === "user" && m.content.startsWith("old ")), false);
  assert.ok(trimmed.some((m) => m.role === "tool" && m.tool_call_id === "c_new"));
  const asst = trimmed.find((m) => m.role === "assistant" && (m.content || "") === "now");
  assert.deepEqual((asst?.tool_calls || []).map((c) => c.id), ["c_new"]);
  assert.equal(trimmed.every((m) => !("_meta" in m)), true);
}

// 24) 恢复：IndexedDB 记忆优先；旧 localStorage memory 次之；皆无则按 records 重建
{
  resetMemoryStoreForTests();
  const match = makeMatch();
  script = [toolCall("commit_move", { move: "h2e2", thought: "开局炮" })];
  const first = await match.playTurn();
  match.applyCommitted(first);
  const saved = match.serialize({ includeMemory: true });
  assert.ok(saved.memory?.r?.length >= 2, "显式 includeMemory 时应带上红方记忆");
  await saveGameMemory(saved.id, { r: saved.memory.r, b: saved.memory.b || [] });
  const fromIdb = await loadGameMemory(saved.id);
  assert.ok(fromIdb.r.some((m) => m.role === "assistant"));

  const restored = new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl: "https://stub.test/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: match.players.r,
      black: match.players.b,
    },
    hooks: match.hooks,
    saved: { ...saved, memory: undefined },
    memory: fromIdb,
  });
  assert.ok(restored.memory.r.some((m) => m.role === "assistant"));

  const legacy = { ...saved };
  const fromLegacy = new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl: "https://stub.test/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: match.players.r,
      black: match.players.b,
    },
    hooks: match.hooks,
    saved: legacy,
  });
  assert.equal(fromLegacy.records[0].iccs, "h2e2");
  assert.ok(fromLegacy.memory.r.length >= 2);

  const bare = { ...saved };
  delete bare.memory;
  const fromBare = new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl: "https://stub.test/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: match.players.r,
      black: match.players.b,
    },
    hooks: match.hooks,
    saved: bare,
  });
  assert.equal(fromBare.memory.r[0].role, "system");
  assert.ok(fromBare.memory.r.some((m) => m.role === "tool" && /h2e2/.test(m.content || "")));
  const rebuilt = rebuildMemoryFromRecords("r", bare.moves);
  assert.equal(rebuilt[0].role, "system");
}

// 25) 压缩阈值数学
{
  assert.equal(CONTEXT_COMPRESS_RATIO, 0.8);
  assert.equal(DEFAULT_CONTEXT_TOKENS, 131072);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32768);
  assert.equal(KEEP_RECENT_TURNS, 2);
  const def = contextBudget(DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(def, 98304);
  assert.ok(def + DEFAULT_MAX_OUTPUT_TOKENS <= DEFAULT_CONTEXT_TOKENS);
}

// 26) compactMessages：超阈值时摘要替换旧回合，保留最近回合与 tool 对
{
  function turn(ply, reps) {
    return [
      { role: "user", content: "盘".repeat(reps) + " ply" + ply, _meta: { kind: "turn", turnPly: ply } },
      {
        role: "assistant",
        content: "想" + ply,
        reasoning_content: "R".repeat(100),
        tool_calls: [{ id: "c" + ply, type: "function", function: { name: "commit_move", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c" + ply, name: "commit_move", content: "ok" + ply },
    ];
  }
  const messages = [{ role: "system", content: "sys" }, ...turn(0, 2000), ...turn(2, 2000), ...turn(4, 80), ...turn(6, 80)];
  let sawOlder = 0;
  const result = await compactMessages({
    messages,
    contextTokens: 2500,
    maxOutputTokens: 500,
    compactRequest: async (older) => {
      sawOlder = older.length;
      return "红方中炮，黑方对攻，互兑一马。";
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(result.fallback, false);
  assert.ok(sawOlder >= 3);
  assert.ok(result.messages.some((m) => /【此前对局历史摘要/.test(m.content || "")));
  assert.ok(result.messages.some((m) => m.role === "tool" && m.tool_call_id === "c6"));
  assert.equal(result.messages.some((m) => m.role === "tool" && m.tool_call_id === "c0"), false, "最旧回合应已被摘要替换");
}

// 27) compactMessages 失败时回退丢弃旧回合
{
  function turn(ply, reps) {
    return [
      { role: "user", content: "盘".repeat(reps) + " ply" + ply, _meta: { kind: "turn", turnPly: ply } },
      {
        role: "assistant",
        content: "想" + ply,
        tool_calls: [{ id: "c" + ply, type: "function", function: { name: "commit_move", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c" + ply, name: "commit_move", content: "ok" + ply },
    ];
  }
  const messages = [{ role: "system", content: "sys" }, ...turn(0, 2000), ...turn(2, 2000), ...turn(4, 80), ...turn(6, 80)];
  const result = await compactMessages({
    messages,
    contextTokens: 2500,
    maxOutputTokens: 500,
    compactRequest: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.compacted, false);
  assert.equal(result.fallback, true);
  assert.equal(result.messages[0].role, "system");
  assert.ok(result.messages.length < messages.length);
}

// 28) 出站剥 _meta；半截 tool_calls 削干净
{
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "turn", _meta: { kind: "turn", turnPly: 0, full: true } },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "a", type: "function", function: { name: "commit_move", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "look_board", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", name: "commit_move", content: "ok" },
    { role: "user", content: "next", _meta: { kind: "turn", turnPly: 2, full: true } },
  ];
  const out = trimMessages(msgs, 128000, false, 8000);
  assert.equal(out.every((m) => !("_meta" in m)), true);
  const asst = out.find((m) => m.role === "assistant");
  assert.deepEqual((asst.tool_calls || []).map((c) => c.id), ["a"]);
}

// 29) persist 默认不把 memory 写入 localStorage 快照；includeMemory 仍可用
{
  const match = makeMatch();
  match.memory.r.push({ role: "user", content: "x", _meta: { kind: "turn", turnPly: 0 } });
  const light = match.serialize();
  assert.equal("memory" in light, false, "默认序列化不含 memory");
  const full = match.serialize({ includeMemory: true });
  assert.ok(full.memory.r.length >= 2);
}

// 30) 裁判代走说明在 persist 之前写入 memory
{
  const snapshots = [];
  const memWrites = [];
  const match = makeMatch();
  match.hooks.onPersist = (data) => {
    snapshots.push(data);
    return true;
  };
  match.hooks.onPersistMemory = (_id, mem) => {
    memWrites.push(mem);
    return true;
  };
  const legal = legalMoves(match.pos);
  const move = legal[0];
  const turnPly = match.records.length;
  match.appendSubstituteNote("r", move, "测", "测试着", turnPly);
  match.applyCommitted({ move, iccs: move.iccs, thought: "裁判代走（测）", substitute: true });
  assert.ok(memWrites.length >= 1);
  const blob = JSON.stringify(memWrites[memWrites.length - 1]);
  assert.match(blob, /裁判代走/);
}


// 31) truncationNudgeText / truncationRetryPhase：文案互斥；无「已放宽」分支；roomLimited 仍测
{
  const base = { truncations: 1, givingUp: false, hardCap: false, roomLimited: false };

  const givingUp = truncationNudgeText({ ...base, truncations: 3, givingUp: true, cap: 32768, sendCap: 32768 });
  assert.equal(givingUp, "分析过长被截断未落子（第 3 次）。连续被截断，裁判代走。");

  const hard = truncationNudgeText({ ...base, hardCap: true, cap: 8192, sendCap: 8192 });
  assert.equal(hard, "分析过长被截断未落子（第 1 次）。该模型输出上限 8k 是硬顶，只能催它直接落子。");

  const ceiling = truncationNudgeText({ ...base, cap: 32000, sendCap: 32000 });
  assert.equal(ceiling, "分析过长被截断未落子（第 1 次）。输出上限已是配置的 32k，只能催促直接落子。");
  assert.equal(/已放宽/.test(ceiling), false);

  // 上下文余量把实际 max_tokens 夹到配置顶以下：必须报 sendCap，且不得说已放宽
  const room = truncationNudgeText({
    ...base,
    roomLimited: true,
    cap: 32000,
    sendCap: 4000,
  });
  assert.equal(
    room,
    "分析过长被截断未落子（第 1 次）。本请求实际输出上限 4k（配置 32k，受上下文余量限制），只能催促直接落子。",
  );
  assert.equal(/已放宽/.test(room), false);

  // givingUp / hardCap 优先于 roomLimited
  assert.equal(
    truncationNudgeText({ ...base, truncations: 3, givingUp: true, hardCap: true, roomLimited: true, cap: 8192, sendCap: 1000 }),
    "分析过长被截断未落子（第 3 次）。连续被截断，裁判代走。",
  );
  assert.equal(
    truncationNudgeText({ ...base, hardCap: true, roomLimited: true, cap: 8192, sendCap: 8192 }),
    "分析过长被截断未落子（第 1 次）。该模型输出上限 8k 是硬顶，只能催它直接落子。",
  );

  assert.equal(truncationRetryPhase({ ...base, hardCap: true, cap: 8192, sendCap: 8192 }), "重试 · 输出被截断（上限 8k 硬顶）");
  assert.equal(truncationRetryPhase({ ...base, cap: 32000, sendCap: 32000 }), "重试 · 输出被截断（已是配置上限 32k）");
  assert.equal(
    truncationRetryPhase({ ...base, roomLimited: true, cap: 32000, sendCap: 4000 }),
    "重试 · 输出被截断（实际上限 4k，上下文余量）",
  );
}


// 32) digestForCompaction：长 reasoning 必须裁剪，避免压缩请求再吃积压思维链
{
  assert.equal(DIGEST_REASONING_CLIP, 500);
  const digest = digestForCompaction([
    { role: "assistant", content: "短", reasoning_content: "R".repeat(2000) },
  ]);
  assert.ok(digest.includes("(reasoning) "));
  assert.ok(digest.includes("…"), "超长 reasoning 应带省略号");
  const reasoningPart = digest.split("(reasoning) ")[1] || "";
  assert.ok(reasoningPart.length < 2000, "不得把 2000 字 reasoning 原样塞进摘要");
  assert.ok(reasoningPart.replace("…", "").length <= DIGEST_REASONING_CLIP + 5);
}

// 33) 固定配置 k=32k：截断重试三次请求都是同一 k，不得翻倍阶梯
{
  const { match, outcome } = await play(
    [
      reasoning("烧一", "length"),
      reasoning("烧二", "length"),
      reasoning("烧三", "length"),
      reasoning("烧四", "length"),
    ],
    32768,
  );
  assert.deepEqual(outcome, { kind: "random", reason: "输出连续被截断，裁判代走" });
  assert.deepEqual(caps(), [32768, 32768, 32768], "截断重试始终用配置的固定 k");
  const nudge = match.traces.r.map((item) => item.result || "").join(" ");
  assert.equal(/已放宽/.test(nudge), false, "固定 k 日志不得出现「已放宽」");
}

// 35) 厂商压档写入 capFloor 后：截断重试仍保持该档，绝不翻倍抬向 baseCap（旧翻倍行为会 4k→8k）
{
  const match = makeMatch(32000);
  match.capFloor.r = 4000;
  script = [
    reasoning("半截", "length"),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ];
  requests = [];
  const outcome = await match.playTurn();
  assert.equal(outcome.kind, "move");
  assert.deepEqual(caps(), [4000, 4000], "截断不得翻倍：须保持厂商可用档位");
  const nudge = match.traces.r.map((item) => item.result || "").join(" ");
  assert.equal(/已放宽/.test(nudge), false);
  assert.match(nudge, /硬顶|只能催/, "低于配置顶时应走硬顶/催促文案");
}

// 36) 厂商 400 拒收后记住可用档：下一手从该档起步，不回满配置顶去再撞墙
{
  script = [
    httpError(400, "max_tokens is too large: 32768"),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ];
  requests = [];
  const match = makeMatch(32768);
  const first = await match.playTurn();
  assert.equal(first.kind, "move");
  assert.equal(caps()[0], 32768);
  assert.equal(caps()[1], 8192);
  assert.equal(match.capFloor.r, 8192, "应记住厂商肯收的档位");
  requests = [];
  script = [toolCall("commit_move", { move: "b0c2", thought: "马八进七" })];
  const second = await match.playTurn();
  assert.equal(second.kind, "move");
  assert.deepEqual(caps(), [8192], "下一回合从记住的厂商档起步");
}

// 34) 压缩路径必须显式 thinking=off，小米 MiMo 出站带 type=disabled（thinking:null 会默认开思考）
{
  const match = makeMatch(4000, "https://api.xiaomimimo.com/v1", "off");
  match.players.r.contextTokens = 3000;
  // 塞满旧回合，逼出压缩
  const fat = [];
  for (let ply = 0; ply < 6; ply += 1) {
    fat.push({ role: "user", content: "盘面".repeat(400) + ` ply${ply}`, _meta: { kind: "turn", turnPly: ply } });
    fat.push({
      role: "assistant",
      content: "想",
      reasoning_content: "R".repeat(800),
      tool_calls: [{ id: `c${ply}`, type: "function", function: { name: "commit_move", arguments: '{"move":"h2e2"}' } }],
    });
    fat.push({ role: "tool", tool_call_id: `c${ply}`, name: "commit_move", content: "ok" });
  }
  match.memory.r = [{ role: "system", content: systemPrompt("r") }, ...fat];
  script = [
    // 压缩请求：无 tools
    (body) => {
      assert.equal("tools" in body, false, "压缩请求不应带 tools");
      assert.deepEqual(body.thinking, { type: "disabled" }, "压缩必须显式 disabled，不能靠 null 省略");
      assert.ok(body.max_tokens <= 4096);
      return jsonChat({ content: "红方中炮布局，互兑一马，局势均衡。" });
    },
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ];
  requests = [];
  const outcome = await match.playTurn();
  assert.equal(outcome.kind, "move");
  assert.ok(requests.length >= 2, "应先压缩再落子");
  assert.deepEqual(requests[0].thinking, { type: "disabled" });
  assert.ok(match.traces.r.some((item) => /压缩/.test(item.result || "")), "应留下压缩裁判提示");
}

console.log("agent regressions ok");
console.log("board memory ok");
console.log("context budget ok");
console.log("compaction ok");
console.log("token-burn audit fixes ok");
