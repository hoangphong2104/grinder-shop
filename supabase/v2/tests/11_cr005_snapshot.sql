-- Nâng cấp CR-005: chụp số liệu TRƯỚC khi chạy 005_cash_status_qr.sql.
-- DB này mô phỏng DB THẬT: v1 → 000 + fixtures/001_schema_v2_pre003.sql → dữ liệu (03) → 002 → (05) → 003 → (10) → 004.
-- Thêm (bằng RPC CŨ, khi còn mã trạng thái cũ) 2 lô 'cn_shipping' / 'at_forwarder' + 1 khoản Đã chuyển 0 ₫ để có đủ mọi
-- mã trạng thái cũ và trường hợp biên của backfill sổ quỹ.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
select t.ok(to_regclass('public.cash_entries') is null
            and not exists (select 1 from information_schema.columns where table_schema = 'public'
                              and table_name = 'settings' and column_name = 'bank_bin'),
            'nâng cấp 005: DB trước 005 chưa có sổ quỹ / cột VietQR (đúng bản đang chạy)');
select t.ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notes'
                      and column_name = 'color'), 'nâng cấp 005: DB đã có 004 (notes.color)');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.save_lot(null, '{"exchange_rate":3600,"status":"cn_shipping"}',
       jsonb_build_array(jsonb_build_object('model_id', (select id from public.models where code_prefix = 'ZP6'), 'qty', 1, 'price_cny', 500)));
select public.save_lot(null, '{"exchange_rate":3600,"status":"at_forwarder"}',
       jsonb_build_array(jsonb_build_object('model_id', (select id from public.models where code_prefix = 'KU'), 'qty', 1, 'price_cny', 600)));
insert into public.intermediary_txns (kind, amount_vnd, note) values ('transfer', 0, 'khoản 0 ₫ (không vào sổ quỹ)');
reset role;

select t.ok((select count(distinct status) from public.lots where status in ('ordered','cn_shipping','at_forwarder','vn_shipping')) = 4
            and exists (select 1 from public.lots where status = 'received') and exists (select 1 from public.lots where status = 'cancelled'),
            'nâng cấp 005: DB có lô ở đủ 4 mã cũ + Đã nhận + Huỷ');
select t.ok((select count(*) from public.payments where kind = 'refund') > 0
            and (select count(*) from public.orders where status in ('shipped','completed','returned') and ship_fee_payer = 'shop' and ship_fee_vnd > 0) > 0
            and (select count(*) from public.orders where status = 'returned' and return_ship_fee_vnd > 0) > 0
            and (select count(*) from public.intermediary_txns where kind = 'transfer' and amount_vnd > 0) > 0,
            'nâng cấp 005: DB có khoản thu / hoàn tiền / ship shop chịu / ship chiều về / Đã chuyển để backfill');

drop schema if exists snap5 cascade;
create schema snap5;
create table snap5.lots      as select id, version, updated_at, status, ship_fee_vnd, buying_fee_pct, received_at from public.lots;
create table snap5.units     as select id, version, updated_at, cost_vnd_auto, cost_vnd_override from public.units;
create table snap5.orders    as select id, version, updated_at, status, shipped_at from public.orders;
create table snap5.lines     as select id, version, updated_at, cancelled from public.order_lines;
create table snap5.payments  as select id, version, updated_at, kind, amount_vnd from public.payments;
create table snap5.txns      as select id, version, updated_at, kind, amount_vnd, lot_id from public.intermediary_txns;
create table snap5.settings  as select user_id, version, updated_at from public.settings;
create table snap5.v_units   as select unit_id, to_jsonb(v) as j from public.v_units v;
create table snap5.v_lot     as select lot_id, to_jsonb(v) as j from public.v_lot_summary v;
create table snap5.v_order   as select order_id, to_jsonb(v) as j from public.v_order_summary v;
create table snap5.v_stock   as select model_id, to_jsonb(v) as j from public.v_model_stock v;
create table snap5.v_balance as select user_id, to_jsonb(v) as j from public.v_intermediary_balance v;
create table snap5.v_sugg    as select user_id, to_jsonb(v) as j from public.v_suggestions v;
-- Sổ quỹ kỳ vọng (tính độc lập từ bảng nguồn) theo người dùng
create table snap5.cash_expect as
select u.user_id,
       coalesce((select sum(amount_vnd) from public.payments p where p.user_id = u.user_id and p.kind in ('deposit','payment')), 0)::bigint as cust_in,
       coalesce((select sum(amount_vnd) from public.payments p where p.user_id = u.user_id and p.kind = 'refund'), 0)::bigint as refund_out,
       coalesce((select sum(amount_vnd) from public.intermediary_txns x where x.user_id = u.user_id and x.kind = 'transfer'), 0)::bigint as itx_out,
       coalesce((select sum(ship_fee_vnd) from public.orders o where o.user_id = u.user_id and o.ship_fee_payer = 'shop'
                   and o.status in ('shipped','completed','returned')), 0)::bigint as ship_out,
       coalesce((select sum(return_ship_fee_vnd) from public.orders o where o.user_id = u.user_id and o.status = 'returned'), 0)::bigint as ret_out,
       ((select count(*) from public.payments p where p.user_id = u.user_id)
        + (select count(*) from public.intermediary_txns x where x.user_id = u.user_id and x.kind = 'transfer' and x.amount_vnd > 0)
        + (select count(*) from public.orders o where o.user_id = u.user_id and o.ship_fee_payer = 'shop' and o.ship_fee_vnd > 0
             and o.status in ('shipped','completed','returned'))
        + (select count(*) from public.orders o where o.user_id = u.user_id and o.status = 'returned' and o.return_ship_fee_vnd > 0))::int as n
from public.settings u;
select t.ok((select count(*) from snap5.v_lot) > 0 and (select sum(n) from snap5.cash_expect) > 0, 'nâng cấp 005: đã chụp số liệu trước 005');
