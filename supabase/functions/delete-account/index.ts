// アカウントの削除：ログイン中の本人のアカウントを、サーバーからすべて消す
// auth.users の行を消すと、vault_keys・vault_items・subscriptions・usage_daily の行も on delete cascade で一緒に消える
// 重要：エラーは種類だけを記録する
import { createClient } from "npm:@supabase/supabase-js@2";

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

  // 1) ログインの確認。消せるのは、トークンの持ち主のアカウントだけ
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return reply(401, { error: "not_signed_in" });

  // 2) アカウントを消す（論理削除ではなく、行そのものを消す）
  const { error } = await admin.auth.admin.deleteUser(user.id, false);
  if (error) {
    console.error("delete_user_error", error.status ?? "");
    return reply(500, { error: "upstream_error" });
  }
  return reply(200, { ok: true });
});
