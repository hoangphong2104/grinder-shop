-- =============================================================================
-- Kho Cối — 006_note_history.sql: CR-007 — lịch sử ghi chú (xem bản cũ, khôi phục, lấy lại ghi chú đã xoá).
-- Migration CỘNG THÊM, chạy lại được, 1 transaction. Không đổi dữ liệu có sẵn.
--   * note_revisions   bản cũ của ghi chú (action 'edit' = trước khi sửa, 'delete' = lúc xoá), 50 bản mới nhất / ghi chú
--   * trigger notes_keep_revision  AFTER UPDATE (chỉ khi body đổi) / DELETE trên notes
-- =============================================================================
begin;
-- CR-007 Lịch sử ghi chú: mỗi lần SỬA nội dung (body đổi) hoặc XOÁ ghi chú ⇒ trigger lưu bản cũ vào note_revisions
-- (giữ 50 bản mới nhất / ghi chú). Client chỉ đọc + xoá (khôi phục = ghi lại notes bằng body cũ — bản đang có cũng thành 1 bản lịch sử).
-- Không FK tới notes: ghi chú đã xoá vẫn còn lịch sử để khôi phục.
create table if not exists public.note_revisions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  note_id     uuid not null,
  body        text not null,
  color       text not null default 'default',
  is_pinned   boolean not null default false,
  action      text not null check (action in ('edit','delete')),
  created_at  timestamptz not null default pg_catalog.clock_timestamp()
);
create index if not exists note_revisions_note_idx on public.note_revisions (note_id, created_at desc);
create index if not exists note_revisions_user_idx on public.note_revisions (user_id, action, created_at desc);

create or replace function private.note_keep_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.body is not distinct from new.body then
    return null;
  end if;
  insert into public.note_revisions (user_id, note_id, body, color, is_pinned, action)
  values (old.user_id, old.id, old.body, old.color, old.is_pinned, case when tg_op = 'DELETE' then 'delete' else 'edit' end);
  delete from public.note_revisions r
   where r.id in (select x.id from public.note_revisions x where x.note_id = old.id order by x.created_at desc offset 50);
  return null;
end $$;
revoke execute on function private.note_keep_revision() from public, anon, authenticated;
drop trigger if exists notes_keep_revision on public.notes;
create trigger notes_keep_revision after update or delete on public.notes
  for each row execute function private.note_keep_revision();

revoke all on public.note_revisions from anon, authenticated;
grant select, delete on public.note_revisions to authenticated;
alter table public.note_revisions enable row level security;
drop policy if exists note_revisions_owner on public.note_revisions;
create policy note_revisions_owner on public.note_revisions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
commit;
notify pgrst, 'reload schema';
