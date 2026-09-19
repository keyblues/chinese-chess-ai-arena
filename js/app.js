import { applyMove, inCheck, parseIcCS, startingPosition, toFEN } from "./engine.js";
import { testConnection } from "./llm.js";
import { Match, resultText } from "./match.js";
import { clearActive, loadActive, loadMatches, loadSettings, saveActive, saveMatch, saveSettings } from "./storage.js";
import { createUI, transcript } from "./ui.js";

let settings = loadSettings();
let history = loadMatches();
let match = null;
let review = null;

const ui = createUI({
  onStart: startMatch,
  onPause: togglePause,
  onStop: () => match?.stop(),
  onSave: (next) => {
    settings = next;
    saveSettings(settings);
    ui.toast("设置已保存在这台浏览器");
    paint();
  },
  onTest: testApi,
  onHistory: openHistory,
  onPly: (ply) => {
    if (match && (match.status === "playing" || match.paused)) return;
    const source = review?.saved || finishedRecord();
    if (!source) return;
    review = { saved: source, ply };
    paint();
  },
  onReview: (delta) => {
    if (!review) return;
    if (delta === 0) {
      review = null;
      paint();
      return;
    }
    review.ply = Math.max(0, Math.min(review.saved.moves.length, review.ply + delta));
    paint();
  },
  onCopy: async () => {
    const moves = currentMoves();
    if (!moves.length) {
      ui.toast("还没有着法");
      return;
    }
    try {
      await navigator.clipboard.writeText(transcript(moves));
      ui.toast("棋谱已复制");
    } catch {
      ui.toast("复制失败，请手动选择着法");
    }
  },
});

const hooks = {
  getSettings: () => settings,
  onUpdate: () => {
    if (!review) paint();
  },
  onClock: (clocks) => {
    if (!review) ui.setClocks(clocks);
  },
  onPersist: (data) => saveActive(data),
  onFinish: (data) => {
    clearActive();
    history = saveMatch(data);
    ui.setHistory(history);
    paint();
  },
};

function idleSnapshot() {
  const pos = startingPosition();
  const ms = settings.mainMinutes * 60 * 1000;
  return {
    status: "idle",
    paused: false,
    result: null,
    pos,
    fen: toFEN(pos),
    clocks: { r: ms, b: ms },
    active: null,
    phase: { r: "待开局", b: "待开局" },
    traces: { r: [], b: [] },
    moves: [],
    preview: null,
    lastMove: null,
    players: { r: settings.red, b: settings.black },
    checkSide: null,
  };
}

function positionAt(moves, ply) {
  let pos = startingPosition();
  let last = null;
  for (let i = 0; i < ply; i += 1) {
    const parsed = parseIcCS(moves[i].iccs);
    if (!parsed) break;
    pos = applyMove(pos, parsed);
    last = moves[i];
  }
  return { pos, last };
}

function tracesUntil(moves, ply) {
  const shown = moves.slice(0, ply);
  return {
    r: [...shown].reverse().find((item) => item.side === "r")?.trace || [],
    b: [...shown].reverse().find((item) => item.side === "b")?.trace || [],
  };
}

function finishedRecord() {
  if (!match || match.status !== "finished") return null;
  return match.exportMatch();
}

function currentMoves() {
  if (review) return review.saved.moves;
  if (match) return match.records;
  return [];
}

function reviewSnapshot() {
  const saved = review.saved;
  const { pos, last } = positionAt(saved.moves, review.ply);
  return {
    status: "review",
    paused: false,
    result: saved.result,
    pos,
    fen: toFEN(pos),
    clocks: saved.clocks || { r: 0, b: 0 },
    active: null,
    phase: { r: saved.players.r.model, b: saved.players.b.model },
    traces: tracesUntil(saved.moves, review.ply),
    moves: saved.moves,
    focusPly: review.ply,
    preview: null,
    lastMove: last,
    players: saved.players,
    checkSide: inCheck(pos, pos.side) ? pos.side : null,
    review: {
      label: `回看 ${review.ply} / ${saved.moves.length} · ${resultText(saved.result)}`,
      ply: review.ply,
      total: saved.moves.length,
    },
  };
}

function paint() {
  if (review) ui.update(reviewSnapshot());
  else if (match) ui.update(match.snapshot());
  else ui.update(idleSnapshot());
}

function providerFor(side) {
  return settings.providers.find((provider) => provider.id === side.providerId) || settings.providers[0] || null;
}

function startMatch() {
  settings = ui.readSettings();
  saveSettings(settings);
  const redProvider = providerFor(settings.red);
  const blackProvider = providerFor(settings.black);
  if (!redProvider?.baseUrl || !redProvider.apiKey || !blackProvider?.baseUrl || !blackProvider.apiKey) {
    ui.toast("双方所选供应商都要填接口地址和 API Key");
    ui.openSettings();
    return;
  }
  if (!settings.red.model || !settings.black.model) {
    ui.toast("双方模型都不能为空");
    ui.openSettings();
    return;
  }
  review = null;
  match = new Match({ settings, hooks });
  match.start();
  paint();
}

function togglePause() {
  if (!match) return;
  if (match.paused || match.status === "paused") match.resume();
  else match.pause();
  paint();
}

async function testApi() {
  const draft = ui.readSettings();
  const provider = draft.providers.find((item) => item.id === draft.red.providerId) || draft.providers[0];
  if (!provider?.baseUrl || !provider.apiKey) {
    ui.setTestResult("红方所选供应商需要接口地址和 API Key", false);
    return;
  }
  ui.setTestResult("正在连接…");
  try {
    const result = await testConnection({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: draft.red.model });
    if (result.models?.length) ui.setModels(result.models);
    ui.setTestResult(result.message, true);
  } catch (error) {
    ui.setTestResult(error.message || String(error), false);
  }
}

function openHistory(id) {
  if (match && (match.status === "playing" || match.paused)) {
    ui.toast("对局还没结束，停止后才能回看其他棋谱");
    return;
  }
  const saved = history.find((item) => item.id === id) || (match?.id === id ? match.exportMatch() : null);
  if (!saved) return;
  review = { saved, ply: saved.moves.length };
  document.querySelector("#history").close();
  paint();
}

ui.fillSettings(settings);
ui.setHistory(history);
const saved = loadActive();
if (saved) {
  match = new Match({ settings, hooks, saved });
  match.status = "paused";
  match.paused = true;
  ui.toast("已恢复未完成的对局，点继续接着下");
}
paint();
ui.fitBoard();
