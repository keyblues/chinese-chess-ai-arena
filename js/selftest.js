import assert from "node:assert/strict";
import {
  applyMove,
  emptyPosition,
  fromFEN,
  inCheck,
  legalMoves,
  parseIcCS,
  piece,
  startingPosition,
  terminalStatus,
  toFEN,
} from "./engine.js";
import { toNotation } from "./notation.js";
import { loadMatches, loadSettings, saveActive, saveMatch } from "./storage.js";
import { dockRank } from "./ui.js";

function iccsSet(pos) {
  return new Set(legalMoves(pos).map((move) => move.iccs));
}

function place(pos, file, rank, side, type) {
  pos.board[rank][file] = piece(side, type);
}

const start = startingPosition();
assert.equal(toFEN(start).split(" ")[0], "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR");
assert.equal(toFEN(fromFEN(toFEN(start))).split(" ")[0], toFEN(start).split(" ")[0]);

const opening = iccsSet(start);
assert.ok(opening.has("h2e2"), "炮二平五");
assert.ok(opening.has("b0c2"), "马八进七");
const cannon = legalMoves(start).find((move) => move.iccs === "h2e2");
const horse = legalMoves(start).find((move) => move.iccs === "b0c2");
assert.equal(toNotation(start, cannon), "炮二平五");
assert.equal(toNotation(start, horse), "马八进七");

const blackHorse = emptyPosition("b");
place(blackHorse, 4, 0, "r", "K");
place(blackHorse, 3, 9, "b", "K");
place(blackHorse, 1, 9, "b", "N");
const b9c7 = legalMoves(blackHorse).find((move) => move.iccs === "b9c7");
assert.ok(b9c7);
assert.equal(toNotation(blackHorse, b9c7), "马2进3");

const leg = emptyPosition("r");
place(leg, 4, 0, "r", "K");
place(leg, 3, 9, "b", "K");
place(leg, 1, 0, "r", "N");
place(leg, 1, 1, "r", "P");
const legMoves = iccsSet(leg);
assert.equal(legMoves.has("b0a2"), false, "马腿被挡不能跳 a2");
assert.equal(legMoves.has("b0c2"), false, "马腿被挡不能跳 c2");
assert.ok(legMoves.has("b0d1"), "另一侧马腿空着仍可走");

const cannonPos = emptyPosition("r");
place(cannonPos, 4, 0, "r", "K");
place(cannonPos, 3, 9, "b", "K");
place(cannonPos, 0, 0, "r", "C");
place(cannonPos, 0, 3, "r", "P");
place(cannonPos, 0, 6, "b", "P");
place(cannonPos, 0, 8, "b", "P");
const cannonMoves = iccsSet(cannonPos);
assert.ok(cannonMoves.has("a0a1"));
assert.ok(cannonMoves.has("a0a2"));
assert.equal(cannonMoves.has("a0a3"), false, "不能吃掉炮架");
assert.equal(cannonMoves.has("a0a4"), false, "空走不能越子");
assert.ok(cannonMoves.has("a0a6"), "隔一个子可以打");
assert.equal(cannonMoves.has("a0a8"), false, "隔两个子不能打");

const face = emptyPosition("r");
place(face, 4, 0, "r", "K");
place(face, 4, 9, "b", "K");
const faceMoves = iccsSet(face);
assert.equal(faceMoves.has("e0e1"), false, "飞将，帅不能留在同一线");
assert.ok(faceMoves.has("e0d0"));
assert.ok(faceMoves.has("e0f0"));
assert.equal(faceMoves.has("e0e9"), false, "帅不能隔空吃将");
assert.equal(inCheck(face, "r"), true);

const pawn = emptyPosition("r");
place(pawn, 3, 0, "r", "K");
place(pawn, 5, 9, "b", "K");
place(pawn, 4, 4, "r", "P");
place(pawn, 6, 5, "r", "P");
const before = iccsSet(pawn);
assert.ok(before.has("e4e5"));
assert.equal(before.has("e4d4"), false, "未过河不能横走");
assert.ok(before.has("g5g6"));
assert.ok(before.has("g5f5"));
assert.ok(before.has("g5h5"));
assert.equal(before.has("g5g4"), false, "兵不能后退");

const blackPawn = emptyPosition("b");
place(blackPawn, 3, 0, "r", "K");
place(blackPawn, 5, 9, "b", "K");
place(blackPawn, 4, 5, "b", "P");
place(blackPawn, 6, 4, "b", "P");
const blackPawnMoves = iccsSet(blackPawn);
assert.ok(blackPawnMoves.has("e5e4"));
assert.equal(blackPawnMoves.has("e5d5"), false);
assert.ok(blackPawnMoves.has("g4g3"));
assert.ok(blackPawnMoves.has("g4f4"));
assert.ok(blackPawnMoves.has("g4h4"));

const stuck = fromFEN("3k5/9/9/9/9/9/9/9/3p1p3/4K4 w - - 0 1");
assert.equal(inCheck(stuck, "r"), false);
assert.equal(legalMoves(stuck).length, 0);
assert.deepEqual(terminalStatus(stuck), { winner: "b", reason: "困毙" });

const mate = fromFEN("R3k4/9/4P4/2N3N2/9/9/9/9/9/4K4 b - - 0 1");
assert.equal(inCheck(mate, "b"), true);
assert.equal(legalMoves(mate).length, 0);
assert.deepEqual(terminalStatus(mate), { winner: "r", reason: "将死" });

const reveal = emptyPosition("r");
place(reveal, 4, 0, "r", "K");
place(reveal, 4, 9, "b", "R");
place(reveal, 4, 1, "r", "A");
place(reveal, 3, 9, "b", "K");
const revealMoves = iccsSet(reveal);
assert.equal(revealMoves.has("e0f0"), true, "帅可以躲开黑车");
const advisorMoves = legalMoves(reveal).filter((move) => move.from.file === 4 && move.from.rank === 1);
assert.equal(advisorMoves.length, 0, "走开挡车的仕会送帅");

assert.deepEqual(parseIcCS("H2e2"), { from: { file: 7, rank: 2 }, to: { file: 4, rank: 2 } });

const twoRooks = emptyPosition("r");
place(twoRooks, 4, 0, "r", "K");
place(twoRooks, 3, 9, "b", "K");
place(twoRooks, 0, 0, "r", "R");
place(twoRooks, 0, 3, "r", "R");
const frontRook = legalMoves(twoRooks).find((move) => move.iccs === "a3a4");
const backRook = legalMoves(twoRooks).find((move) => move.iccs === "a0a1");
assert.equal(toNotation(twoRooks, frontRook), "前车进一");
assert.equal(toNotation(twoRooks, backRook), "后车进一");

const played = applyMove(start, cannon);
assert.equal(played.side, "b");
assert.equal(played.board[2][4].type, "C");
assert.equal(played.board[2][7], null);

console.log(`engine ok, opening moves ${opening.size}`);

// 行棋日志：条目按（回合, 步序, 类型）落位，最新的一条必须还在最下面。
// 旧实现丢了 ply（恒为 0），新回合的第 0 步会被插到旧回合的第 1、2 步上面。
const live = (ply, id) => ({ ply, item: { id } });
const chronological = [
  live(0, "think-0"), live(0, "say-0"), live(0, "tool-0-0"),
  live(1, "think-0"), live(1, "tool-1-0"),
  live(2, "think-0"), live(2, "tool-0-0"), live(2, "tool-1-0"),
  live(3, "think-0"), live(3, "nudge-0"),
];
// 反序“到达”（最难的情况：工具结果晚到、后一回合先到），落位后仍必须是时间序
const placed = [];
for (const entry of [...chronological].reverse()) {
  const rank = dockRank(entry.ply, entry.item);
  const at = placed.findIndex((item) => item.rank > rank);
  if (at < 0) placed.push({ rank, ...entry });
  else placed.splice(at, 0, { rank, ...entry });
}
assert.deepEqual(
  placed.map((entry) => `${entry.ply}:${entry.item.id}`),
  chronological.map((entry) => `${entry.ply}:${entry.item.id}`),
  "日志落位必须是时间序",
);

// 恢复历史对局时条目没有 id，用数组下标当步序，同样保持时序
assert.ok(dockRank(0, { id: "" }, 3) > dockRank(0, { id: "" }, 2));
assert.ok(dockRank(1, { id: "" }, 0) > dockRank(0, { id: "" }, 7));
assert.ok(dockRank(0, { id: "tool-2-0" }) > dockRank(0, { id: "tool-1-0" }));
assert.ok(dockRank(0, { id: "tool-0-0" }) > dockRank(0, { id: "say-0" }), "同一步：输出在工具卡之前");
assert.ok(dockRank(0, { id: "nudge-0" }) > dockRank(0, { id: "tool-0-0" }), "裁判条目排在本步工具卡之后");
assert.ok(dockRank(0, { id: "tool-0-1" }) > dockRank(0, { id: "tool-0-0" }), "同一步的多次工具调用按序号");
assert.equal(dockRank(2, { id: "think-1" }), dockRank(2, { id: "think-1" }), "同一个条目反复渲染必须落同一位置");
console.log("dock order ok");

// 存储配额：写不进 localStorage 时不许抛（persist 在每手落子之后，抛出去会被判成"中断"终结对局）
{
  const store = new Map();
  const limit = 2;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (key === "xq.active" && value.length > 200) throw new Error("QuotaExceededError");
      if (key === "xq.matches" && JSON.parse(value).length > limit) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key) => store.delete(key),
  };
  const record = (id) => ({ id, startedAt: Date.now(), moves: [], result: null, players: { r: { name: "红" }, b: { name: "黑" } } });
  assert.equal(saveMatch(record("m1")).length, 1);
  assert.equal(saveMatch(record("m2")).length, 2);
  assert.equal(saveMatch(record("m3")).length, 2, "配额满时保存要自己砍旧局");
  assert.equal(loadMatches().length, 2, "砍完之后落盘的确实是能放下的一版");
  assert.equal(loadMatches()[0].id, "m3", "最新一局必须留住");
  assert.doesNotThrow(() => saveActive({ id: "big", moves: new Array(50).fill({ iccs: "h2e2" }) }), "未完成对局写不下时也要静默放过");

  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.doesNotThrow(() => saveMatch(record("m4")), "一个字都写不进去时同样不许抛");
  assert.doesNotThrow(() => saveActive({ id: "big", moves: new Array(50).fill({ iccs: "h2e2" }) }));
}
console.log("storage ok");

// 供应商：旧版新增行的 id 是每次读取现生成的，存档里的 providerId 可能谁也对不上。
// 载入时必须自愈到第一个供应商（否则红方会拿着黑方的地址和密钥开局）
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  store.set("xq.settings", JSON.stringify({
    providers: [
      { id: "pA", name: "A", baseUrl: "https://a.test/v1", apiKey: "ka" },
      { id: "pB", name: "B", baseUrl: "https://b.test/v1", apiKey: "kb" },
    ],
    red: { name: "红", providerId: "p_ghost_999", model: "m1" },
    black: { name: "黑", providerId: "pB", model: "m2" },
  }));
  const settings = loadSettings();
  assert.equal(settings.red.providerId, "pA", "对不上的 providerId 要修到第一个供应商");
  assert.equal(settings.black.providerId, "pB", "对得上的不许动");
  assert.equal(settings.red.model, "m1", "修复不能顺手把别的字段改掉");
  assert.ok(settings.providers.some((provider) => provider.id === settings.red.providerId));
}
console.log("settings ok");
