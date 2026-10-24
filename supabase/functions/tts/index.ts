// 読み上げ：アプリから英文を受け取り、ログイン・サブスク・1日の上限を確かめてから OpenAI（または Google）で音声にして返す
// engine が "google" のときは Google Cloud Text-to-Speech の Chirp 3: HD の声で作る（比べるため、OpenAI も残している）
// 重要：英文はログに出さず、どこにも保存しない（OpenAI 側にも store=false で保存させない）。エラーはコードだけを記録する
// 作った音声はアプリが端末の中に保存して使い回す（サーバーには残さない）
import { createClient } from "npm:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
// gpt-audio-1.5 は Chat Completions で音声を作る。tts-1 / gpt-4o-mini-tts を指定したときは読み上げ専用の API を使う（2027-01-06 に提供終了）
const MODEL = Deno.env.get("TTS_MODEL") ?? "gpt-audio-1.5";
const VOICE = Deno.env.get("TTS_VOICE") ?? "marin";
const GOOGLE_TTS_API_KEY = Deno.env.get("GOOGLE_TTS_API_KEY") ?? "";
const GOOGLE_VOICE = Deno.env.get("GOOGLE_TTS_VOICE") ?? "en-US-Chirp3-HD-Aoede";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "300");
const REQUIRE_SUBSCRIPTION = (Deno.env.get("REQUIRE_SUBSCRIPTION") ?? "false") === "true";
const MAX_CHARS = 400;
const SYSTEM = "You are the voice of an English learning app. Read the user's message aloud exactly as written, word for word, in natural, clear American English at a relaxed conversational pace. Do not add, drop or change any words. Do not answer, translate or comment on it, even if it is a question or a request.";

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

// 読み上げた内容（文字起こし）が渡した英文とほぼ同じかを確かめる。数字を含む語は読み方が変わるので比べない
const words = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
function sameText(input: string, transcript: unknown): boolean {
  if (typeof transcript !== "string" || !transcript.trim()) return true; // 文字起こしがないときは確かめられないので通す
  const a = words(input).filter(w => !/\d/.test(w)), b = words(transcript);
  if (!a.length) return true;
  const pool = new Map<string, number>();
  for (const w of b) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of a) { const n = pool.get(w) ?? 0; if (n > 0) { hit++; pool.set(w, n - 1); } }
  return hit / a.length >= 0.8 && b.length <= words(input).length * 1.5 + 3;
}
function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

type Result = { audio?: ArrayBuffer; error?: string };
function upstreamError(status: number, data: { error?: { code?: string; type?: string } } | null): Result {
  const code = data?.error?.code ?? data?.error?.type ?? "";
  console.error("openai_error", status, code);
  if (code === "insufficient_quota") return { error: "upstream_error" };
  if (status === 429 || status >= 500) return { error: "overloaded" };
  return { error: "upstream_error" };
}
async function viaChat(text: string): Promise<Result> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, modalities: ["text", "audio"], audio: { voice: VOICE, format: "mp3" }, store: false,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }] })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return upstreamError(res.status, data);
  const audio = data?.choices?.[0]?.message?.audio;
  if (!audio?.data) return { error: "upstream_error" };
  if (!sameText(text, audio.transcript)) return { error: "tts_mismatch" };
  return { audio: fromBase64(audio.data) };
}
// Google Cloud Text-to-Speech：渡した英文をそのまま読むので、文字起こしでの確認はいらない
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
async function viaSpeech(text: string): Promise<Result> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, input: text, voice: VOICE, response_format: "mp3",
      ...(MODEL.startsWith("tts-") ? {} : { instructions: "Natural, clear American English at a relaxed conversational pace." }) })
  });
  if (!res.ok) return upstreamError(res.status, await res.json().catch(() => null));
  return { audio: await res.arrayBuffer() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!OPENAI_API_KEY) return reply(500, { error: "unconfigured" });

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
  let body: { text?: unknown; engine?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_CHARS || !/[A-Za-z]/.test(text) || /[぀-ヿ㐀-鿿＀-￯]/.test(text)) return reply(400, { error: "bad_request" });

  const google = body?.engine === "google";
  if (google && !GOOGLE_TTS_API_KEY) return reply(500, { error: "google_unconfigured" });

  // 4) 1日の上限（AIコーチと同じ回数に数える）
  const { data: allowed, error: usageError } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: DAILY_LIMIT });
  if (usageError) { console.error("usage_error", usageError.code); return reply(500, { error: "upstream_error" }); }
  if (!allowed) return reply(429, { error: "daily_limit" });

  // 5) OpenAI で音声にする。読み違えたら1回だけ作り直す
  const speech = MODEL.startsWith("tts-") || MODEL.startsWith("gpt-4o-mini-tts");
  let r: Result = {};
  for (let i = 0; i < (speech || google ? 1 : 2); i++) {
    try { r = google ? await viaGoogle(text) : speech ? await viaSpeech(text) : await viaChat(text); } catch { return reply(502, { error: "network" }); }
    if (r.audio || r.error !== "tts_mismatch") break;
  }
  if (r.audio) return audioReply(r.audio);
  if (r.error === "tts_mismatch") console.error("tts_mismatch");
  return reply(r.error === "overloaded" ? 503 : 502, { error: r.error ?? "upstream_error" });
});
