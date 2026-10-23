-- Nâng cấp v2 (trước CR-003) → 002_buying_fee.sql: chụp số liệu TRƯỚC khi chạy 002 (chạy với quyền superuser, bỏ qua RLS).
-- DB này đã cài fixtures/001_schema_v2_pre003.sql (bản 001 trước CR-003) + chạy test 03 ⇒ có dữ liệu như DB thật.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
select t.ok(not exists (select 1 from information_schema.columns where table_schema = 'public'
                          and ((table_name = 'lots' and column_name = 'buying_fee_pct')
                               or (table_name = 'settings' and column_name = 'default_buying_fee_pct'))),
            'nâng cấp: DB trước 002 chưa có cột phí mua hộ (đúng bản v2 cũ)');
select t.ok((select count(*) from public.lots) >= 4 and (select count(*) from public.units) >= 8
            and (select count(*) from public.orders) >= 4, 'nâng cấp: DB v2 cũ có dữ liệu (lô, chiếc, đơn)');
drop schema if exists snap cascade;
create schema snap;
create table snap.units      as select id, version, updated_at, cost_vnd_auto, cost_vnd_override from public.units;
create table snap.lots       as select id, version, updated_at, exchange_rate, ship_fee_vnd, status from public.lots;
create table snap.txns       as select id, version, updated_at, amount_vnd from public.intermediary_txns;
create table snap.v_units    as select unit_id, to_jsonb(v) as j from public.v_units v;
create table snap.v_lot      as select lot_id, to_jsonb(v) as j from public.v_lot_summary v;
create table snap.v_order    as select order_id, to_jsonb(v) as j from public.v_order_summary v;
create table snap.v_stock    as select model_id, to_jsonb(v) as j from public.v_model_stock v;
create table snap.v_balance  as select user_id, to_jsonb(v) as j from public.v_intermediary_balance v;
create table snap.v_sugg     as select user_id, to_jsonb(v) as j from public.v_suggestions v;
create table snap.settings   as select user_id, version, updated_at from public.settings;
select t.ok((select count(*) from snap.v_lot) > 0, 'nâng cấp: đã chụp số liệu trước 002');
