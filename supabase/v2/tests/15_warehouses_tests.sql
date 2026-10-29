-- Test CR-008 (007_warehouses.sql): danh bạ kho. Chạy trên DB đã có 007 (cài mới 001, hoặc DB thật mô phỏng + 007).
-- Dùng user thử 8 + 9 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('88888888-8888-8888-8888-888888888888', 'u8@test.local'),
                                         ('99999999-9999-9999-9999-999999999999', 'u9@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', false);

insert into public.warehouses (name, phone, address) values ('Kho VN Hà Nội', '0901234567', '12 Ngõ Huế') returning id as w1 \gset
select t.eq((select user_id::text || '/' || version from public.warehouses where id = :'w1'),
            '88888888-8888-8888-8888-888888888888/1', 'CR-008: thêm kho - user_id tự gán, version 1');
update public.warehouses set phone = '0907654321', note = 'Gọi trước 17h' where id = :'w1';
select t.eq((select phone || '/' || note || '/' || version from public.warehouses where id = :'w1'),
            '0907654321/Gọi trước 17h/2', 'CR-008: sửa kho - version tăng');
select t.err('insert into public.warehouses (name) values (''  '')', '23514', 'CR-008: tên kho không được trống');
select t.err(format('update public.warehouses set version = 99 where id = %L', :'w1'), '42501', 'CR-008: client không sửa version');
select t.err(format('insert into public.warehouses (user_id, name) values (%L, %L)', '99999999-9999-9999-9999-999999999999', 'Giả'),
             '42501', 'CR-008: client không ghi kho cho người khác');
-- Người khác không thấy / không sửa / không xoá
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', false);
select t.eq((select count(*)::int from public.warehouses), 0, 'CR-008: RLS - người khác không thấy kho');
update public.warehouses set name = 'Hack' where id = :'w1';
delete from public.warehouses where id = :'w1';
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', false);
select t.eq((select name from public.warehouses where id = :'w1'), 'Kho VN Hà Nội', 'CR-008: RLS - người khác không sửa / xoá được');
delete from public.warehouses where id = :'w1';
select t.eq((select count(*)::int from public.warehouses where id = :'w1'), 0, 'CR-008: xoá kho');
reset role;
select t.eq((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'warehouses'), 1,
            'CR-008: warehouses có realtime');
