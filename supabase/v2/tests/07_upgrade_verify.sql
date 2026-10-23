-- Sau khi chạy 002_buying_fee.sql (2 lần) trên DB v2 cũ có dữ liệu: dữ liệu cũ KHÔNG đổi, lô cũ 0%.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
select t.ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lots'
                      and column_name = 'buying_fee_pct' and data_type = 'numeric' and numeric_precision = 5
                      and numeric_scale = 2 and is_nullable = 'NO'),
            'nâng cấp: lots.buying_fee_pct numeric(5,2) not null');
select t.ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'settings'
                      and column_name = 'default_buying_fee_pct' and data_type = 'numeric' and numeric_precision = 5
                      and numeric_scale = 2 and is_nullable = 'NO'),
            'nâng cấp: settings.default_buying_fee_pct numeric(5,2) not null');
select t.eq((select count(*) from public.lots where buying_fee_pct <> 0)::int, 0, 'nâng cấp: mọi lô cũ phí mua hộ = 0%');
select t.eq((select count(*) from public.settings where default_buying_fee_pct <> 0)::int, 0, 'nâng cấp: cài đặt cũ phí mặc định = 0%');
-- Bảng: giá trị + version + updated_at không đổi (002 không ghi vào dòng nào)
select t.eq((select count(*) from (select * from snap.units except select id, version, updated_at, cost_vnd_auto, cost_vnd_override from public.units) d)::int
          + (select count(*) from (select id, version, updated_at, cost_vnd_auto, cost_vnd_override from public.units except select * from snap.units) d)::int,
            0, 'nâng cấp: units (giá tự tính, giá sửa tay, version) giữ nguyên');
select t.eq((select count(*) from (select * from snap.lots except select id, version, updated_at, exchange_rate, ship_fee_vnd, status from public.lots) d)::int
          + (select count(*) from (select id, version, updated_at, exchange_rate, ship_fee_vnd, status from public.lots except select * from snap.lots) d)::int,
            0, 'nâng cấp: lots (tỷ giá, ship, trạng thái, version) giữ nguyên');
select t.eq((select count(*) from (select * from snap.txns except select id, version, updated_at, amount_vnd from public.intermediary_txns) d)::int
          + (select count(*) from (select id, version, updated_at, amount_vnd from public.intermediary_txns except select * from snap.txns) d)::int,
            0, 'nâng cấp: intermediary_txns (Phải trả) giữ nguyên');
select t.eq((select count(*) from (select * from snap.settings except select user_id, version, updated_at from public.settings) d)::int,
            0, 'nâng cấp: settings version giữ nguyên');
-- View: số cũ không đổi; cột mới = 0
select t.eq((select count(*) from snap.v_units s full join public.v_units v on v.unit_id = s.unit_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp: v_units giữ nguyên từng chiếc');
select t.eq((select count(*) from snap.v_lot s full join public.v_lot_summary v on v.lot_id = s.lot_id
              where s.j is distinct from (to_jsonb(v) - 'buying_fee_pct' - 'buying_fee_vnd'))::int, 0,
            'nâng cấp: v_lot_summary cột cũ giữ nguyên (tiền hàng, phải trả, giá vốn)');
select t.eq((select count(*) from public.v_lot_summary where buying_fee_pct <> 0 or buying_fee_vnd <> 0)::int, 0,
            'nâng cấp: v_lot_summary.buying_fee_pct / buying_fee_vnd = 0 cho lô cũ');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_lot_summary' and ordinal_position > 26),
            'models,buying_fee_pct,buying_fee_vnd', 'nâng cấp: cột mới v_lot_summary nằm cuối');
select t.eq((select count(*) from snap.v_order s full join public.v_order_summary v on v.order_id = s.order_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp: v_order_summary (lãi, còn phải thu) giữ nguyên');
select t.eq((select count(*) from snap.v_stock s full join public.v_model_stock v on v.model_id = s.model_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp: v_model_stock (tồn, giá trị tồn) giữ nguyên');
select t.eq((select count(*) from snap.v_balance s full join public.v_intermediary_balance v on v.user_id = s.user_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp: v_intermediary_balance (còn nợ trung gian) giữ nguyên');
select t.eq((select count(*) from snap.v_sugg s full join public.v_suggestions v on v.user_id = s.user_id
              where s.j is distinct from (to_jsonb(v) - 'last_buying_fee_pct'))::int, 0, 'nâng cấp: v_suggestions cột cũ giữ nguyên');
select t.ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class
              where relname in ('v_lot_summary','v_suggestions')), 'nâng cấp: view vẫn security_invoker = true');
select t.ok(has_table_privilege('authenticated', 'public.v_lot_summary', 'select')
            and has_table_privilege('authenticated', 'public.v_suggestions', 'select')
            and not has_table_privilege('anon', 'public.v_lot_summary', 'select'), 'nâng cấp: quyền đọc view giữ nguyên (authenticated có, anon không)');
select t.ok(has_column_privilege('authenticated', 'public.settings', 'default_buying_fee_pct', 'update')
            and has_column_privilege('authenticated', 'public.lots', 'buying_fee_pct', 'select')
            and not has_column_privilege('authenticated', 'public.lots', 'buying_fee_pct', 'update'),
            'nâng cấp: quyền cột — sửa phí mặc định được, không sửa trực tiếp phí của lô');
select t.ok(has_function_privilege('authenticated', 'public.save_lot(uuid, jsonb, jsonb, int)', 'execute')
            and not has_function_privilege('anon', 'public.save_lot(uuid, jsonb, jsonb, int)', 'execute')
            and not has_function_privilege('authenticated', 'private.recalc_lot(uuid)', 'execute'),
            'nâng cấp: quyền thực thi save_lot / recalc_lot giữ nguyên');
select t.eq((select count(*) from pg_proc where proname = 'save_lot')::int, 1, 'nâng cấp: vẫn 1 chữ ký save_lot');
drop schema snap cascade;
