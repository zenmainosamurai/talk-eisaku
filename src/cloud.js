// Supabase との連携：ログイン、暗号化した学習記録の同期、AIコーチ（Edge Function）の呼び出し
// サーバーに送る学習記録は、必ずこの端末で暗号化してから送る。トーク履歴は送らない
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import * as V from "./vault.js";

const PAGE = 500, PUSH_CHUNK = 200;

export const Cloud = {
  sb: null, user: null, keys: null, vaultRecord: null, pendingSetup: null,
  // unconfigured | signedOut | checking | needsSetup | needsKey | ready
  status: "unconfigured",
  syncing: false, lastSyncAt: 0, syncError: null,
  sync$: { userId: null, lastPull: null, cards: new Set(), days: new Set(), meta: false },
  hooks: null, pushTimer: null,

  configured() { return !!(SUPABASE_URL && SUPABASE_ANON_KEY); },
  signedIn() { return !!this.user; },
  email() { return this.user ? this.user.email || "" : ""; },

  async init(hooks) {
    this.hooks = hooks;
    if (!this.configured()) { this.status = "unconfigured"; return; }
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    const saved = await hooks.store.get("sync");
    if (saved) Object.assign(this.sync$, { userId: saved.userId || null, lastPull: saved.lastPull || null, cards: new Set(saved.cards || []), days: new Set(saved.days || []), meta: !!saved.meta });
    this.sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") { this.user = null; this.keys = null; this.status = "signedOut"; this.hooks.changed(); }
      else if (event === "SIGNED_IN" && session && (!this.user || this.user.id !== session.user.id)) this.afterAuth(session);
    });
    const { data } = await this.sb.auth.getSession();
    await this.afterAuth(data.session);
  },

  // ---- ログイン（メールに届く6桁のコード） ----
  async sendCode(email) {
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw { code: error.status === 429 ? "rate_limited" : "auth_failed" };
  },
  async verifyCode(email, token) {
    const { data, error } = await this.sb.auth.verifyOtp({ email, token, type: "email" });
    if (error || !data.session) throw { code: "bad_code" };
    await this.afterAuth(data.session);
  },
  async signOut() {
    await this.flush();
    await this.sb.auth.signOut();
    await this.hooks.store.del("vaultKeys");
    this.user = null; this.keys = null; this.status = "signedOut"; this.hooks.changed();
  },

  async afterAuth(session) {
    if (!session) { this.user = null; this.status = "signedOut"; this.hooks.changed(); return; }
    this.user = session.user; this.status = "checking"; this.hooks.changed();
    // 別のアカウントでログインしたら、前の人の学習記録を混ぜない
    if (this.sync$.userId && this.sync$.userId !== this.user.id) {
      await this.hooks.resetLocalLearning();
      Object.assign(this.sync$, { lastPull: null, cards: new Set(), days: new Set(), meta: false });
      await this.hooks.store.del("vaultKeys");
    }
    this.sync$.userId = this.user.id; this.saveSyncState();
    const local = await this.hooks.store.get("vaultKeys");
    if (local && local.userId === this.user.id && local.enc && local.mac) {
      this.keys = { enc: local.enc, mac: local.mac };
      this.status = "ready"; this.hooks.changed();
      this.sync();
      return;
    }
    try {
      const { data, error } = await this.sb.from("vault_keys").select("wrapped, salt, iterations").eq("user_id", this.user.id).maybeSingle();
      if (error) throw error;
      this.vaultRecord = data || null;
      this.status = data ? "needsKey" : "needsSetup";
    } catch { this.status = "needsKey"; this.vaultRecord = null; this.syncError = "network"; }
    this.hooks.changed();
  },

  // ---- 保管庫（復元キー） ----
  async beginSetup() {
    const recovery = V.newRecoveryKey();
    const made = await V.createVault(recovery);
    this.pendingSetup = { recovery, ...made };
    return recovery;
  },
  async finishSetup() {
    const p = this.pendingSetup;
    if (!p) throw { code: "no_setup" };
    const { error } = await this.sb.from("vault_keys").insert({ user_id: this.user.id, ...p.record });
    if (error) throw { code: "network" };
    this.pendingSetup = null;
    await this.useKeys(p.keys);
    this.markAll();
    this.sync();
  },
  async unlock(recoveryInput) {
    if (!this.vaultRecord) {
      const { data } = await this.sb.from("vault_keys").select("wrapped, salt, iterations").eq("user_id", this.user.id).maybeSingle();
      this.vaultRecord = data || null;
    }
    const keys = await V.openVault(recoveryInput, this.vaultRecord);
    if (!keys) throw { code: "wrong_key" };
    await this.useKeys(keys);
    this.markAll();
    await this.sync();
  },
  // 復元キーをなくしたとき：サーバー上の学習記録を消して作り直す（この端末の記録は残し、新しい鍵で送り直す）
  async resetVault() {
    await this.sb.from("vault_items").delete().eq("user_id", this.user.id);
    await this.sb.from("vault_keys").delete().eq("user_id", this.user.id);
    this.vaultRecord = null; this.sync$.lastPull = null; this.saveSyncState();
    this.status = "needsSetup"; this.hooks.changed();
  },
  async useKeys(keys) {
    this.keys = keys;
    await this.hooks.store.set("vaultKeys", { userId: this.user.id, enc: keys.enc, mac: keys.mac });
    this.status = "ready"; this.hooks.changed();
  },

  // ---- 同期 ----
  markCard(id) { this.sync$.cards.add(id); this.later(); },
  markDay(day) { this.sync$.days.add(day); this.later(); },
  markMeta() { this.sync$.meta = true; this.later(); },
  markAll() {
    for (const id of this.hooks.cardIds()) this.sync$.cards.add(id);
    for (const d of this.hooks.dayKeys()) this.sync$.days.add(d);
    this.sync$.meta = true; this.later(0);
  },
  later(ms = 2500) {
    this.saveSyncState();
    if (this.status !== "ready") return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push().catch(() => {}), ms);
  },
  saveSyncState() {
    const s = this.sync$;
    this.hooks.store.set("sync", { userId: s.userId, lastPull: s.lastPull, cards: [...s.cards], days: [...s.days], meta: s.meta });
  },
  async flush() { clearTimeout(this.pushTimer); if (this.status === "ready") await this.push().catch(() => {}); },
  async sync() {
    if (this.status !== "ready" || this.syncing) return;
    this.syncing = true;
    try { await this.pull(); await this.push(); this.lastSyncAt = Date.now(); this.syncError = null; }
    catch (e) { this.syncError = (e && e.code) || "network"; }
    finally { this.syncing = false; this.hooks.changed(true); }
  },
  async pull() {
    const out = { cards: [], days: [], meta: null };
    let since = this.sync$.lastPull, maxSeen = since;
    for (;;) {
      let q = this.sb.from("vault_items").select("kind, blob, updated_at").eq("user_id", this.user.id).order("updated_at", { ascending: true }).limit(PAGE);
      if (since) q = q.gt("updated_at", since);
      const { data, error } = await q;
      if (error) throw { code: "network" };
      for (const row of data) {
        try {
          const obj = await V.unseal(this.keys, row.blob);
          if (row.kind === "card") out.cards.push(obj);
          else if (row.kind === "log") out.days.push(obj);
          else if (row.kind === "meta") out.meta = obj;
        } catch { /* 復号できない行（古い鍵など）は無視 */ }
        maxSeen = row.updated_at;
      }
      if (data.length < PAGE) break;
      since = maxSeen;
    }
    if (out.cards.length || out.days.length || out.meta) this.hooks.mergeRemote(out);
    if (maxSeen) { this.sync$.lastPull = maxSeen; this.saveSyncState(); }
  },
  async push() {
    if (this.status !== "ready") return;
    const s = this.sync$, rows = [], done = { cards: [], days: [], meta: false };
    for (const id of s.cards) {
      const payload = this.hooks.cardPayload(id) || { id, deleted: true, u: Date.now() };
      rows.push({ user_id: this.user.id, kind: "card", item_id: await V.blindId(this.keys, "card", id), blob: await V.seal(this.keys, payload) });
      done.cards.push(id);
    }
    for (const day of s.days) {
      rows.push({ user_id: this.user.id, kind: "log", item_id: await V.blindId(this.keys, "log", day), blob: await V.seal(this.keys, { day, events: this.hooks.dayEvents(day) }) });
      done.days.push(day);
    }
    if (s.meta) {
      rows.push({ user_id: this.user.id, kind: "meta", item_id: await V.blindId(this.keys, "meta", "meta"), blob: await V.seal(this.keys, this.hooks.metaPayload()) });
      done.meta = true;
    }
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const { error } = await this.sb.from("vault_items").upsert(rows.slice(i, i + PUSH_CHUNK), { onConflict: "user_id,kind,item_id" });
      if (error) throw { code: "network" };
    }
    done.cards.forEach(id => s.cards.delete(id));
    done.days.forEach(d => s.days.delete(d));
    if (done.meta) s.meta = false;
    this.saveSyncState();
    if (rows.length) { this.lastSyncAt = Date.now(); this.hooks.changed(true); }
  },
  // アカウントの削除：Edge Function（delete-account）がサーバー上のアカウントと記録をすべて消す
  // 成功したら、この端末のログイン状態と同期の状態も消す（端末の学習データは main.js 側で消す）
  async deleteAccount() {
    if (!this.configured()) throw { code: "unconfigured" };
    if (!this.user) throw { code: "not_signed_in" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw { code: "offline" };
    clearTimeout(this.pushTimer);
    const { data, error } = await this.sb.functions.invoke("delete-account", { body: {} });
    if (error || !data || !data.ok) {
      let code = "network";
      try { if (error && error.context && typeof error.context.json === "function") code = (await error.context.json()).error || "upstream_error"; } catch {}
      throw { code };
    }
    try { await this.sb.auth.signOut({ scope: "local" }); } catch {}
    await this.hooks.store.del("vaultKeys");
    await this.hooks.store.del("sync");
    this.user = null; this.keys = null; this.vaultRecord = null; this.pendingSetup = null; this.syncError = null; this.lastSyncAt = 0;
    Object.assign(this.sync$, { userId: null, lastPull: null, cards: new Set(), days: new Set(), meta: false });
    this.status = "signedOut"; this.hooks.changed();
  },
  // 「学習記録を消去」：サーバー上の学習記録も消す（鍵はそのまま）
  async wipeRemote() {
    if (this.status !== "ready") return;
    await this.sb.from("vault_items").delete().eq("user_id", this.user.id);
    Object.assign(this.sync$, { lastPull: null, cards: new Set(), days: new Set(), meta: true });
    this.later(0);
  },

  // ---- AIコーチ ----
  async coach(body) {
    if (!this.configured()) throw { code: "unconfigured" };
    if (!this.user) throw { code: "not_signed_in" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw { code: "offline" };
    const { data, error } = await this.sb.functions.invoke("coach", { body });
    if (error) throw { code: await errorCode(error) };
    if (!data || !data.data) throw { code: "invalid_json" };
    return data.data;
  },

  // ---- 読み上げ：英文を OpenAI（engine が "google" なら Google）で音声（mp3）にして、ArrayBuffer で返す ----
  async tts(text, engine = "openai") {
    if (!this.configured()) throw { code: "unconfigured" };
    if (!this.user) throw { code: "not_signed_in" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw { code: "offline" };
    const { data, error } = await this.sb.functions.invoke("tts", { body: { text, engine } });
    if (error) throw { code: await errorCode(error) };
    if (!(data instanceof Blob) || !data.size) throw { code: "upstream_error" };
    return await data.arrayBuffer();
  }
};

// Edge Function のエラーから、サーバーが返したコードを取り出す
async function errorCode(error) {
  try { if (error.context && typeof error.context.json === "function") return (await error.context.json()).error || "upstream_error"; } catch {}
  return "network";
}
