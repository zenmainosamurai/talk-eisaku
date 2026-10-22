// AIコーチ：アプリからの依頼を受け、ログイン・サブスク・1日の上限を確かめてから OpenAI API に中継する
// 重要：会話の本文（発言・回答・文脈）はログに出さず、どこにも保存しない（OpenAI 側にも store=false で保存させない）。エラーはコードだけを記録する
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildGradePrompt, buildTeachPrompt, parseJson, type CoachRequest } from "./prompts.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("COACH_MODEL") ?? "gpt-6-luna";
const EFFORT = Deno.env.get("COACH_EFFORT") ?? "low"; // 考える量：none / low / medium / high
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "300");
const REQUIRE_SUBSCRIPTION = (Deno.env.get("REQUIRE_SUBSCRIPTION") ?? "false") === "true";
// サーバー用の鍵：新しい形式の secret key（SUPABASE_SECRET_KEYS の default）を使い、なければ従来の service_role key を使う
// 従来の鍵（service_role）は 2026 年末までに廃止される予定
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

  // 3) 依頼の中身を確認して、指示文をサーバー側で組み立てる（任意の指示文は受け付けない）
  let body: CoachRequest;
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  let prompt: string | null = null, maxTokens = 4000; // 考える分の量も含む
  if (body?.kind === "teach" && body.ja) prompt = buildTeachPrompt(body);
  else if (body?.kind === "grade" && body.ja) prompt = buildGradePrompt(body);
  else if (body?.kind === "ping") { prompt = 'Reply with only this JSON: {"ok":true}'; maxTokens = 500; }
  if (!prompt) return reply(400, { error: "bad_request" });

  // 4) 1日の上限
  const { data: allowed, error: usageError } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: DAILY_LIMIT });
  if (usageError) { console.error("usage_error", usageError.code); return reply(500, { error: "upstream_error" }); }
  if (!allowed) return reply(429, { error: "daily_limit" });

  // 5) OpenAI API（Responses API）へ中継
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, input: prompt, reasoning: { effort: EFFORT }, max_output_tokens: maxTokens, store: false })
    });
  } catch {
    return reply(502, { error: "network" });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code ?? data?.error?.type ?? "";
    console.error("openai_error", res.status, code);
    if (code === "insufficient_quota") return reply(502, { error: "upstream_error" });
    if (res.status === 429 || res.status >= 500) return reply(503, { error: "overloaded" });
    return reply(502, { error: "upstream_error" });
  }
  // deno-lint-ignore no-explicit-any
  const parts: any[] = (data?.output ?? []).filter((o: { type: string }) => o.type === "message").flatMap((o: { content?: unknown[] }) => o.content ?? []);
  if (parts.some(p => p?.type === "refusal") || data?.incomplete_details?.reason === "content_filter") return reply(422, { error: "refused" });
  const text = parts.filter(p => p?.type === "output_text").map(p => String(p.text ?? "")).join("");
  const parsed = parseJson(text);
  if (!parsed) { console.error("invalid_json", data?.status ?? "", data?.incomplete_details?.reason ?? ""); return reply(502, { error: "invalid_json" }); }
  return reply(200, { data: parsed });
});
