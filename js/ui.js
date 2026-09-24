import { resultText } from "./match.js";

// 横置棋盘：黑在上手（左），红在下手（右）。
// 列 = 纵线（由 9 路…0 路自左向右），行 = 文件线（a…i 自上而下）。
const CELLX = 66;
const CELLY = 58;
const PAD = 64;
const WIDTH = PAD * 2 + CELLX * 9;
const HEIGHT = PAD * 2 + CELLY * 8;
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

function colX(col) {
  return PAD + col * CELLX;
}

function rowY(row) {
  return PAD + row * CELLY;
}

// ICCS 坐标 -> 屏幕坐标
function xy(file, rank) {
  return [colX(9 - rank), rowY(file)];
}

function line(x1, y1, x2, y2, cls = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${cls ? ` class="${cls}"` : ""} />`;
}

function star(col, row, corners) {
  const x = colX(col);
  const y = rowY(row);
  const gap = 6;
  const len = 9;
  return corners
    .map(([sx, sy]) => line(x + sx * gap, y + sy * gap, x + sx * (gap + len), y + sy * gap) + line(x + sx * gap, y + sy * gap, x + sx * gap, y + sy * (gap + len)))
    .join("");
}

function boardSvg() {
  const parts = [];
  // 纵线（10 条 = 10 路），两端边线全高
  for (let col = 0; col <= 9; col += 1) {
    parts.push(line(colX(col), rowY(0), colX(col), rowY(8), col === 0 || col === 9 ? "edge" : ""));
  }
  // 横线（9 条 = 9 个文件线），边线（a/i）全宽，其余被楚河汉界断开
  for (let row = 0; row <= 8; row += 1) {
    if (row === 0 || row === 8) {
      parts.push(line(colX(0), rowY(row), colX(9), rowY(row), "edge"));
    } else {
      parts.push(line(colX(0), rowY(row), colX(4), rowY(row)));
      parts.push(line(colX(5), rowY(row), colX(9), rowY(row)));
    }
  }
  // 九宫斜线：黑（左，0-2 列）、红（右，7-9 列）
  parts.push(line(colX(0), rowY(3), colX(2), rowY(5)));
  parts.push(line(colX(0), rowY(5), colX(2), rowY(3)));
  parts.push(line(colX(9), rowY(3), colX(7), rowY(5)));
  parts.push(line(colX(9), rowY(5), colX(7), rowY(3)));
  // 炮位与兵位刻痕
  const all = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
  const down = [[1, 1], [-1, 1]];
  const up = [[1, -1], [-1, -1]];
  [[7, 1], [7, 7], [2, 1], [2, 7], [6, 2], [6, 4], [6, 6], [3, 2], [3, 4], [3, 6]].forEach(([col, row]) => {
    parts.push(star(col, row, all));
  });
  parts.push(star(6, 0, down), star(3, 0, down), star(6, 8, up), star(3, 8, up));
  // 楚河汉界（竖排于河界带）
  const riverX = colX(4.5);
  [["楚", 1.55], ["河", 2.75], ["汉", 5.25], ["界", 6.45]].forEach(([text, row]) => {
    parts.push(`<text class="river" x="${riverX}" y="${rowY(row)}" text-anchor="middle" dominant-baseline="middle">${text}</text>`);
  });
  // 坐标：路号 9…0 于上缘，文件 a…i 于左缘（避开边线棋子的圆盘）
  for (let rank = 0; rank <= 9; rank += 1) {
    parts.push(`<text class="coord" x="${colX(9 - rank)}" y="${PAD - 38}" text-anchor="middle" dominant-baseline="middle">${rank}</text>`);
  }
  for (let file = 0; file <= 8; file += 1) {
    parts.push(`<text class="coord" x="${PAD - 38}" y="${rowY(file)}" text-anchor="middle" dominant-baseline="middle">${"abcdefghi"[file]}</text>`);
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

// 行棋日志的排序键：回合（ply）→ 步序（step）→ 条目类型（思维链/输出/工具/裁判）→ 同一步内的调用序号。
// 条目一律按这个键插进 DOM，所以流式回调的到达顺序、晚到的工具结果都不会再打乱时序。
const DOCK_KIND_ORDER = { think: 0, say: 1, tool: 2, nudge: 3 };

export function dockRank(ply, item, stepFallback = 0) {
  const match = String(item?.id || "").match(/^(think|say|tool|nudge)-(\d+)(?:-(\d+))?$/);
  const step = match ? Number(match[2]) : stepFallback;
  const kind = match ? DOCK_KIND_ORDER[match[1]] : DOCK_KIND_ORDER[item?.kind] ?? 2;
  const sub = match?.[3] ? Math.min(Number(match[3]), 99) : 0;
  return ply * 100000 + step * 1000 + kind * 100 + sub;
}

export function createUI(callbacks) {
  const board = document.querySelector("#board");
  const fit = document.querySelector("#board-fit");
  board.style.width = `${WIDTH}px`;
  board.style.height = `${HEIGHT}px`;
  board.innerHTML = `<div class="board-wood"></div>${boardSvg()}<div class="marks"></div><div class="pieces"></div>`;
  const marks = board.querySelector(".marks");
  const pieces = board.querySelector(".pieces");
  const state = { fen: "", ply: -1, snap: null, timer: 0, movesStamp: "", movesRef: null };

  if (window.ResizeObserver) {
    new ResizeObserver(() => fitBoard()).observe(fit.parentElement);
  }

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
    // 桌面（≥1121px）：主列剩余高度全给棋盘区，宽高双约束取最小缩放，可与页面同伸缩；
    // 窄屏（文档流）：按宽度适配。
    const frame = fit.parentElement;
    const availW = Math.max(200, frame.clientWidth);
    const desktop = window.matchMedia("(min-width: 1121px)").matches;
    const scale = desktop
      ? Math.min(availW / WIDTH, Math.max(240, frame.clientHeight) / HEIGHT, 1.35)
      : Math.min(1, availW / WIDTH);
    fit.style.width = `${WIDTH * scale}px`;
    fit.style.height = `${HEIGHT * scale}px`;
    board.style.transform = `scale(${scale})`;
    board.style.transformOrigin = "top left";
    board.style.position = "absolute";
    board.style.left = "0";
    board.style.top = "0";
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

  function renderMoves(snap) {
    const list = document.querySelector("#movelist");
    const moves = snap.moves || [];
    const focus = snap.focusPly ?? moves.length;
    // 流式期间每个 token 都会走到这里：棋谱没换、手数/焦点没变就不重建整条绸带
    const stamp = `${snap.status}:${moves.length}:${focus}`;
    const sameList = state.movesRef === moves;
    state.movesRef = moves;
    if (sameList && state.movesStamp === stamp) return;
    state.movesStamp = stamp;
    list.innerHTML = "";
    for (let i = 0; i < moves.length; i += 1) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mv ${moves[i].side === "r" ? "r" : "b"}`;
      if (i + 1 === focus) button.classList.add("on");
      const no = document.createElement("span");
      no.className = "no";
      no.textContent = String(Math.floor(i / 2) + 1);
      button.append(no, document.createTextNode(moves[i].notation));
      if (moves[i].substitute) {
        const tag = document.createElement("span");
        tag.className = "sub";
        tag.textContent = "裁判代走";
        tag.title = moves[i].thought || "裁判代走";
        button.append(tag);
      }
      button.addEventListener("click", () => callbacks.onPly?.(i + 1));
      li.append(button);
      list.append(li);
    }
    const shown = moves[Math.max(0, focus - 1)];
    // 只在绸带内横向滚动，避免把整页竖直拽动
    const focused = list.querySelector(".on");
    if (focused) {
      const left = focus >= moves.length
        ? focused.offsetLeft + focused.offsetWidth + 28 - list.clientWidth
        : focused.offsetLeft - list.clientWidth / 2;
      list.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    } else {
      list.scrollLeft = list.scrollWidth;
    }
  }

  function setClocks(clocks) {
    ["r", "b"].forEach((side) => {
      const el = document.querySelector(`#clock-${side}`);
      el.textContent = clockText(clocks[side]);
      el.classList.toggle("low", clocks[side] < 30000);
    });
  }

  /* ---------- 行棋日志坞：双方面板按时间序合流 ---------- */
  const dockBody = document.querySelector("#dock-log");
  const dockState = { entries: [], map: new Map(), seeded: false, matchId: "" };

  function dockEntryEl(entry) {
    const el = document.createElement("div");
    el.className = `log-entry ${entry.kind} ${entry.ok === false ? "bad" : ""} ${entry.pending ? "pending" : ""}`;
    el.dataset.key = entry.key;
    const head = document.createElement("div");
    head.className = "log-head";
    const tag = document.createElement("i");
    tag.className = `side-tag ${entry.side}`;
    tag.textContent = entry.side === "r" ? "红" : "黑";
    const title = document.createElement("b");
    head.append(tag, title, Object.assign(document.createElement("span"), { className: "log-turn", textContent: entry.turn }));
    el.append(head);
    const body = document.createElement("pre");
    body.className = "log-body";
    el.append(body);
    if (entry.result) {
      const result = document.createElement("pre");
      result.className = "log-body log-result";
      el.append(result);
    }
    dockBody.append(el);
    return el;
  }

  // 工具入参是空对象或仅占位字段（如 {"__dummy":""}）时，参数行不值得展示
  function trivialArgs(body) {
    const text = String(body || "").trim();
    if (!text || text === "{}") return true;
    try {
      const obj = JSON.parse(text);
      return !!obj && typeof obj === "object" && !Array.isArray(obj)
        && Object.keys(obj).every((key) => key === "__dummy" && !String(obj[key]).trim());
    } catch {
      return false;
    }
  }

  function dockPaintText(entry) {
    const el = entry.el;
    const title = entry.kind === "tool" ? TOOL_LABEL[entry.title] || entry.title : entry.title || (entry.kind === "think" ? "思维链" : "输出");
    el.querySelector(".log-head b").textContent = title;
    el.querySelector(".log-head .log-turn").textContent = entry.turn;
    el.className = `log-entry ${entry.kind} ${entry.ok === false ? "bad" : ""} ${entry.pending ? "pending" : ""}${entry.long ? " foldable" : ""}${entry.open ? " open" : ""}`;
    const bodyEl = el.querySelector(".log-body");
    bodyEl.style.display = entry.kind === "tool" && trivialArgs(entry.body) ? "none" : "";
    bodyEl.textContent = entry.body || "";
    const resultEl = el.querySelector(".log-result");
    if (resultEl) resultEl.textContent = entry.result || "";
  }

  function dockPush(key, side, item, ply, stepFallback = 0, live = false) {
    const body = String(item.body || "");
    const entry = {
      key,
      side,
      live,
      kind: item.kind || "think",
      title: item.title || "",
      body,
      result: String(item.result || ""),
      ok: item.ok,
      pending: item.pending,
      turn: `第${Math.floor(ply / 2) + 1}回合`,
      rank: dockRank(ply, item, stepFallback),
      long: body.length > 220 || String(item.result || "").length > 160,
      open: false,
      el: null,
    };
    entry.el = dockEntryEl(entry);
    dockPaintText(entry);
    dockState.entries.push(entry);
    dockState.map.set(key, entry);
    dockPlace(entry);
    while (dockState.entries.length > 240) {
      const old = dockState.entries.shift();
      old.el.remove();
      dockState.map.delete(old.key);
    }
  }

  function dockRemove(entry) {
    entry.el.remove();
    dockState.map.delete(entry.key);
    const at = dockState.entries.indexOf(entry);
    if (at >= 0) dockState.entries.splice(at, 1);
  }

  // 换了一局就换一本日志：上一局的卡片不能留在新对局里
  function dockReset() {
    dockState.entries.length = 0;
    dockState.map.clear();
    dockBody.innerHTML = "";
    dockState.seeded = false;
  }

  // 新条目按排序键落位：晚到的工具结果、后一回合的条目都不会再插到旧条目上面
  function dockPlace(entry) {
    for (const child of dockBody.children) {
      if (child === entry.el) continue;
      const other = dockState.map.get(child.dataset.key);
      if (other && other.rank > entry.rank) {
        dockBody.insertBefore(entry.el, child);
        return;
      }
    }
  }

  function dockSync(snap) {
    if (snap.review) return; // 回看是历史回放，不进实时日志
    const moves = snap.moves || [];
    if (snap.id && dockState.matchId && snap.id !== dockState.matchId) dockReset();
    if (snap.id) dockState.matchId = snap.id;
    if (!dockState.seeded) {
      dockState.seeded = true;
      const from = Math.max(0, moves.length - 6);
      moves.slice(-6).forEach((record, offset) => {
        const ply = from + offset;
        (record.trace || []).forEach((item, idx) => {
          if ((item.kind === "say" || item.kind === "think") && !String(item.body || "").trim()) return;
          dockPush(`${record.side}:${ply}:${idx}`, record.side, { ...item, pending: false }, ply, idx);
        });
      });
    }
    const nearBottom = dockBody.scrollTop + dockBody.clientHeight >= dockBody.scrollHeight - 80;
    let added = false;
    const round = Math.floor(moves.length / 2) + 1;
    document.querySelector("#dock-round").textContent = moves.length ? `第 ${round} 回合` : "";
    ["b", "r"].forEach((side) => {
      const live = new Set();
      // 恢复的对局里条目没有自己的 ply：退回"这条 trace 属于哪一手"，
      // 这样它和已经按棋谱播过的卡片是同一个键，只更新、不重复画
      const tracePly = Number.isFinite(snap.tracePly?.[side]) ? snap.tracePly[side] : moves.length;
      (snap.traces?.[side] || []).forEach((item, idx) => {
        // 空白"输出/思维链"（模型只吐了空格）不建卡，等有内容再入列
        if ((item.kind === "say" || item.kind === "think") && !String(item.body || "").trim()) return;
        // 键里带条目自己的回合号（item.ply），落子后同一个条目不会被当成新条目重复入列
        const ply = Number.isFinite(item.ply) ? item.ply : tracePly;
        const key = `${side}:${ply}:${item.id || idx}`;
        live.add(key);
        const entry = dockState.map.get(key);
        if (!entry) {
          dockPush(key, side, item, ply, idx, true);
          added = true;
          return;
        }
        const body = String(item.body || "");
        const result = String(item.result || "");
        if (entry.body !== body || entry.result !== result || entry.ok !== item.ok || entry.pending !== item.pending) {
          entry.body = body;
          entry.result = result;
          entry.ok = item.ok;
          entry.pending = item.pending;
          entry.long = entry.long || body.length > 220 || result.length > 160;
          dockPaintText(entry);
        }
      });
      // 引擎重开本回合时会清空 trace（暂停后继续、刷新后接着下、截断后重来）：
      // 那一次尝试留下的卡片跟着撤掉，别让放弃的尝试和新的尝试在日志里并列
      const stale = dockState.entries.filter(
        (entry) => entry.live && entry.side === side && entry.ply === moves.length && !live.has(entry.key),
      );
      stale.forEach(dockRemove);
    });
    if (added || nearBottom) dockBody.scrollTop = dockBody.scrollHeight;
  }

  dockBody.addEventListener("click", (event) => {
    const el = event.target.closest(".log-entry");
    if (!el) return;
    const entry = dockState.map.get(el.dataset.key);
    if (!entry?.long) return;
    entry.open = !entry.open;
    dockPaintText(entry);
  });

  function update(snap) {
    state.snap = snap;
    ["r", "b"].forEach((side) => {
      const seat = document.querySelector(`#seat-${side}`);
      seat.classList.toggle("active", snap.active === side);
      seat.classList.toggle("dim", Boolean(snap.active) && snap.active !== side);
      document.querySelector(`#name-${side}`).textContent = snap.players?.[side]?.name || (side === "r" ? "红方" : "黑方");
      document.querySelector(`#model-${side}`).textContent = snap.players?.[side]?.model || "";
      document.querySelector(`#phase-${side}`).textContent = snap.phase?.[side] || (snap.status === "idle" ? "待开局" : "");
    });
    dockSync(snap);
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
    const result = snap.result;
    // 印章只盖真实胜负（含和棋）；中断/中止这类供应商或人为中断走日志与提示
    const realResult = snap.status === "finished" && result && ["r", "b", "draw"].includes(result.winner);
    if (realResult) {
      banner.hidden = false;
      banner.textContent = result.detail ? `${resultText(result)}。${result.detail}` : resultText(result);
    } else if (snap.review) {
      banner.hidden = false;
      banner.textContent = snap.review.label;
    } else {
      banner.hidden = true;
      if (snap.status === "finished" && result) {
        const moves = snap.moves || [];
        const key = `sys:${moves.length}:${result.reason}`;
        if (!dockState.map.has(key)) {
          // 中断/超时这类没有 active 方，按输家一侧挂标签，别一律记在红方头上
          const loser = result.winner === "r" ? "b" : result.winner === "b" ? "r" : null;
          dockPush(
            key,
            snap.active || loser || "r",
            {
              kind: "tool",
              title: "裁判",
              body: "",
              result: result.detail ? `${result.reason} · ${result.detail}` : result.reason,
              ok: false,
              pending: false,
            },
            moves.length,
            99,
          );
          toast(result.detail ? `${result.reason}：${result.detail}` : result.reason);
        }
      }
    }
    const live = snap.status === "playing" || snap.status === "paused" || snap.paused;
    document.querySelector("#btn-start").disabled = live;
    document.querySelector("#btn-pause").disabled = !live && snap.status !== "paused";
    document.querySelector("#btn-pause").textContent = snap.paused || snap.status === "paused" ? "继续" : "暂停";
    document.querySelector("#btn-stop").disabled = !live;
    document.querySelector("#review-bar").hidden = !snap.review;
    document.querySelector("#btn-prev").disabled = !snap.review || snap.review.ply <= 0;
    document.querySelector("#btn-next").disabled = !snap.review || snap.review.ply >= snap.review.total;
  }

  function providerRow(provider) {
    const row = document.createElement("div");
    row.className = "provider-row";
    row.dataset.id = provider.id || "";
    row.innerHTML = `
      <input class="pr-name" placeholder="名称" />
      <input class="pr-url" placeholder="接口地址，如 https://openrouter.ai/api/v1" />
      <input class="pr-key" type="password" placeholder="API Key" autocomplete="off" />
      <button class="ghost-btn pr-del" type="button" title="删除该供应商">删</button>`;
    row.querySelector(".pr-name").value = provider.name || "";
    row.querySelector(".pr-url").value = provider.baseUrl || "";
    row.querySelector(".pr-key").value = provider.apiKey || "";
    row.querySelector(".pr-del").addEventListener("click", () => {
      if (document.querySelectorAll(".provider-row").length <= 1) {
        toast("至少保留一个供应商");
        return;
      }
      row.remove();
      refreshProviderOptions();
    });
    return row;
  }

  function collectProviders() {
    return [...document.querySelectorAll(".provider-row")]
      .map((row) => {
        // 新增行的 id 必须当场写回 DOM：每次读都现生成一个的话，
        // 保存的 providerId 和 providers[].id 对不上，红黑双方会静默跑到别人的供应商上去
        if (!row.dataset.id) row.dataset.id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        return {
          id: row.dataset.id,
          name: row.querySelector(".pr-name").value.trim(),
          baseUrl: row.querySelector(".pr-url").value.trim(),
          apiKey: row.querySelector(".pr-key").value.trim(),
        };
      })
      .filter((provider) => provider.baseUrl || provider.apiKey || provider.name);
  }

  function refreshProviderOptions() {
    const providers = collectProviders();
    ["red", "black"].forEach((side) => {
      const select = document.querySelector(`#${side}-provider`);
      const current = select.value;
      select.innerHTML = providers
        .map((provider, index) => `<option value="${escapeText(provider.id)}">${escapeText(provider.name || `供应商 ${index + 1}`)}</option>`)
        .join("");
      if (providers.some((provider) => provider.id === current)) select.value = current;
    });
  }

  function renderProviders(providers) {
    const root = document.querySelector("#provider-rows");
    root.innerHTML = "";
    (providers.length ? providers : [{}]).forEach((provider) => root.append(providerRow(provider)));
    refreshProviderOptions();
  }

  function fillSettings(settings) {
    document.querySelector("#temperature").value = settings.temperature;
    document.querySelector("#main-minutes").value = settings.mainMinutes;
    document.querySelector("#increment").value = settings.incrementSeconds;
    renderProviders(settings.providers || []);
    ["red", "black"].forEach((side) => {
      const player = settings[side] || {};
      document.querySelector(`#${side}-name`).value = player.name || "";
      document.querySelector(`#${side}-provider`).value = player.providerId || "";
      document.querySelector(`#${side}-model`).value = player.model || "";
      document.querySelector(`#${side}-thinking`).value = player.thinking || "off";
      document.querySelector(`#${side}-context`).value = player.contextTokens ?? 128000;
      document.querySelector(`#${side}-maxout`).value = player.maxOutputTokens ?? 8000;
    });
  }

  function readSettings() {
    const number = (id, fallback, min = 0) => {
      const value = Number(document.querySelector(id).value);
      return Number.isFinite(value) && value >= min ? value : fallback;
    };
    const side = (prefix, fallbackName) => ({
      name: document.querySelector(`#${prefix}-name`).value.trim() || fallbackName,
      providerId: document.querySelector(`#${prefix}-provider`).value,
      model: document.querySelector(`#${prefix}-model`).value.trim(),
      thinking: document.querySelector(`#${prefix}-thinking`).value || "off",
      contextTokens: number(`#${prefix}-context`, 128000, 1024),
      maxOutputTokens: number(`#${prefix}-maxout`, 8000, 256),
    });
    return {
      providers: collectProviders(),
      temperature: number("#temperature", 0.4),
      mainMinutes: number("#main-minutes", 60, 1),
      incrementSeconds: number("#increment", 60),
      red: side("red", "红方"),
      black: side("black", "黑方"),
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

  function setModels(side, ids) {
    const list = document.querySelector(`#${side}-model-list`);
    if (list) list.innerHTML = ids.map((id) => `<option value="${escapeText(id)}"></option>`).join("");
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
  document.querySelector("#btn-add-provider").addEventListener("click", () => {
    document.querySelector("#provider-rows").append(providerRow({}));
    refreshProviderOptions();
  });
  // 新增的供应商边填边进下拉：不用再增删一行去"刷新"，也不必等失焦
  document.querySelector("#provider-rows").addEventListener("input", refreshProviderOptions);
  document.querySelector("#provider-rows").addEventListener("change", refreshProviderOptions);
  // 换了供应商，上一家的模型候选就作废，免得把别人家的模型 id 填进来
  ["red", "black"].forEach((side) => {
    document.querySelector(`#${side}-provider`).addEventListener("change", () => setModels(side, []));
  });
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
