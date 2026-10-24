-- Test CR-007 (006_note_history.sql): lịch sử ghi chú. Chạy trên DB đã có 006 (cài mới 001, hoặc DB thật mô phỏng + 006).
-- Dùng user thử 6 + 7 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'u6@test.local'),
                                         ('77777777-7777-7777-7777-777777777777', 'u7@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);

insert into public.notes (body, color) values ('Bản 1', 'yellow') returning id as n1 \gset
select t.eq((select count(*)::int from public.note_revisions where note_id = :'n1'), 0, 'CR-007: ghi chú mới chưa có lịch sử');
update public.notes set body = 'Bản 2' where id = :'n1';
update public.notes set body = 'Bản 3' where id = :'n1';
select t.eq((select string_agg(body || '/' || action, ',' order by created_at) from public.note_revisions where note_id = :'n1'),
            'Bản 1/edit,Bản 2/edit', 'CR-007: mỗi lần sửa nội dung lưu bản cũ (edit)');
update public.notes set is_pinned = true, color = 'green' where id = :'n1';
select t.eq((select count(*)::int from public.note_revisions where note_id = :'n1'), 2, 'CR-007: chỉ ghim / đổi màu thì không lưu lịch sử');
update public.notes set body = 'Bản 3' where id = :'n1';
select t.eq((select count(*)::int from public.note_revisions where note_id = :'n1'), 2, 'CR-007: lưu lại y nguyên nội dung thì không lưu lịch sử');
delete from public.notes where id = :'n1';
select t.eq((select body || '/' || action || '/' || color || '/' || is_pinned from public.note_revisions where note_id = :'n1' order by created_at desc limit 1),
            'Bản 3/delete/green/true', 'CR-007: xoá ghi chú lưu bản cuối (delete) kèm màu + ghim');
-- Khôi phục ghi chú đã xoá = thêm ghi chú mới từ bản lịch sử rồi xoá bản 'delete'
insert into public.notes (body, color, is_pinned) select body, color, is_pinned from public.note_revisions where note_id = :'n1' and action = 'delete' returning id as n1b \gset
delete from public.note_revisions where note_id = :'n1' and action = 'delete';
select t.eq((select body from public.notes where id = :'n1b'), 'Bản 3', 'CR-007: khôi phục ghi chú đã xoá');
select t.err(format('insert into public.note_revisions (user_id, note_id, body, action) values (%L, %L, %L, %L)',
             '66666666-6666-6666-6666-666666666666', :'n1', 'giả', 'edit'), '42501', 'CR-007: client không tự ghi lịch sử');
select t.err(format('update public.note_revisions set body = %L where note_id = %L', 'sửa', :'n1'), '42501', 'CR-007: client không sửa lịch sử');
-- Giữ 50 bản mới nhất
do $$ begin for i in 1..55 loop update public.notes set body = 'v' || i where body is not null and id = (select id from public.notes where body like 'Bản 3' or body like 'v%' order by created_at desc limit 1); end loop; end $$;
select t.eq((select count(*)::int from public.note_revisions where note_id = :'n1b'), 50, 'CR-007: giữ tối đa 50 bản / ghi chú');
select t.eq((select body from public.note_revisions where note_id = :'n1b' order by created_at desc limit 1), 'v54', 'CR-007: bản mới nhất là bản ngay trước lần sửa cuối');
-- Người khác không thấy
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', false);
select t.eq((select count(*)::int from public.note_revisions), 0, 'CR-007: RLS - người khác không thấy lịch sử');
delete from public.note_revisions;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);
select t.eq((select count(*)::int from public.note_revisions where note_id = :'n1b'), 50, 'CR-007: RLS - người khác không xoá được lịch sử');
reset role;
