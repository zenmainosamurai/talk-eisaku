// 端末内の保存。小さい設定は localStorage、トーク履歴・学習記録・回答履歴・暗号鍵は IndexedDB
// 読み上げの音声は別の IndexedDB（talk-eisaku-audio）に入れ、古いものから消す
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

// 読み上げの音声（OpenAI で作った mp3）。端末の中だけに保存し、同じ英文はもう作らずに使い回す
const AUDIO_DB = "talk-eisaku-audio", AUDIO_MAX = 500;
const done = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const AudioCache = {
  db: null,
  async open() {
    if (!this.db) this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(AUDIO_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("audio", { keyPath: "key" }).createIndex("at", "at");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    });
    return this.db;
  },
  // 見つかれば ArrayBuffer、なければ null
  async get(key) {
    try { const db = await this.open(); const v = await done(db.transaction("audio").objectStore("audio").get(key)); return v ? v.buf : null; }
    catch { return null; }
  },
  async put(key, buf) {
    try {
      const db = await this.open();
      const s = db.transaction("audio", "readwrite").objectStore("audio");
      await done(s.put({ key, buf, at: Date.now() }));
      let over = (await done(s.count())) - AUDIO_MAX;
      if (over <= 0) return;
      const tx = db.transaction("audio", "readwrite"), cur = tx.objectStore("audio").index("at").openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c && over-- > 0) { c.delete(); c.continue(); } };
    } catch {}
  },
  async clear() {
    try { if (this.db) { this.db.close(); this.db = null; } await done(indexedDB.deleteDatabase(AUDIO_DB)); } catch {}
  }
};
