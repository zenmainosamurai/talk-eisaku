-- トーク英作：初期スキーマ
-- サーバーには暗号化済みの学習記録だけを置く。トーク履歴・会話の本文は置かない

-- 保管庫の鍵：復元キーで包んだマスター鍵（運営者は開けない）
create table public.vault_keys (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  wrapped    text not null,
  salt       text not null,
  iterations integer not null check (iterations >= 100000),
  created_at timestamptz not null default now()
);

-- 暗号化した学習記録。item_id は端末の鍵で作ったハッシュで、元の問題IDとは照合できない
create table public.vault_items (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('card', 'log', 'meta')),
  item_id    text not null check (char_length(item_id) <= 64),
  blob       text not null check (char_length(blob) <= 2000000),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);
create index vault_items_user_updated on public.vault_items (user_id, updated_at);

-- 更新日時はサーバーの時計で付ける（端末の時計がずれていても、差分の取得が狂わないように）
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger vault_items_touch before insert or update on public.vault_items
  for each row execute function public.touch_updated_at();

alter table public.vault_keys  enable row level security;
alter table public.vault_items enable row level security;
create policy "own vault key"   on public.vault_keys  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own vault items" on public.vault_items for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- サブスクの状態。RevenueCat の通知（webhook）から更新する予定。利用者は自分の行を読むだけ
create table public.subscriptions (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  active_until timestamptz,
  source       text,
  updated_at   timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "read own subscription" on public.subscriptions for select to authenticated using (auth.uid() = user_id);

-- 1日あたりのAI利用回数（日本時間で区切る）。利用者からは見えない
create table public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  calls   integer not null default 0,
  primary key (user_id, day)
);
alter table public.usage_daily enable row level security;

-- 利用回数を1増やし、上限以内なら true。Edge Function（service_role）だけが呼べる
create or replace function public.bump_usage(p_user uuid, p_limit integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.usage_daily (user_id, day, calls)
  values (p_user, (now() at time zone 'Asia/Tokyo')::date, 1)
  on conflict (user_id, day) do update set calls = public.usage_daily.calls + 1
  returning calls into n;
  return n <= p_limit;
end $$;
revoke execute on function public.bump_usage(uuid, integer) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, integer) to service_role;
