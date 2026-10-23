// 身内用（family ブランチ）：ログインせずに、Edge Function（family）で AIコーチと読み上げを使う
// 学習記録とトーク履歴はこの端末の中だけに置き、サーバーには送らない
// サーバーに送るのは、AIへの依頼（問題文・回答・前後のやり取りなど）と読み上げる英文、端末ごとのランダムな ID、管理者の印だけ
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { LS } from "./store.js";

const DEVICE_KEY = "tk.device.v1", ADMIN_KEY = "tk.admin.v1";
// 端末ごとのランダムな ID（1日の利用回数を数えるためだけに使う）
function newDeviceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const Cloud = {
  sb: null,
  configured() { return !!(SUPABASE_URL && SUPABASE_ANON_KEY); },
  init() {
    if (this.configured()) this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  },
  device() {
    let d = LS.get(DEVICE_KEY);
    if (typeof d !== "string" || !d) { d = newDeviceId(); LS.set(DEVICE_KEY, d); }
    return d;
  },
  // 管理者パスワードを入れた端末か（上限なしで使える）
  isAdmin() { return !!LS.get(ADMIN_KEY); },

  async call(body) {
    if (!this.sb) throw { code: "unconfigured" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw { code: "offline" };
    const admin = LS.get(ADMIN_KEY);
    return this.sb.functions.invoke("family", { body: { ...body, device: this.device(), ...(admin ? { admin } : {}) } });
  },

  // ---- AIコーチ ----
  async coach(body) {
    const { data, error } = await this.call(body);
    if (error) throw { code: await errorCode(error) };
    if (!data || !data.data) throw { code: "invalid_json" };
    return data.data;
  },

  // ---- 読み上げ：英文を OpenAI で音声（mp3）にして、ArrayBuffer で返す ----
  async tts(text) {
    const { data, error } = await this.call({ kind: "tts", text });
    if (error) throw { code: await errorCode(error) };
    if (!(data instanceof Blob) || !data.size) throw { code: "upstream_error" };
    return await data.arrayBuffer();
  },

  // ---- 管理者：パスワードが合えば、この端末用の印を保存する ----
  async adminLogin(password) {
    const { data, error } = await this.call({ kind: "admin", password });
    if (error) throw { code: await errorCode(error) };
    if (!data || typeof data.token !== "string") throw { code: "upstream_error" };
    LS.set(ADMIN_KEY, data.token);
  },
  adminLogout() { LS.del(ADMIN_KEY); }
};

// Edge Function のエラーから、サーバーが返したコードを取り出す
async function errorCode(error) {
  try { if (error.context && typeof error.context.json === "function") return (await error.context.json()).error || "upstream_error"; } catch {}
  return "network";
}
