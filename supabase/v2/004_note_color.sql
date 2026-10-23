-- 004 — Màu thẻ ghi chú (kiểu Google Keep). Cộng thêm, chạy lại được, 1 transaction.
begin;
alter table public.notes
  add column if not exists color text not null default 'default'
    check (color in ('default','yellow','green','blue','pink','purple'));
grant insert (color) on public.notes to authenticated;
grant update (color) on public.notes to authenticated;
commit;
notify pgrst, 'reload schema';
