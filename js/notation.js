import { pieceChar } from "./engine.js";

const RED_FILE = ["九", "八", "七", "六", "五", "四", "三", "二", "一"];
const CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function fileLabel(side, file) {
  return side === "r" ? RED_FILE[file] : String(file + 1);
}

function numberLabel(side, value) {
  return side === "r" ? CN[value] : String(value);
}

function samePieces(pos, cell) {
  const found = [];
  for (let rank = 0; rank < 10; rank += 1) {
    for (let file = 0; file < 9; file += 1) {
      const other = pos.board[rank][file];
      if (other && other.side === cell.side && other.type === cell.type) found.push({ file, rank });
    }
  }
  return found;
}

function disambiguate(cell, from, peers) {
  const onFile = peers.filter((item) => item.file === from.file);
  if (onFile.length < 2) return { prefix: "", filePart: fileLabel(cell.side, from.file) };
  const front = [...onFile].sort((a, b) => (cell.side === "r" ? b.rank - a.rank : a.rank - b.rank));
  const index = front.findIndex((item) => item.rank === from.rank);
  let prefix = "前";
  if (front.length === 2) prefix = index === 0 ? "前" : "后";
  else if (front.length === 3) prefix = ["前", "中", "后"][index];
  else prefix = `前${numberLabel(cell.side, index + 1)}`;
  return { prefix, filePart: "" };
}

export function toNotation(pos, move) {
  const cell = pos.board[move.from.rank][move.from.file];
  if (!cell) return move.iccs || "";
  const { prefix, filePart } = disambiguate(cell, move.from, samePieces(pos, cell));
  const dr = move.to.rank - move.from.rank;
  let action;
  let target;
  if (dr === 0) {
    action = "平";
    target = fileLabel(cell.side, move.to.file);
  } else {
    const forward = cell.side === "r" ? dr > 0 : dr < 0;
    action = forward ? "进" : "退";
    if (cell.type === "N" || cell.type === "B" || cell.type === "A") target = fileLabel(cell.side, move.to.file);
    else target = numberLabel(cell.side, Math.abs(dr));
  }
  return `${prefix}${pieceChar(cell)}${filePart}${action}${target}`;
}
