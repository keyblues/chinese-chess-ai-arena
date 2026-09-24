// Agent 循环的行为测试：用假 fetch 喂固定 SSE，检查"被截断"这一类情况的处理。
// 跑法：node js/agent-selftest.js
import assert from "node:assert/strict";
import { fromFEN, legalMoves, positionKey } from "./engine.js";
import { Match, resolveAfterMove } from "./match.js";

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
  assert.equal(outcome.kind, "move", "抬高上限后应当能落子");
  assert.equal(outcome.iccs, "b0c2");
  assert.deepEqual(caps(), [8000, 16000], "截断后重发要把输出上限翻倍");
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
  assert.deepEqual(caps(), [8000, 16000, 32000], "最多抬高两次就该收手");
}

// 4) 工具参数被截断（半截 JSON）同样按截断处理，不算违规
{
  const { outcome } = await play([
    brokenToolCall("commit_move", '{"move":"h2'),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ]);
  assert.equal(outcome.kind, "move");
  assert.deepEqual(caps(), [8000, 16000]);
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
  assert.deepEqual(caps(), [8000, 16000]);
  requests = [];
  script = [toolCall("commit_move", { move: "b0c2", thought: "马八进七" })];
  const second = await match.playTurn();
  assert.equal(second.kind, "move");
  assert.deepEqual(caps(), [16000], "下一回合应当从上一次抬高后的上限起步");
}

// 7) 厂商把抬高的上限 400 拒掉时不许把整局打挂：退回原上限、继续下
{
  script = [
    reasoning("想很久", "length"),
    httpError(400, "max_tokens is too large: 16000"),
    toolCall("commit_move", { move: "h2e2", thought: "炮二平五" }),
  ];
  requests = [];
  const match = makeMatch();
  const outcome = await match.playTurn();
  assert.equal(outcome.kind, "move", "被 400 拒绝后仍要在原上限下把这一步走完");
  assert.deepEqual(caps(), [8000, 16000, 8000], "退回原上限重发，而不是一路抬高");
  assert.match(match.traces.r.find((item) => item.id === "nudge-1").result, /压到 8k/);
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
  const { match, outcome } = await play([strict, strict], 200000);
  assert.equal(outcome.kind, "move", "压到硬顶之后要把这一步走完");
  assert.deepEqual(caps(), [200000, 8192], "一次就要压到常见硬顶，别一步步折半烧步骤");
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
  assert.deepEqual(caps(), [8000, 16000], "JSON 路径的 length 也要抬高上限重发");
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

console.log("agent regressions ok");
