import { applyMove, inCheck, parseIcCS, startingPosition, toFEN } from "./engine.js";
import { testConnection } from "./llm.js";
import { Match, resultText } from "./match.js";
import { clearActive, loadActive, loadMatches, loadSettings, saveActive, saveMatch, saveSettings } from "./storage.js";
import { saveGameMemory, loadGameMemory, deleteGameMemory } from "./memory-store.js";
import { createUI, transcript } from "./ui.js";

let settings = loadSettings();
let history = loadMatches();
let match = null;
let review = null;

const ui = createUI({
  onStart: startMatch,
  onPause: togglePause,
  onStop: () => match?.stop(),
  getSavedSettings: () => settings,
  onSave: (next) => {
    settings = next;
    saveSettings(settings);
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
  // 直接吃 snapshot：paint() 会再建一份快照，而流式期间这里每 80ms 就要走一次
  onUpdate: (snap) => {
    if (!review) ui.update(snap);
  },
  onClock: (clocks) => {
    if (!review) ui.setClocks(clocks);
  },
  onPersist: (data) => saveActive(data),
  onPersistMemory: (gameId, memory) => saveGameMemory(gameId, memory, { onWarn: (msg) => ui.toast(msg) }),
  onMemoryWarn: (msg) => ui.toast(msg),
  onNeedSettings: (message) => {
    ui.toast(message);
    ui.openSettings();
  },
  onFinish: (data) => {
    clearActive();
    void deleteGameMemory(data.id);
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

// 供应商只看 id：找不到就是找不到，绝不退回 providers[0]——那样红方会拿着黑方的地址和密钥开局
function providerById(providers, id) {
  return providers.find((provider) => provider.id === id) || null;
}

function startMatch() {
  if (ui.isSettingsDirty?.()) {
    ui.toast("设置里有未保存的修改，请先保存或取消");
    ui.openSettings();
    return;
  }
  // 开局只用已保存的设置，不把对话框草稿悄悄落盘
  const redProvider = providerById(settings.providers, settings.red.providerId);
  const blackProvider = providerById(settings.providers, settings.black.providerId);
  if (!redProvider || !blackProvider) {
    ui.toast("所选的供应商不存在了，请在设置里重新选择红黑双方的供应商");
    ui.openSettings();
    return;
  }
  const missing = [];
  if (!redProvider.baseUrl || !redProvider.apiKey) missing.push("红方");
  if (!blackProvider.baseUrl || !blackProvider.apiKey) missing.push("黑方");
  if (missing.length) {
    ui.toast(`${missing.join("、")}所选供应商要填接口地址和 API Key`);
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
  const lines = [];
  let ok = true;
  for (const side of ["red", "black"]) {
    const label = side === "red" ? "红方" : "黑方";
    const player = draft[side];
    const provider = providerById(draft.providers, player.providerId);
    if (!provider?.baseUrl || !provider.apiKey) {
      ok = false;
      lines.push(`${label}：供应商缺接口地址或 API Key`);
      continue;
    }
    try {
      const result = await testConnection({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: player.model });
      // 模型候选按供应商各家一份，别把红方那家的模型塞给黑方
      if (result.models?.length) ui.setModels(side, result.models);
      lines.push(`${label}·${provider.name || "供应商"}：${result.message}`);
    } catch (error) {
      ok = false;
      lines.push(`${label}·${provider.name || "供应商"}：${error.message || String(error)}`);
    }
  }
  ui.setTestResult(lines.join("\n"), ok);
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

async function restoreActive() {
  const saved = loadActive();
  if (!saved) return;
  let memory = null;
  try {
    memory = await loadGameMemory(saved.id, { onWarn: (msg) => ui.toast(msg) });
  } catch {
    memory = null;
  }
  match = new Match({ settings, hooks, saved, memory: memory || undefined });
  match.status = "paused";
  match.paused = true;
  if (!memory && !saved.memory) {
    ui.toast("已恢复未完成的对局（会话按棋谱重建），点继续接着下");
  } else {
    ui.toast("已恢复未完成的对局，点继续接着下");
  }
  paint();
}

await restoreActive();
paint();
ui.fitBoard();
