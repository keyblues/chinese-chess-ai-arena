import { resultText } from "./match.js";

const CELL = 64;
const PAD = 40;
const WIDTH = PAD * 2 + CELL * 8;
const HEIGHT = PAD * 2 + CELL * 9;
const PIECE = 52;

const CHAR = {
  r: { K: "帅", A: "仕", B: "相", N: "马", R: "车", C: "炮", P: "兵" },
  b: { K: "将", A: "士", B: "象", N: "马", R: "车", C: "炮", P: "卒" },
};

const TOOL_LABEL = {
  look_board: "look_board · 看盘",
  legal_moves: "legal_moves · 合法着法",
  commit_move: "commit_move · 落子",
  resign: "resign · 认输",
  裁判: "裁判",
};

function xy(file, rank) {
  return [PAD + file * CELL, PAD + (9 - rank) * CELL];
}

function line(x1, y1, x2, y2, cls = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${cls ? ` class="${cls}"` : ""} />`;
}

function star(file, rank, corners) {
  const [x, y] = xy(file, rank);
  const gap = 6;
  const len = 9;
  return corners
    .map(([sx, sy]) => {
      const cx = x + sx * gap;
      const cy = y + sy * gap;
      return line(cx, cy, cx + sx * len, cy) + line(cx, cy, cx, cy + sy * len);
    })
    .join("");
}

function boardSvg() {
  const parts = [];
  for (let file = 0; file < 9; file += 1) {
    const x = xy(file, 0)[0];
    if (file === 0 || file === 8) parts.push(line(x, xy(0, 0)[1], x, xy(0, 9)[1], "edge"));
    else {
      parts.push(line(x, xy(0, 0)[1], x, xy(0, 4)[1]));
      parts.push(line(x, xy(0, 5)[1], x, xy(0, 9)[1]));
    }
  }
  for (let rank = 0; rank < 10; rank += 1) {
    const y = xy(0, rank)[1];
    parts.push(line(xy(0, 0)[0], y, xy(8, 0)[0], y, rank === 0 || rank === 9 ? "edge" : ""));
  }
  const diag = (a, b, c, d) => {
    const [x1, y1] = xy(a, b);
    const [x2, y2] = xy(c, d);
    parts.push(line(x1, y1, x2, y2));
  };
  diag(3, 0, 5, 2);
  diag(5, 0, 3, 2);
  diag(3, 9, 5, 7);
  diag(5, 9, 3, 7);
  const all = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
  const right = [[1, -1], [1, 1]];
  const left = [[-1, -1], [-1, 1]];
  [[1, 2], [7, 2], [1, 7], [7, 7], [2, 3], [4, 3], [6, 3], [2, 6], [4, 6], [6, 6]].forEach(([file, rank]) => {
    parts.push(star(file, rank, all));
  });
  parts.push(star(0, 3, right), star(0, 6, right), star(8, 3, left), star(8, 6, left));
  const riverY = (xy(0, 4)[1] + xy(0, 5)[1]) / 2;
  parts.push(`<text class="river" x="${xy(2, 0)[0]}" y="${riverY}" text-anchor="middle" dominant-baseline="middle">楚河</text>`);
  parts.push(`<text class="river" x="${xy(6, 0)[0]}" y="${riverY}" text-anchor="middle" dominant-baseline="middle">汉界</text>`);
  for (let file = 0; file < 9; file += 1) {
    const [x] = xy(file, 0);
    parts.push(`<text class="coord" x="${x}" y="${xy(0, 0)[1] + 24}" text-anchor="middle">${"abcdefghi"[file]}</text>`);
  }
  for (let rank = 0; rank < 10; rank += 1) {
    const y = xy(0, rank)[1];
    parts.push(`<text class="coord" x="${PAD - 18}" y="${y}" text-anchor="middle" dominant-baseline="middle">${rank}</text>`);
  }
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true">${parts.join("")}</svg>`;
}

function parseMove(iccs) {
  const match = String(iccs || "").match(/^([a-i])([0-9])([a-i])([0-9])$/);
  if (!match) return null;
  return {
    from: { file: match[1].charCodeAt(0) - 97, rank: Number(match[2]) },
    to: { file: match[3].charCodeAt(0) - 97, rank: Number(match[4]) },
  };
}

function clockText(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusText(snap) {
  if (snap.review) return snap.review.label;
  if (!snap || snap.status === "idle") return "待开局";
  if (snap.status === "paused" || snap.paused) return `已暂停 · 轮到${snap.active === "b" ? "黑方" : "红方"}`;
  if (snap.status === "finished") return resultText(snap.result);
  const round = Math.floor((snap.moves?.length || 0) / 2) + 1;
  const who = snap.active === "b" ? "黑方" : "红方";
  return `第 ${round} 回合 · ${who} · ${snap.phase?.[snap.active] || "思考"}`;
}

export function createUI(callbacks) {
  const board = document.querySelector("#board");
  const fit = document.querySelector("#board-fit");
  board.style.width = `${WIDTH}px`;
  board.style.height = `${HEIGHT}px`;
  board.innerHTML = `<div class="board-wood"></div>${boardSvg()}<div class="marks"></div><div class="pieces"></div>`;
  const marks = board.querySelector(".marks");
  const pieces = board.querySelector(".pieces");
  const state = { fen: "", ply: -1, snap: null, timer: 0 };

  function place(el, file, rank) {
    const [x, y] = xy(file, rank);
    el.style.left = `${x - PIECE / 2}px`;
    el.style.top = `${y - PIECE / 2}px`;
  }

  function rebuild(pos) {
    pieces.innerHTML = "";
    if (!pos) return;
    for (let rank = 0; rank < 10; rank += 1) {
      for (let file = 0; file < 9; file += 1) {
        const cell = pos.board[rank][file];
        if (!cell) continue;
        const el = document.createElement("div");
        el.className = `piece ${cell.side} instant`;
        el.textContent = CHAR[cell.side][cell.type];
        el.dataset.sq = `${file},${rank}`;
        el.dataset.side = cell.side;
        el.dataset.type = cell.type;
        place(el, file, rank);
        pieces.append(el);
      }
    }
    requestAnimationFrame(() => pieces.querySelectorAll(".instant").forEach((el) => el.classList.remove("instant")));
  }

  function fitBoard() {
    const scale = Math.min(1, fit.clientWidth / WIDTH);
    board.style.transform = `scale(${scale})`;
    fit.style.height = `${HEIGHT * scale}px`;
  }

  function drawMarks(snap) {
    marks.innerHTML = "";
    pieces.querySelectorAll(".ghost").forEach((el) => el.remove());
    pieces.querySelectorAll(".check").forEach((el) => el.classList.remove("check"));
    const last = parseMove(snap.lastMove?.iccs);
    if (last) {
      for (const [point, cls] of [[last.from, "from"], [last.to, "to"]]) {
        const el = document.createElement("div");
        el.className = `mark ${cls}`;
        const [x, y] = xy(point.file, point.rank);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        marks.append(el);
      }
    }
    if (snap.preview && snap.pos) {
      const cell = snap.pos.board[snap.preview.from.rank][snap.preview.from.file];
      if (cell) {
        const ghost = document.createElement("div");
        ghost.className = `piece ghost ${cell.side}`;
        ghost.textContent = CHAR[cell.side][cell.type];
        place(ghost, snap.preview.to.file, snap.preview.to.rank);
        pieces.append(ghost);
      }
    }
    if (snap.checkSide) {
      const king = [...pieces.querySelectorAll(".piece")].find((el) => el.dataset.side === snap.checkSide && el.dataset.type === "K" && !el.classList.contains("ghost"));
      king?.classList.add("check");
    }
  }

  function flash(text) {
    board.querySelector(".flash")?.remove();
    const el = document.createElement("div");
    el.className = "flash";
    el.textContent = text;
    board.append(el);
    setTimeout(() => el.remove(), 1200);
  }

  function animate(move, pos) {
    const parsed = parseMove(move.iccs);
    const moving = parsed && pieces.querySelector(`[data-sq="${parsed.from.file},${parsed.from.rank}"]`);
    if (!parsed || !moving) {
      rebuild(pos);
      return;
    }
    const captured = pieces.querySelector(`[data-sq="${parsed.to.file},${parsed.to.rank}"]`);
    place(moving, parsed.to.file, parsed.to.rank);
    moving.dataset.sq = `${parsed.to.file},${parsed.to.rank}`;
    captured?.classList.add("gone");
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.snap?.pos) rebuild(state.snap.pos);
      if (state.snap) drawMarks(state.snap);
    }, 340);
  }

  function syncTrace(side, items, active) {
    const root = document.querySelector(`#trace-${side}`);
    const list = items || [];
    if (!list.length) {
      root.innerHTML = active
        ? `<p class="trace-empty">正在请求模型。思维链和工具调用会逐段出现。</p>`
        : `<p class="trace-empty">等待行棋。模型要先调用 legal_moves，再调用 commit_move。口头着法不算数。</p>`;
      return;
    }
    const keys = list.map((item, index) => item.id || `${index}-${item.kind}-${item.title}`);
    [...root.children].forEach((child) => {
      if (!keys.includes(child.dataset.key)) child.remove();
    });
    list.forEach((item, index) => {
      const key = keys[index];
      let card = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!card) {
        card = document.createElement("article");
        card.dataset.key = key;
        card.innerHTML = "<header></header><pre class='body'></pre><pre class='result'></pre>";
        root.append(card);
      }
      card.className = `trace-card ${item.kind || ""} ${item.ok === false ? "bad" : ""} ${item.pending ? "pending" : ""}`;
      const title = item.kind === "tool" ? TOOL_LABEL[item.title] || item.title : item.title;
      card.querySelector("header").innerHTML = item.kind === "tool" ? `<span>工具</span><strong>${escapeText(title)}</strong>` : escapeText(title);
      card.querySelector(".body").textContent = item.body || "";
      card.querySelector(".result").textContent = item.result || "";
    });
    root.scrollTop = root.scrollHeight;
  }

  function renderMoves(snap) {
    const list = document.querySelector("#movelist");
    const moves = snap.moves || [];
    const focus = snap.focusPly ?? moves.length;
    list.innerHTML = "";
    for (let i = 0; i < moves.length; i += 2) {
      const row = document.createElement("li");
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i / 2 + 1);
      row.append(num);
      [i, i + 1].forEach((index) => {
        if (!moves[index]) {
          row.append(document.createElement("span"));
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = moves[index].notation;
        if (index + 1 === focus) button.className = "on";
        button.addEventListener("click", () => callbacks.onPly?.(index + 1));
        row.append(button);
      });
      list.append(row);
    }
    const shown = moves[Math.max(0, focus - 1)];
    document.querySelector("#detail").textContent = shown?.thought ? `${shown.notation} · ${shown.thought}` : "";
  }

  function setClocks(clocks) {
    ["r", "b"].forEach((side) => {
      const el = document.querySelector(`#clock-${side}`);
      el.textContent = clockText(clocks[side]);
      el.classList.toggle("low", clocks[side] < 30000);
    });
  }

  function update(snap) {
    state.snap = snap;
    document.querySelector("#status").textContent = statusText(snap);
    ["r", "b"].forEach((side) => {
      const seat = document.querySelector(`#seat-${side}`);
      seat.classList.toggle("active", snap.active === side);
      seat.classList.toggle("dim", Boolean(snap.active) && snap.active !== side);
      document.querySelector(`#name-${side}`).textContent = snap.players?.[side]?.name || (side === "r" ? "红方" : "黑方");
      document.querySelector(`#model-${side}`).textContent = snap.players?.[side]?.model || "";
      document.querySelector(`#phase-${side}`).textContent = snap.phase?.[side] || (snap.status === "idle" ? "待开局" : "");
      syncTrace(side, snap.traces?.[side], snap.active === side);
    });
    setClocks(snap.clocks || { r: 0, b: 0 });
    const ply = snap.moves?.length || 0;
    if (snap.fen !== state.fen) {
      const forward = ply === state.ply + 1 && snap.lastMove;
      state.fen = snap.fen;
      state.ply = ply;
      if (forward) {
        animate(snap.lastMove, snap.pos);
        flash(snap.lastMove.notation);
      } else rebuild(snap.pos);
    }
    drawMarks(snap);
    renderMoves(snap);
    const banner = document.querySelector("#banner");
    if (snap.status === "finished" && snap.result) {
      banner.hidden = false;
      banner.textContent = snap.result.detail ? `${resultText(snap.result)}。${snap.result.detail}` : resultText(snap.result);
    } else if (snap.review) {
      banner.hidden = false;
      banner.textContent = snap.review.label;
    } else banner.hidden = true;
    const live = snap.status === "playing" || snap.status === "paused" || snap.paused;
    document.querySelector("#btn-start").disabled = live;
    document.querySelector("#btn-pause").disabled = !live && snap.status !== "paused";
    document.querySelector("#btn-pause").textContent = snap.paused || snap.status === "paused" ? "继续" : "暂停";
    document.querySelector("#btn-stop").disabled = !live;
    document.querySelector("#review-bar").hidden = !snap.review;
    document.querySelector("#btn-prev").disabled = !snap.review || snap.review.ply <= 0;
    document.querySelector("#btn-next").disabled = !snap.review || snap.review.ply >= snap.review.total;
  }

  function fillSettings(settings) {
    document.querySelector("#base-url").value = settings.baseUrl;
    document.querySelector("#api-key").value = settings.apiKey;
    document.querySelector("#temperature").value = settings.temperature;
    document.querySelector("#main-minutes").value = settings.mainMinutes;
    document.querySelector("#increment").value = settings.incrementSeconds;
    document.querySelector("#red-name").value = settings.red.name;
    document.querySelector("#red-model").value = settings.red.model;
    document.querySelector("#red-style").value = settings.red.style;
    document.querySelector("#black-name").value = settings.black.name;
    document.querySelector("#black-model").value = settings.black.model;
    document.querySelector("#black-style").value = settings.black.style;
  }

  function readSettings() {
    const number = (id, fallback) => {
      const value = Number(document.querySelector(id).value);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      baseUrl: document.querySelector("#base-url").value.trim(),
      apiKey: document.querySelector("#api-key").value.trim(),
      temperature: number("#temperature", 0.4),
      mainMinutes: number("#main-minutes", 5),
      incrementSeconds: number("#increment", 15),
      red: {
        name: document.querySelector("#red-name").value.trim() || "红方",
        model: document.querySelector("#red-model").value.trim(),
        style: document.querySelector("#red-style").value.trim(),
      },
      black: {
        name: document.querySelector("#black-name").value.trim() || "黑方",
        model: document.querySelector("#black-model").value.trim(),
        style: document.querySelector("#black-style").value.trim(),
      },
    };
  }

  function setHistory(matches) {
    const list = document.querySelector("#history-list");
    if (!matches.length) {
      list.innerHTML = `<li><span>还没有结束的对局。</span></li>`;
      return;
    }
    list.innerHTML = "";
    matches.forEach((match) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const when = new Date(match.startedAt).toLocaleString("zh-CN", { hour12: false });
      button.innerHTML = `<strong>${escapeText(match.players.r.name)} 对 ${escapeText(match.players.b.name)}</strong><span>${when} · ${escapeText(resultText(match.result))} · ${match.moves.length} 手</span>`;
      button.addEventListener("click", () => callbacks.onHistory?.(match.id));
      item.append(button);
      list.append(item);
    });
  }

  function setModels(ids) {
    const list = document.querySelector("#model-list");
    list.innerHTML = ids.map((id) => `<option value="${escapeText(id)}"></option>`).join("");
  }

  function setTestResult(text, ok) {
    const el = document.querySelector("#test-result");
    el.textContent = text || "";
    el.className = `test-result ${ok === true ? "ok" : ok === false ? "bad" : ""}`;
  }

  let toastTimer = 0;
  function toast(message) {
    const el = document.querySelector("#toast");
    el.hidden = false;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2800);
  }

  document.querySelector("#btn-start").addEventListener("click", () => callbacks.onStart?.());
  document.querySelector("#btn-pause").addEventListener("click", () => callbacks.onPause?.());
  document.querySelector("#btn-stop").addEventListener("click", () => callbacks.onStop?.());
  document.querySelector("#btn-settings").addEventListener("click", () => document.querySelector("#settings").showModal());
  document.querySelector("#btn-close-settings").addEventListener("click", () => document.querySelector("#settings").close());
  document.querySelector("#btn-history").addEventListener("click", () => document.querySelector("#history").showModal());
  document.querySelector("#btn-close-history").addEventListener("click", () => document.querySelector("#history").close());
  document.querySelector("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    callbacks.onSave?.(readSettings());
    document.querySelector("#settings").close();
  });
  document.querySelector("#btn-test").addEventListener("click", () => callbacks.onTest?.());
  document.querySelector("#btn-prev").addEventListener("click", () => callbacks.onReview?.(-1));
  document.querySelector("#btn-next").addEventListener("click", () => callbacks.onReview?.(1));
  document.querySelector("#btn-exit-review").addEventListener("click", () => callbacks.onReview?.(0));
  document.querySelector("#btn-copy").addEventListener("click", () => callbacks.onCopy?.());
  window.addEventListener("resize", fitBoard);
  fitBoard();

  return { update, setClocks, fillSettings, readSettings, setHistory, setModels, setTestResult, toast, fitBoard, openSettings: () => document.querySelector("#settings").showModal() };
}

export function transcript(moves) {
  const lines = [];
  for (let i = 0; i < moves.length; i += 2) {
    const red = moves[i]?.notation || "";
    const black = moves[i + 1]?.notation || "";
    lines.push(`${i / 2 + 1}. ${red}${black ? ` ${black}` : ""}`);
  }
  return lines.join("\n");
}
