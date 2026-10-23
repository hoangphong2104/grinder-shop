-- Nâng cấp CR-004: chụp số liệu TRƯỚC khi chạy 003_cod_return_condition.sql (superuser, bỏ qua RLS).
-- DB này mô phỏng DB THẬT: v1 có dữ liệu → 000 + fixtures/001_schema_v2_pre003.sql → dữ liệu (test 03) → 002 → dữ liệu (test 05).
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
select t.ok(not exists (select 1 from information_schema.columns where table_schema = 'public'
                          and ((table_name = 'units' and column_name = 'condition')
                               or (table_name = 'payments' and column_name = 'method')
                               or (table_name = 'orders' and column_name in ('cod_amount_vnd','returned_at'))
                               or (table_name = 'settings' and column_name = 'aging_warn_days'))),
            'nâng cấp 003: DB trước 003 chưa có cột CR-004 (đúng bản đang chạy)');
select t.ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lots'
                      and column_name = 'buying_fee_pct'), 'nâng cấp 003: DB đã có 002 (lots.buying_fee_pct)');
select t.ok((select count(*) from public.lots) >= 8 and (select count(*) from public.units) >= 10
            and (select count(*) from public.orders) >= 4 and (select count(*) from public.payments) >= 3,
            'nâng cấp 003: DB có dữ liệu (lô, chiếc, đơn, khoản thu) như DB thật');
drop schema if exists snap3 cascade;
create schema snap3;
create table snap3.units     as select id, version, updated_at, cost_vnd_auto, cost_vnd_override, serial_no from public.units;
create table snap3.lots      as select id, version, updated_at, status, ship_fee_vnd, buying_fee_pct from public.lots;
create table snap3.orders    as select id, version, updated_at, status, shipped_at, tracking_no from public.orders;
create table snap3.lines     as select id, version, updated_at, cancelled from public.order_lines;
create table snap3.payments  as select id, version, updated_at, kind, amount_vnd from public.payments;
create table snap3.txns      as select id, version, updated_at, amount_vnd from public.intermediary_txns;
create table snap3.settings  as select user_id, version, updated_at from public.settings;
create table snap3.v_units   as select unit_id, to_jsonb(v) as j from public.v_units v;
create table snap3.v_lot     as select lot_id, to_jsonb(v) as j from public.v_lot_summary v;
create table snap3.v_order   as select order_id, to_jsonb(v) as j from public.v_order_summary v;
create table snap3.v_stock   as select model_id, to_jsonb(v) as j from public.v_model_stock v;
create table snap3.v_balance as select user_id, to_jsonb(v) as j from public.v_intermediary_balance v;
create table snap3.v_sugg    as select user_id, to_jsonb(v) as j from public.v_suggestions v;
select t.ok((select count(*) from snap3.v_order) > 0 and (select count(*) from snap3.v_units) > 0, 'nâng cấp 003: đã chụp số liệu trước 003');
