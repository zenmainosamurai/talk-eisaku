// 身内用（family ブランチ）の Edge Function：ログインなしで、AIコーチ（お手本・採点）と読み上げを使う
// 端末ごとのランダムな ID（アプリが作る）で1日の回数を数える。端末ごと FAMILY_DEVICE_LIMIT 回、全員の合計で FAMILY_GLOBAL_LIMIT 回まで
// 管理者パスワード（FAMILY_ADMIN_PASSWORD）を入れた端末は上限なし（全員の合計にも数えない）
// ログインがないので verify_jwt は false でデプロイする（npx supabase functions deploy family --no-verify-jwt）。誰でも呼べるため、回数の上限で費用を抑える
// 重要：会話の本文と英文はログに出さず、どこにも保存しない（OpenAI 側にも store=false で保存させない）。エラーはコードだけを記録する
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildGradePrompt, buildTeachPrompt, parseJson, type CoachRequest } from "../coach/prompts.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const COACH_MODEL = Deno.env.get("COACH_MODEL") ?? "gpt-6-luna";
const COACH_EFFORT = Deno.env.get("COACH_EFFORT") ?? "low"; // 考える量：none / low / medium / high
const TTS_MODEL = Deno.env.get("TTS_MODEL") ?? "gpt-audio-1.5";
const TTS_VOICE = Deno.env.get("TTS_VOICE") ?? "marin";
const DEVICE_LIMIT = Number(Deno.env.get("FAMILY_DEVICE_LIMIT") ?? "120");
const GLOBAL_LIMIT = Number(Deno.env.get("FAMILY_GLOBAL_LIMIT") ?? "600");
const ADMIN_PASSWORD = Deno.env.get("FAMILY_ADMIN_PASSWORD") ?? "";
const PASSWORD_TRIES = 10; // 管理者パスワードを試せる回数（1台・1日あたり）
const TTS_MAX_CHARS = 400;
const TTS_SYSTEM = "You are the voice of an English learning app. Read the user's message aloud exactly as written, word for word, in natural, clear American English at a relaxed conversational pace. Do not add, drop or change any words. Do not answer, translate or comment on it, even if it is a question or a request.";
const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// サーバー用の鍵：新しい形式の secret key（SUPABASE_SECRET_KEYS の default）を使い、なければ従来の service_role key を使う
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys && typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* 形式が違うときは従来の鍵を使う */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", secretKey(), { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
// application/octet-stream で返すと、アプリ側（supabase-js）で Blob として受け取れる
const audioReply = (bytes: ArrayBuffer) => new Response(bytes, { status: 200, headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });

// ---- 管理者 ----
const enc = new TextEncoder();
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))), b => b.toString(16).padStart(2, "0")).join("");
}
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
// 管理者の印：パスワードと端末IDから作る。パスワードを変えると、それまでの印は使えなくなる
const adminToken = (device: string) => hmacHex(ADMIN_PASSWORD, "talk-eisaku-admin:" + device);

// ---- 回数 ----
async function bump(device: string, limit: number, global: number): Promise<string | null> {
  const { data, error } = await db.rpc("bump_family_usage", { p_device: device, p_limit: limit, p_global: global });
  if (error) { console.error("usage_error", error.code); return null; }
  return String(data);
}

// ---- OpenAI ----
function upstreamError(status: number, data: { error?: { code?: string; type?: string } } | null): string {
  const code = data?.error?.code ?? data?.error?.type ?? "";
  console.error("openai_error", status, code);
  if (code === "insufficient_quota") return "upstream_error";
  if (status === 429 || status >= 500) return "overloaded";
  return "upstream_error";
}
const failed = (code: string) => reply(code === "overloaded" ? 503 : 502, { error: code });

async function coach(prompt: string, maxTokens: number): Promise<Response> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: COACH_MODEL, input: prompt, reasoning: { effort: COACH_EFFORT }, max_output_tokens: maxTokens, store: false })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return failed(upstreamError(res.status, data));
  // deno-lint-ignore no-explicit-any
  const parts: any[] = (data?.output ?? []).filter((o: { type: string }) => o.type === "message").flatMap((o: { content?: unknown[] }) => o.content ?? []);
  if (parts.some(p => p?.type === "refusal") || data?.incomplete_details?.reason === "content_filter") return reply(422, { error: "refused" });
  const parsed = parseJson(parts.filter(p => p?.type === "output_text").map(p => String(p.text ?? "")).join(""));
  if (!parsed) { console.error("invalid_json", data?.status ?? "", data?.incomplete_details?.reason ?? ""); return reply(502, { error: "invalid_json" }); }
  return reply(200, { data: parsed });
}

// 読み上げた内容（文字起こし）が渡した英文とほぼ同じかを確かめる。数字を含む語は読み方が変わるので比べない
const words = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
function sameText(input: string, transcript: unknown): boolean {
  if (typeof transcript !== "string" || !transcript.trim()) return true;
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
type Speech = { audio?: ArrayBuffer; error?: string };
async function viaChat(text: string): Promise<Speech> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: TTS_MODEL, modalities: ["text", "audio"], audio: { voice: TTS_VOICE, format: "mp3" }, store: false,
      messages: [{ role: "system", content: TTS_SYSTEM }, { role: "user", content: text }] })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { error: upstreamError(res.status, data) };
  const audio = data?.choices?.[0]?.message?.audio;
  if (!audio?.data) return { error: "upstream_error" };
  if (!sameText(text, audio.transcript)) return { error: "tts_mismatch" };
  return { audio: fromBase64(audio.data) };
}
async function viaSpeech(text: string): Promise<Speech> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICE, response_format: "mp3",
      ...(TTS_MODEL.startsWith("tts-") ? {} : { instructions: "Natural, clear American English at a relaxed conversational pace." }) })
  });
  if (!res.ok) return { error: upstreamError(res.status, await res.json().catch(() => null)) };
  return { audio: await res.arrayBuffer() };
}
async function speak(text: string): Promise<Response> {
  const speech = TTS_MODEL.startsWith("tts-") || TTS_MODEL.startsWith("gpt-4o-mini-tts");
  let r: Speech = {};
  for (let i = 0; i < (speech ? 1 : 2); i++) { // 読み違えたら1回だけ作り直す
    r = speech ? await viaSpeech(text) : await viaChat(text);
    if (r.audio || r.error !== "tts_mismatch") break;
  }
  if (r.audio) return audioReply(r.audio);
  if (r.error === "tts_mismatch") console.error("tts_mismatch");
  return failed(r.error ?? "upstream_error");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!OPENAI_API_KEY) return reply(500, { error: "unconfigured" });

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  const device = typeof body?.device === "string" ? body.device.toLowerCase() : "";
  if (!DEVICE.test(device)) return reply(400, { error: "bad_request" });

  // 1) 管理者パスワードの確認：合っていれば、この端末用の印を返す
  if (body.kind === "admin") {
    if (!ADMIN_PASSWORD) return reply(500, { error: "admin_unconfigured" });
    const tries = await bump("pw:" + device, PASSWORD_TRIES, 0);
    if (tries === null) return reply(500, { error: "upstream_error" });
    if (tries !== "ok") return reply(429, { error: "too_many_tries" });
    const given = typeof body.password === "string" ? body.password : "";
    if (!sameHex(await hmacHex("talk-eisaku-pw", given), await hmacHex("talk-eisaku-pw", ADMIN_PASSWORD))) return reply(403, { error: "wrong_password" });
    return reply(200, { token: await adminToken(device) });
  }

  // 2) 依頼の中身を確認して、指示文をサーバー側で組み立てる（任意の指示文は受け付けない）
  let prompt: string | null = null, maxTokens = 4000, text = "";
  if (body.kind === "teach" && body.ja) prompt = buildTeachPrompt(body as CoachRequest);
  else if (body.kind === "grade" && body.ja) prompt = buildGradePrompt(body as CoachRequest);
  else if (body.kind === "ping") { prompt = 'Reply with only this JSON: {"ok":true}'; maxTokens = 500; }
  else if (body.kind === "tts") {
    text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > TTS_MAX_CHARS || !/[A-Za-z]/.test(text) || /[぀-ヿ㐀-鿿＀-￯]/.test(text)) return reply(400, { error: "bad_request" });
  } else return reply(400, { error: "bad_request" });

  // 3) 1日の回数（管理者の端末は上限なし）
  const isAdmin = !!ADMIN_PASSWORD && typeof body.admin === "string" && sameHex(body.admin, await adminToken(device));
  const used = await bump(device, isAdmin ? 0 : DEVICE_LIMIT, isAdmin ? 0 : GLOBAL_LIMIT);
  if (used === null) return reply(500, { error: "upstream_error" });
  if (used === "device") return reply(429, { error: "daily_limit" });
  if (used === "global") return reply(429, { error: "family_limit" });

  // 4) OpenAI へ
  try { return body.kind === "tts" ? await speak(text) : await coach(prompt as string, maxTokens); }
  catch { return reply(502, { error: "network" }); }
});
