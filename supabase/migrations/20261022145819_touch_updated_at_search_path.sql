-- touch_updated_at の search_path を固定する（Supabase のセキュリティ診断の指摘）
alter function public.touch_updated_at() set search_path = '';
