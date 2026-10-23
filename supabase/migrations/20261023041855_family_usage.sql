-- 身内用（family ブランチ）：ログインなしで使うため、端末ごとのランダムな ID で1日の利用回数を数える（日本時間で区切る）
-- device_id が '*' の行は、全員の合計。'pw:<端末ID>' は管理者パスワードを試した回数。利用者からは見えない
create table public.family_usage (
  device_id text not null,
  day       date not null,
  calls     integer not null default 0,
  primary key (device_id, day)
);
alter table public.family_usage enable row level security;

-- 回数を1増やして、'ok'・'device'（端末の上限を超えた）・'global'（全員の上限を超えた）のどれかを返す
-- p_limit が 0 以下なら端末の上限なし、p_global が 0 以下なら全員の合計に数えない（管理者の端末）
-- その日の最初の利用のときに、30日より前の記録を消す。Edge Function（service_role）だけが呼べる
create or replace function public.bump_family_usage(p_device text, p_limit integer, p_global integer) returns text
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Tokyo')::date; n integer; g integer;
begin
  insert into public.family_usage (device_id, day, calls) values (p_device, d, 1)
  on conflict (device_id, day) do update set calls = public.family_usage.calls + 1
  returning calls into n;
  if p_limit > 0 and n > p_limit then return 'device'; end if;
  if p_global > 0 then
    insert into public.family_usage (device_id, day, calls) values ('*', d, 1)
    on conflict (device_id, day) do update set calls = public.family_usage.calls + 1
    returning calls into g;
    if g = 1 then delete from public.family_usage where day < d - 30; end if;
    if g > p_global then return 'global'; end if;
  end if;
  return 'ok';
end $$;
revoke execute on function public.bump_family_usage(text, integer, integer) from public, anon, authenticated;
grant execute on function public.bump_family_usage(text, integer, integer) to service_role;
