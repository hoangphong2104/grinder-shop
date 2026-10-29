-- =============================================================================
-- Kho Cối — 007_warehouses.sql: CR-008 — danh bạ kho (tab Kho dưới Khách: tên, SĐT, địa chỉ, ghi chú).
-- Migration CỘNG THÊM, chạy lại được, 1 transaction. Không đổi dữ liệu có sẵn.
--   * warehouses   bảng mới, client ghi trực tiếp (RLS theo user), trigger touch_row, realtime
-- =============================================================================
begin;
-- CR-008 Danh bạ kho (tab Kho dưới Khách): tên kho, SĐT, địa chỉ, ghi chú — client ghi trực tiếp (như customers),
-- RLS theo user, khoá lạc quan version (touch_row), có realtime.
create table if not exists public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  phone       text check (length(phone) <= 30),
  address     text check (length(address) <= 500),
  note        text check (length(note) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1
);
create index if not exists warehouses_user_name_idx on public.warehouses (user_id, lower(name));
drop trigger if exists warehouses_touch on public.warehouses;
create trigger warehouses_touch before insert or update on public.warehouses
  for each row execute function private.touch_row();

revoke all on public.warehouses from anon, authenticated;
grant select, delete on public.warehouses to authenticated;
grant insert (name, phone, address, note) on public.warehouses to authenticated;
grant update (name, phone, address, note) on public.warehouses to authenticated;
alter table public.warehouses enable row level security;
drop policy if exists warehouses_owner on public.warehouses;
create policy warehouses_owner on public.warehouses for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'warehouses') then
    alter publication supabase_realtime add table public.warehouses;
  end if;
end $$;
commit;
notify pgrst, 'reload schema';
