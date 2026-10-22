// 端末内の保存。小さい設定は localStorage、トーク履歴・学習記録・回答履歴・暗号鍵は IndexedDB
export const LS = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("talk-eisaku", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    });
  },
  run(mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", mode);
      const q = fn(tx.objectStore("kv"));
      tx.oncomplete = () => res(q && q.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
};
export const Store = {
  ok: false,
  mem: new Map(), // IndexedDB が使えないときの退避先（暗号鍵など JSON にできないもの用）
  async init() { try { await IDB.open(); this.ok = true; } catch { console.warn("IndexedDB unavailable"); } },
  async get(k) {
    if (this.ok) { try { return await IDB.run("readonly", s => s.get(k)); } catch {} }
    return this.mem.has(k) ? this.mem.get(k) : LS.get("tk.kv." + k);
  },
  async set(k, v) {
    if (this.ok) { try { await IDB.run("readwrite", s => s.put(v, k)); return true; } catch {} }
    this.mem.set(k, v);
    try { return LS.set("tk.kv." + k, v); } catch { return false; }
  },
  async del(k) {
    if (this.ok) { try { await IDB.run("readwrite", s => s.delete(k)); } catch {} }
    this.mem.delete(k); LS.del("tk.kv." + k);
  }
};
