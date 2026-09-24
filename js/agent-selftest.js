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
  collapseOldMemory,
  trimMessages,
  rebuildMemoryFromRecords,
  contextBudget,
  CONTEXT_COMPRESS_RATIO,
} from "./match.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "./storage.js";

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

// 2) 首轮被截断：不带半截分析重发，输出上限翻倍
{
  const { outcome } = await play([
    reasoning("我在想……先比较一下马八进七和炮二平五，然后……", "length"),
    toolCall("commit_move", { move: "b0c2", thought: "马八进七" }),
  ]);
  assert.equal(outcome.kind, "move", "截断重试后应当能落子");
  assert.equal(outcome.iccs, "b0c2");
  assert.deepEqual(caps(), [8000, 8000], "截断重试不得超过配置的输出上限");
  assert.equal(requests[1].messages.some((message) => message.role === "assistant"), false, "半截分析不许回灌历史");
  assert.match(requests[1].messages.at(-1).content, /截断/, "重发时要明确告知上一轮被截断");
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

// 6) 抬高过的上限要记住：同一个模型下一手直接从这儿起步，不再白烧一次 8k 生成
{
  const match = makeMatch();
  script = [reasoning("想很久", "length"), toolCall("commit_move", { move: "h2e2", thought: "炮二平五" })];
  requests = [];
  const first = await match.playTurn();
  assert.equal(first.kind, "move");
  assert.deepEqual(caps(), [8000, 8000]);
  requests = [];
  script = [toolCall("commit_move", { move: "b0c2", thought: "马八进七" })];
  const second = await match.playTurn();
  assert.equal(second.kind, "move");
  assert.deepEqual(caps(), [8000], "下一回合仍受配置输出上限约束");
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


// ---------- 盘面上下文与跨回合记忆 ----------

// 20) 回合用户消息含盘面 / 子力 / FEN / 合法着法；系统提示去掉 150 字限制
{
  const pos = startingPosition();
  const legal = legalMoves(pos);
  const body = buildTurnUserMessage(pos, [], legal);
  assert.match(body, /FEN：/);
  assert.match(body, /双方子力/);
  assert.match(body, /帅e0|帅/);
  assert.match(body, /棋盘（文件 a-i/);
  assert.match(body, /a b c d e f g h i/);
  assert.match(body, /全部合法着法/);
  assert.match(body, /h2e2/);
  assert.match(piecesSummary(pos), /红方：/);
  assert.match(piecesSummary(pos), /黑方：/);
  const sys = systemPrompt("r");
  assert.equal(/150\s*字/.test(sys), false, "系统提示不得再限制 150 字");
  assert.equal(/立即 commit_move，不要长篇/.test(sys), false);
  assert.match(sys, /将杀|将军/);
}

// 21) 同方两回合：第二次请求带上第一回合的分析与着法；旧盘面被折叠
{
  const match = makeMatch();
  script = [toolCall("commit_move", { move: "h2e2", thought: "先开中炮试探" })];
  requests = [];
  const first = await match.playTurn();
  assert.equal(first.kind, "move");
  match.applyCommitted(first);
  assert.match(requests[0].messages.find((m) => m.role === "user").content, /棋盘（文件/);
  script = [toolCall("commit_move", { move: "b0c2", thought: "跳马" })];
  // 黑方走一步好让红方再走——直接伪造 records 后改 side 不方便，改为同方：不 apply 黑棋，
  // 手动把 pos 调回红方并追加一手黑棋记录不现实。这里用第二次仍是红方：先让黑方也走。
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
  const users = msgs.filter((m) => m.role === "user" && m.content.includes("回合"));
  assert.ok(users.length >= 2, "应至少有两个回合用户消息");
  const oldTurn = users.find((m) => m.content.includes("已省略") || m._meta?.full === false);
  // _meta may be stripped by JSON serialize in fetch body - check collapsed placeholder in content
  const collapsed = msgs.some((m) => m.role === "user" && /盘面与合法着法已省略|盘面已省略/.test(m.content));
  assert.equal(collapsed, true, "旧回合盘面应被折叠");
  const hasPriorThought = msgs.some((m) => m.role === "assistant" && /先开中炮试探/.test(m.content || ""));
  const hasPriorTool = msgs.some(
    (m) => m.role === "assistant" && JSON.stringify(m.tool_calls || []).includes("h2e2"),
  );
  assert.equal(hasPriorThought || hasPriorTool, true, "第二回合应带上此前着法/想法");
  const current = [...msgs].reverse().find((m) => m.role === "user" && m.content.includes("全部合法着法"));
  assert.ok(current, "当前回合应带完整合法着法");
  assert.match(current.content, /棋盘（文件/);
}

// 22) collapseOldMemory 折叠 look_board / legal_moves 工具结果
{
  const messages = [
    { role: "system", content: "s" },
    {
      role: "user",
      content: buildTurnUserMessage(startingPosition(), [], legalMoves(startingPosition())),
      _meta: { kind: "turn", turnPly: 0, full: true },
    },
    {
      role: "tool",
      name: "look_board",
      tool_call_id: "t1",
      content: "轮到：红方\n棋盘（文件 a-i）：\n" + "x".repeat(200),
    },
  ];
  collapseOldMemory(messages);
  assert.match(messages[1].content, /已省略/);
  assert.equal(messages[1]._meta.full, false);
  assert.match(messages[2].content, /已省略/);
}

// 23) trimMessages：扣减 maxOutputTokens；不丢 system/当前回合；不留孤儿 tool
{
  const sys = { role: "system", content: "system" };
  const oldUser = {
    role: "user",
    content: "old " + "盘面".repeat(2000),
    _meta: { kind: "turn", turnPly: 0, full: false },
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
    tool_calls: [{ id: "c_new", type: "function", function: { name: "look_board", arguments: "{}" } }],
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
  assert.equal(
    trimmed.some((m) => m.role === "tool" && m.tool_call_id === "ghost"),
    false,
    "孤儿 tool 必须去掉",
  );
  // 预算很紧时应丢掉旧回合
  assert.equal(
    trimmed.some((m) => m.role === "user" && m.content.startsWith("old ")),
    false,
    "超预算时应丢弃旧回合",
  );
  // 当前回合的 tool 对仍在
  assert.ok(trimmed.some((m) => m.role === "tool" && m.tool_call_id === "c_new"));
}

// 24) 恢复：有 memory 字段用原会话；无 memory 的旧存档用 records 重建且可 load
{
  const match = makeMatch();
  script = [toolCall("commit_move", { move: "h2e2", thought: "开局炮" })];
  const first = await match.playTurn();
  match.applyCommitted(first);
  const saved = match.serialize();
  assert.ok(saved.memory?.r?.length >= 2, "序列化应带上红方记忆");
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
    saved,
  });
  assert.ok(restored.memory.r.some((m) => m.role === "assistant" || (m.role === "user" && /h2e2|开局炮|已省略/.test(m.content || ""))));

  const legacy = { ...saved };
  delete legacy.memory;
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
  assert.equal(fromLegacy.memory.r[0].role, "system");
  assert.ok(fromLegacy.memory.r.length >= 2, "旧存档应按 records 重建压缩记忆");
  const rebuilt = rebuildMemoryFromRecords("r", legacy.moves);
  assert.equal(rebuilt[0].role, "system");
  assert.ok(rebuilt.some((m) => m.role === "tool" && /h2e2/.test(m.content || "")));
}


// 25) 压缩阈值：默认约 96k；小窗口取 min(80%, 窗−输出)；请求预算+输出不超过窗
{
  assert.equal(CONTEXT_COMPRESS_RATIO, 0.8);
  assert.equal(DEFAULT_CONTEXT_TOKENS, 131072);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32768);
  const def = contextBudget(DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(def, Math.min(Math.floor(131072 * 0.8), 131072 - 32768));
  assert.equal(def, 98304, "默认阈值应为 ~96k");
  assert.ok(def + DEFAULT_MAX_OUTPUT_TOKENS <= DEFAULT_CONTEXT_TOKENS);

  const small = contextBudget(10000, 8000);
  assert.equal(small, Math.min(Math.floor(10000 * 0.8), 10000 - 8000));
  assert.equal(small, 2000);
  assert.ok(small + 8000 <= 10000);

  const tight = contextBudget(5000, 4500);
  assert.equal(tight, Math.min(Math.floor(5000 * 0.8), 5000 - 4500));
  assert.equal(tight, 500);
  assert.ok(tight + 4500 <= 5000);
}

// 26) trimMessages 发出去的消息不得带 _meta；半截 tool_calls 要削干净
{
  const msgs = [
    { role: "system", content: "s" },
    {
      role: "user",
      content: "turn " + "盘".repeat(20),
      _meta: { kind: "turn", turnPly: 0, full: true },
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "a", type: "function", function: { name: "commit_move", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "look_board", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", name: "commit_move", content: "ok" },
    {
      role: "user",
      content: "next",
      _meta: { kind: "turn", turnPly: 2, full: true },
    },
  ];
  const out = trimMessages(msgs, 128000, false, 8000);
  assert.equal(out.every((m) => !("_meta" in m)), true, "请求体不得含 _meta");
  const asst = out.find((m) => m.role === "assistant");
  assert.ok(asst);
  assert.deepEqual(
    (asst.tool_calls || []).map((c) => c.id),
    ["a"],
    "未收到结果的 tool_call 必须去掉",
  );
}

// 27) persist：onPersist 返回 false 时降级为 omitMemory 再写
{
  const writes = [];
  const match = makeMatch();
  match.hooks.onPersist = (data) => {
    writes.push(data);
    if (data.memory) return false;
    return true;
  };
  match.memory.r.push({
    role: "user",
    content: "x",
    _meta: { kind: "turn", turnPly: 0, full: false },
  });
  match.persist();
  assert.equal(writes.length, 2, "应先写全量再降级");
  assert.ok(writes[0].memory, "第一次带 memory");
  assert.equal("memory" in writes[1], false, "降级后omit memory");
}

// 28) packMemory 不得截断 reasoning_content（DeepSeek 原样回放）
{
  const match = makeMatch();
  match.memory.r = [
    { role: "system", content: "s" },
    {
      role: "assistant",
      content: "c",
      reasoning_content: "R".repeat(2000),
      tool_calls: [{ id: "c1", type: "function", function: { name: "commit_move", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", name: "commit_move", content: "ok" },
  ];
  const packed = match.serialize().memory.r;
  const asst = packed.find((m) => m.role === "assistant");
  assert.equal(asst.reasoning_content.length, 2000, "reasoning_content 必须原样保留");
}

// 29) 裁判代走说明在 persist 之前写入 memory
{
  const snapshots = [];
  const match = makeMatch();
  match.hooks.onPersist = (data) => {
    snapshots.push(data);
    return true;
  };
  // 直接走 random 代走路径的核心：append 后 apply
  const legal = (await import("./engine.js")).legalMoves(match.pos);
  const move = legal[0];
  const notation = "测试着";
  const turnPly = match.records.length;
  match.appendSubstituteNote("r", move, "测", notation, turnPly);
  match.applyCommitted({ move, iccs: move.iccs, thought: "裁判代走（测）", substitute: true });
  assert.ok(snapshots.length >= 1);
  const mem = snapshots[snapshots.length - 1].memory.r.map((m) => m.content || "").join("\n");
  assert.match(mem, /裁判代走/, "persist 快照里必须已有代走说明");
}

console.log("agent regressions ok");
console.log("board memory ok");
console.log("context budget ok");
console.log("outbound sanitize ok");

