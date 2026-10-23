-- Dữ liệu v1 mẫu (chạy SAU migrations/001_init.sql + 002_realtime.sql) — chứng minh reset chạy được trên DB v1 có dữ liệu.
\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

select public.bootstrap_user();
insert into public.variants (model_id, name, list_price_vnd)
  select id, 'Đen', 5000000 from public.models where name = 'ZP6 Special';
select public.save_lot(null,
  jsonb_build_object('exchange_rate', 3600, 'goofish_url', 'https://www.goofish.com/item?id=123456789'),
  jsonb_build_array(jsonb_build_object('variant_id', (select id from public.variants where name = 'Đen'),
                                       'qty', 2, 'price_cny', 1010)));
select public.receive_lot((select id from public.lots limit 1), 600000);
insert into public.customers (fb_name) values ('Khách v1');
select public.save_order(null,
  jsonb_build_object('customer_id', (select id from public.customers limit 1)),
  jsonb_build_array(jsonb_build_object('variant_id', (select id from public.variants where name = 'Đen'),
                                       'qty', 1, 'unit_price_vnd', 5000000)));
select public.ship_order((select id from public.orders limit 1));
insert into public.intermediary_txns (kind, amount_vnd, note) values ('transfer', 5000000, 'v1');
insert into public.payments (order_id, kind, amount_vnd) select id, 'deposit', 1000000 from public.orders;
reset role;
insert into storage.objects (bucket_id, name, owner)
  values ('private-images', '11111111-1111-1111-1111-111111111111/goofish/a.jpg', '11111111-1111-1111-1111-111111111111');

select 'v1_seed' as step,
       (select count(*) from public.variants) as variants,
       (select count(*) from public.lot_lines) as lot_lines,
       (select count(*) from public.stock_movements) as movements,
       (select on_hand_qty from public.variants) as on_hand,
       (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') as realtime_tables,
       (select count(*) from pg_policies where schemaname = 'storage') as storage_policies;
