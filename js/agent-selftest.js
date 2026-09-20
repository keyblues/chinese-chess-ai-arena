// Agent 循环的行为测试：用假 fetch 喂固定 SSE，检查"被截断"这一类情况的处理。
// 跑法：node js/agent-selftest.js
import assert from "node:assert/strict";
import { Match } from "./match.js";

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

let script = [];
let requests = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  const next = script.shift();
  assert.ok(next, "测试脚本用完了响应，但 Agent 又发了一次请求");
  return typeof next === "function" ? next(body) : next;
};

function makeMatch(maxOutputTokens = 8000) {
  const player = (name) => ({ name, providerId: "p", model: "stub-model", contextTokens: 128000, maxOutputTokens });
  return new Match({
    settings: {
      providers: [{ id: "p", name: "stub", baseUrl: "https://stub.test/v1", apiKey: "k" }],
      temperature: 0.4,
      mainMinutes: 60,
      incrementSeconds: 60,
      red: player("红"),
      black: player("黑"),
    },
    hooks: { onUpdate() {}, onClock() {}, onPersist() {}, onFinish() {} },
  });
}

async function play(scripted, maxOutputTokens) {
  script = scripted;
  requests = [];
  const match = makeMatch(maxOutputTokens);
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

console.log("agent loop ok");