// Supabase の接続先。.env に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を書く（.env.example を参照）
const env = (import.meta && import.meta.env) || {};
const injected = (typeof window !== "undefined" && window.__TK_CONFIG) || {};
export const SUPABASE_URL = env.VITE_SUPABASE_URL || injected.url || "";
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || injected.anonKey || "";
// 利用規約とプライバシーポリシーのページ（.env に VITE_TERMS_URL と VITE_PRIVACY_URL を書く）。空のときはリンクにしない
export const TERMS_URL = env.VITE_TERMS_URL || injected.termsUrl || "";
export const PRIVACY_URL = env.VITE_PRIVACY_URL || injected.privacyUrl || "";
