/** Xiangqi rules. Rank 0 is Red's back rank; file 0 is the left file from Red's view. */

export const START_FEN =
  "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

const TYPES = ["K", "A", "B", "N", "R", "C", "P"];

export function opposite(side) {
  return side === "r" ? "b" : "r";
}

export function piece(side, type) {
  return { side, type };
}

export function emptyPosition(side = "r") {
  return {
    board: Array.from({ length: 10 }, () => Array(9).fill(null)),
    side,
    halfmove: 0,
  };
}

export function clonePosition(pos) {
  return {
    board: pos.board.map((row) => row.map((cell) => (cell ? { ...cell } : null))),
    side: pos.side,
    halfmove: pos.halfmove,
  };
}

function inPalace(side, file, rank) {
  if (file < 3 || file > 5) return false;
  return side === "r" ? rank <= 2 : rank >= 7;
}

function onOwnSide(side, rank) {
  return side === "r" ? rank <= 4 : rank >= 5;
}

function onBoard(file, rank) {
  return file >= 0 && file < 9 && rank >= 0 && rank < 10;
}

export function fromFEN(fen) {
  const parts = fen.trim().split(/\s+/);
  const ranks = parts[0].split("/");
  if (ranks.length !== 10) throw new Error("FEN 行数不对");
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  ranks.forEach((row, index) => {
    const rank = 9 - index;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "9") {
        file += Number(ch);
        continue;
      }
      const type = ch.toUpperCase();
      if (!TYPES.includes(type)) throw new Error(`未知棋子 ${ch}`);
      board[rank][file] = { side: ch === type ? "r" : "b", type };
      file += 1;
    }
    if (file !== 9) throw new Error("FEN 列数不对");
  });
  const side = parts[1] === "b" ? "b" : "r";
  const halfmove = Number(parts[4] || 0) || 0;
  return { board, side, halfmove };
}

export function toFEN(pos) {
  const rows = [];
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 9; file += 1) {
      const cell = pos.board[rank][file];
      if (!cell) {
        empty += 1;
        continue;
      }
      if (empty) {
        row += String(empty);
        empty = 0;
      }
      const letter = cell.type;
      row += cell.side === "r" ? letter : letter.toLowerCase();
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return `${rows.join("/")} ${pos.side === "b" ? "b" : "w"} - - ${pos.halfmove} 1`;
}

export function startingPosition() {
  return fromFEN(START_FEN);
}

export function findKing(board, side) {
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const cell = board[rank][file];
      if (cell && cell.side === side && cell.type === "K") return { file, rank };
    }
  }
  return null;
}

function kingsFace(board) {
  const red = findKing(board, "r");
  const black = findKing(board, "b");
  if (!red || !black || red.file !== black.file) return false;
  const file = red.file;
  const low = Math.min(red.rank, black.rank) + 1;
  const high = Math.max(red.rank, black.rank);
  for (let rank = low; rank < high; rank += 1) {
    if (board[rank][file]) return false;
  }
  return true;
}

function pathClear(board, file, rank, tf, tr) {
  const df = Math.sign(tf - file);
  const dr = Math.sign(tr - rank);
  let f = file + df;
  let r = rank + dr;
  while (f !== tf || r !== tr) {
    if (board[r][f]) return false;
    f += df;
    r += dr;
  }
  return true;
}

function screensBetween(board, file, rank, tf, tr) {
  const df = Math.sign(tf - file);
  const dr = Math.sign(tr - rank);
  let count = 0;
  let f = file + df;
  let r = rank + dr;
  while (f !== tf || r !== tr) {
    if (board[r][f]) count += 1;
    f += df;
    r += dr;
  }
  return count;
}

function attacksSquare(board, file, rank, targetFile, targetRank) {
  const cell = board[rank][file];
  if (!cell) return false;
  const df = targetFile - file;
  const dr = targetRank - rank;
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  const target = board[targetRank][targetFile];
  if (target && target.side === cell.side) return false;

  switch (cell.type) {
    case "K":
      if (!inPalace(cell.side, targetFile, targetRank)) return false;
      return adf + adr === 1;
    case "A":
      return adf === 1 && adr === 1 && inPalace(cell.side, file, rank) && inPalace(cell.side, targetFile, targetRank);
    case "B": {
      if (adf !== 2 || adr !== 2) return false;
      if (!onOwnSide(cell.side, rank) || !onOwnSide(cell.side, targetRank)) return false;
      return !board[rank + dr / 2][file + df / 2];
    }
    case "N": {
      if (!((adf === 1 && adr === 2) || (adf === 2 && adr === 1))) return false;
      const legFile = file + (adf === 2 ? Math.sign(df) : 0);
      const legRank = rank + (adr === 2 ? Math.sign(dr) : 0);
      return !board[legRank][legFile];
    }
    case "R":
      if (df !== 0 && dr !== 0) return false;
      if (df === 0 && dr === 0) return false;
      return pathClear(board, file, rank, targetFile, targetRank);
    case "C": {
      if (df !== 0 && dr !== 0) return false;
      if (df === 0 && dr === 0) return false;
      const screens = screensBetween(board, file, rank, targetFile, targetRank);
      if (!target) return screens === 0;
      return screens === 1;
    }
    case "P": {
      const forward = cell.side === "r" ? 1 : -1;
      if (df === 0 && dr === forward) return true;
      const crossed = cell.side === "r" ? rank >= 5 : rank <= 4;
      return crossed && dr === 0 && adf === 1;
    }
    default:
      return false;
  }
}

export function isAttacked(board, targetFile, targetRank, bySide) {
  if (kingsFace(board)) {
    const victim = findKing(board, opposite(bySide));
    if (victim && victim.file === targetFile && victim.rank === targetRank) return true;
  }
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const cell = board[rank][file];
      if (!cell || cell.side !== bySide) continue;
      if (attacksSquare(board, file, rank, targetFile, targetRank)) return true;
    }
  }
  return false;
}

export function inCheck(pos, side) {
  const king = findKing(pos.board, side);
  if (!king) return true;
  if (kingsFace(pos.board)) return true;
  return isAttacked(pos.board, king.file, king.rank, opposite(side));
}

function addMove(moves, board, file, rank, tf, tr) {
  if (!onBoard(tf, tr)) return;
  const target = board[tr][tf];
  const self = board[rank][file];
  if (target && target.side === self.side) return;
  if (!attacksSquare(board, file, rank, tf, tr)) return;
  moves.push({ from: { file, rank }, to: { file: tf, rank: tr } });
}

function pseudoMovesFrom(board, file, rank) {
  const cell = board[rank][file];
  const moves = [];
  if (!cell) return moves;
  if (cell.type === "K" || cell.type === "A" || cell.type === "B" || cell.type === "N" || cell.type === "P") {
    for (let tr = 0; tr < 10; tr += 1) {
      for (let tf = 0; tf < 9; tf += 1) addMove(moves, board, file, rank, tf, tr);
    }
    return moves;
  }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [df, dr] of dirs) {
    let tf = file + df;
    let tr = rank + dr;
    let seen = 0;
    while (onBoard(tf, tr)) {
      const target = board[tr][tf];
      if (cell.type === "R") {
        if (!target) moves.push({ from: { file, rank }, to: { file: tf, rank: tr } });
        else {
          if (target.side !== cell.side) moves.push({ from: { file, rank }, to: { file: tf, rank: tr } });
          break;
        }
      } else if (!target) {
        if (seen === 0) moves.push({ from: { file, rank }, to: { file: tf, rank: tr } });
      } else {
        seen += 1;
        if (seen === 1) {
          /* screen */
        } else if (seen === 2) {
          if (target.side !== cell.side) moves.push({ from: { file, rank }, to: { file: tf, rank: tr } });
          break;
        } else break;
      }
      tf += df;
      tr += dr;
    }
  }
  return moves;
}

export function iccsOf(move) {
  const fileChar = (file) => "abcdefghi"[file];
  return `${fileChar(move.from.file)}${move.from.rank}${fileChar(move.to.file)}${move.to.rank}`;
}

export function parseIcCS(text) {
  const match = String(text || "")
    .trim()
    .toLowerCase()
    .match(/^([a-i])([0-9])([a-i])([0-9])$/);
  if (!match) return null;
  return {
    from: { file: match[1].charCodeAt(0) - 97, rank: Number(match[2]) },
    to: { file: match[3].charCodeAt(0) - 97, rank: Number(match[4]) },
  };
}

export function applyMove(pos, move) {
  const next = clonePosition(pos);
  const pieceAt = next.board[move.from.rank][move.from.file];
  const captured = next.board[move.to.rank][move.to.file];
  next.board[move.to.rank][move.to.file] = pieceAt;
  next.board[move.from.rank][move.from.file] = null;
  next.side = opposite(pos.side);
  next.halfmove = captured ? 0 : pos.halfmove + 1;
  return next;
}

export function legalMoves(pos) {
  const moves = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const cell = pos.board[rank][file];
      if (!cell || cell.side !== pos.side) continue;
      for (const move of pseudoMovesFrom(pos.board, file, rank)) {
        const next = applyMove(pos, move);
        if (!inCheck(next, pos.side)) moves.push({ ...move, iccs: iccsOf(move) });
      }
    }
  }
  return moves;
}

export function terminalStatus(pos) {
  if (legalMoves(pos).length > 0) return null;
  if (!findKing(pos.board, pos.side)) {
    return { winner: opposite(pos.side), reason: "将死" };
  }
  if (inCheck(pos, pos.side)) return { winner: opposite(pos.side), reason: "将死" };
  return { winner: opposite(pos.side), reason: "困毙" };
}

export function positionKey(pos) {
  let key = pos.side;
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const cell = pos.board[rank][file];
      key += cell ? (cell.side === "r" ? cell.type : cell.type.toLowerCase()) : ".";
    }
  }
  return key;
}

const PIECE_CHAR = {
  r: { K: "帅", A: "仕", B: "相", N: "马", R: "车", C: "炮", P: "兵" },
  b: { K: "将", A: "士", B: "象", N: "马", R: "车", C: "炮", P: "卒" },
};

export function pieceChar(cell) {
  if (!cell) return "·";
  return PIECE_CHAR[cell.side][cell.type];
}

export function asciiBoard(pos) {
  const lines = ["   a b c d e f g h i"];
  for (let rank = 9; rank >= 0; rank -= 1) {
    const cells = [];
    for (let file = 0; file < 9; file += 1) cells.push(pieceChar(pos.board[rank][file]));
    lines.push(`${rank}  ${cells.join(" ")}`);
  }
  return lines.join("\n");
}

export function sideName(side) {
  return side === "r" ? "红方" : "黑方";
}
