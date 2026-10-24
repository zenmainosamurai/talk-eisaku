// 読み上げ：アプリから英文を受け取り、ログイン・サブスク・1日の上限を確かめてから Google Cloud Text-to-Speech で音声にして返す
// 声は Chirp 3: HD（GOOGLE_TTS_VOICE。既定は en-US-Chirp3-HD-Aoede）。声を変えたら、アプリの TTS_VOICE（src/main.js）も変える
// 重要：英文はログに出さず、どこにも保存しない。エラーはコードだけを記録する
// 作った音声はアプリが端末の中に保存して使い回す（サーバーには残さない）
import { createClient } from "npm:@supabase/supabase-js@2";

const GOOGLE_TTS_API_KEY = Deno.env.get("GOOGLE_TTS_API_KEY") ?? "";
const GOOGLE_VOICE = Deno.env.get("GOOGLE_TTS_VOICE") ?? "en-US-Chirp3-HD-Aoede";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "300");
const REQUIRE_SUBSCRIPTION = (Deno.env.get("REQUIRE_SUBSCRIPTION") ?? "false") === "true";
const MAX_CHARS = 400;

// サーバー用の鍵：新しい形式の secret key（SUPABASE_SECRET_KEYS の default）を使い、なければ従来の service_role key を使う
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys && typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* 形式が違うときは従来の鍵を使う */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", secretKey(), { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
// application/octet-stream で返すと、アプリ側（supabase-js）で Blob として受け取れる
const audioReply = (bytes: ArrayBuffer) => new Response(bytes, { status: 200, headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

type Result = { audio?: ArrayBuffer; error?: string };
// Google Cloud Text-to-Speech：渡した英文をそのまま読む
async function viaGoogle(text: string): Promise<Result> {
  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_TTS_API_KEY },
    body: JSON.stringify({ input: { text }, voice: { languageCode: GOOGLE_VOICE.split("-").slice(0, 2).join("-"), name: GOOGLE_VOICE }, audioConfig: { audioEncoding: "MP3" } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("google_error", res.status, data?.error?.status ?? "");
    return { error: res.status === 429 || res.status >= 500 ? "overloaded" : "upstream_error" };
  }
  if (!data?.audioContent) return { error: "upstream_error" };
  return { audio: fromBase64(data.audioContent) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!GOOGLE_TTS_API_KEY) return reply(500, { error: "unconfigured" });

  // 1) ログインの確認
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return reply(401, { error: "not_signed_in" });

  // 2) サブスクの確認（RevenueCat の連携ができるまでは REQUIRE_SUBSCRIPTION=false のまま）
  if (REQUIRE_SUBSCRIPTION) {
    const { data: sub } = await admin.from("subscriptions").select("active_until").eq("user_id", user.id).maybeSingle();
    if (!sub?.active_until || new Date(sub.active_until) < new Date()) return reply(402, { error: "no_subscription" });
  }

  // 3) 英文の確認（英語の短い文だけを受け付ける）
  let body: { text?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_CHARS || !/[A-Za-z]/.test(text) || /[぀-ヿ㐀-鿿＀-￯]/.test(text)) return reply(400, { error: "bad_request" });

  // 4) 1日の上限（AIコーチと同じ回数に数える）
  const { data: allowed, error: usageError } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: DAILY_LIMIT });
  if (usageError) { console.error("usage_error", usageError.code); return reply(500, { error: "upstream_error" }); }
  if (!allowed) return reply(429, { error: "daily_limit" });

  // 5) Google で音声にする
  let r: Result;
  try { r = await viaGoogle(text); } catch { return reply(502, { error: "network" }); }
  if (r.audio) return audioReply(r.audio);
  return reply(r.error === "overloaded" ? 503 : 502, { error: r.error ?? "upstream_error" });
});
