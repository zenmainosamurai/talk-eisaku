// AIコーチ：アプリからの依頼を受け、ログイン・サブスク・1日の上限を確かめてから Claude API に中継する
// 重要：会話の本文（発言・回答・文脈）はログに出さず、どこにも保存しない。エラーはコードだけを記録する
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildGradePrompt, buildTeachPrompt, parseJson, type CoachRequest } from "./prompts.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("COACH_MODEL") ?? "claude-haiku-5-5";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "300");
const REQUIRE_SUBSCRIPTION = (Deno.env.get("REQUIRE_SUBSCRIPTION") ?? "false") === "true";
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!ANTHROPIC_API_KEY) return reply(500, { error: "unconfigured" });

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
  let prompt: string | null = null, maxTokens = 2000;
  if (body?.kind === "teach" && body.ja) prompt = buildTeachPrompt(body);
  else if (body?.kind === "grade" && body.ja) prompt = buildGradePrompt(body);
  else if (body?.kind === "ping") { prompt = 'Reply with only this JSON: {"ok":true}'; maxTokens = 200; }
  if (!prompt) return reply(400, { error: "bad_request" });

  // 4) 1日の上限
  const { data: allowed, error: usageError } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: DAILY_LIMIT });
  if (usageError) { console.error("usage_error", usageError.code); return reply(500, { error: "upstream_error" }); }
  if (!allowed) return reply(429, { error: "daily_limit" });

  // 5) Claude API へ中継
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] })
    });
  } catch {
    return reply(502, { error: "network" });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const type = data?.error?.type ?? "";
    console.error("anthropic_error", res.status, type);
    if (res.status === 429 || res.status === 529 || type === "overloaded_error") return reply(503, { error: "overloaded" });
    return reply(502, { error: "upstream_error" });
  }
  if (data?.stop_reason === "refusal") return reply(422, { error: "refused" });
  const text = (data?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const parsed = parseJson(text);
  if (!parsed) return reply(502, { error: "invalid_json" });
  return reply(200, { data: parsed });
});
