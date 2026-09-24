/**
 * 对局会话记忆：优先 IndexedDB（按对局 id），不可用时内存 Map 兜底。
 * localStorage 只保留轻量棋谱；完整 messages 走这里。
 */

const DB_NAME = "xq-arena";
const DB_VERSION = 1;
const STORE = "memories";

/** @type {Map<string, { r: object[], b: object[] }>} */
const memoryFallback = new Map();
let idbUnavailable = false;
let warningShown = false;

function openDb() {
  if (idbUnavailable || typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function markUnavailable(onWarn) {
  idbUnavailable = true;
  if (!warningShown) {
    warningShown = true;
    onWarn?.("本机 IndexedDB 不可用，对局记忆无法完整落盘；刷新后将按棋谱重建摘要记忆");
  }
}

/** Node / 测试：注入内存实现，并视作可用 */
export function useMemoryStoreShim(map = memoryFallback) {
  idbUnavailable = false;
  warningShown = false;
  globalThis.indexedDB = undefined;
  // 强制走 fallback map；测试直接用下面的 API 即可
  memoryFallback.clear();
  for (const [key, value] of map) memoryFallback.set(key, value);
  return memoryFallback;
}

export function resetMemoryStoreForTests() {
  memoryFallback.clear();
  idbUnavailable = false;
  warningShown = false;
}

export async function saveGameMemory(gameId, memory, { onWarn } = {}) {
  if (!gameId || !memory) return false;
  const payload = {
    r: Array.isArray(memory.r) ? memory.r : [],
    b: Array.isArray(memory.b) ? memory.b : [],
    savedAt: Date.now(),
  };
  memoryFallback.set(gameId, payload);
  if (idbUnavailable || typeof indexedDB === "undefined") {
    if (typeof indexedDB === "undefined") markUnavailable(onWarn);
    return !idbUnavailable || memoryFallback.has(gameId);
  }
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(payload, gameId);
    });
    db.close();
    return true;
  } catch (error) {
    markUnavailable(onWarn);
    return memoryFallback.has(gameId);
  }
}

export async function loadGameMemory(gameId, { onWarn } = {}) {
  if (!gameId) return null;
  if (memoryFallback.has(gameId)) {
    const hit = memoryFallback.get(gameId);
    return { r: hit.r || [], b: hit.b || [] };
  }
  if (idbUnavailable || typeof indexedDB === "undefined") {
    if (typeof indexedDB === "undefined") markUnavailable(onWarn);
    return null;
  }
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(gameId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!value) return null;
    memoryFallback.set(gameId, value);
    return { r: value.r || [], b: value.b || [] };
  } catch (error) {
    markUnavailable(onWarn);
    return null;
  }
}

export async function deleteGameMemory(gameId) {
  if (!gameId) return;
  memoryFallback.delete(gameId);
  if (idbUnavailable || typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(gameId);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export function isMemoryStoreDegraded() {
  return idbUnavailable || typeof indexedDB === "undefined";
}
