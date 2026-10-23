-- Sau khi chạy 003_cod_return_condition.sql (2 lần) trên DB mô phỏng DB thật: dữ liệu cũ KHÔNG đổi, cột mới = mặc định.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
-- Bảng: giá trị + version + updated_at không đổi (003 không ghi vào dòng nào)
create function snap3.diff(a text, b text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select (select count(*) from (%1$s except %2$s) x) + (select count(*) from (%2$s except %1$s) y)', a, b) into n;
  return n;
end $$;
select t.eq(snap3.diff('select * from snap3.units', 'select id, version, updated_at, cost_vnd_auto, cost_vnd_override, serial_no from public.units'), 0,
            'nâng cấp 003: units (giá nhập, seri, version, updated_at) giữ nguyên');
select t.eq(snap3.diff('select * from snap3.lots', 'select id, version, updated_at, status, ship_fee_vnd, buying_fee_pct from public.lots'), 0,
            'nâng cấp 003: lots giữ nguyên');
select t.eq(snap3.diff('select * from snap3.orders', 'select id, version, updated_at, status, shipped_at, tracking_no from public.orders'), 0,
            'nâng cấp 003: orders (trạng thái, version) giữ nguyên');
select t.eq(snap3.diff('select * from snap3.lines', 'select id, version, updated_at, cancelled from public.order_lines'), 0,
            'nâng cấp 003: order_lines giữ nguyên');
select t.eq(snap3.diff('select * from snap3.payments', 'select id, version, updated_at, kind, amount_vnd from public.payments'), 0,
            'nâng cấp 003: payments giữ nguyên');
select t.eq(snap3.diff('select * from snap3.txns', 'select id, version, updated_at, amount_vnd from public.intermediary_txns'), 0,
            'nâng cấp 003: intermediary_txns (Phải trả) giữ nguyên');
select t.eq(snap3.diff('select * from snap3.settings', 'select user_id, version, updated_at from public.settings'), 0,
            'nâng cấp 003: settings version giữ nguyên');
-- Cột mới = mặc định
select t.eq((select count(*) from public.units where condition <> 'new')::int, 0, 'nâng cấp 003: mọi chiếc cũ condition = new');
select t.eq((select count(*) from public.payments where method <> 'transfer')::int, 0, 'nâng cấp 003: mọi khoản thu cũ method = transfer');
select t.eq((select count(*) from public.orders where cod_amount_vnd <> 0 or return_ship_fee_vnd <> 0 or keep_deposit
               or returned_at is not null or return_note is not null or status = 'returned')::int, 0,
            'nâng cấp 003: đơn cũ COD 0, không hoàn hàng');
select t.eq((select count(*) from public.settings where (aging_warn_days, aging_alert_days, lot_late_days) <> (30, 60, 21))::int, 0,
            'nâng cấp 003: cài đặt cũ nhận ngưỡng mặc định 30/60/21');
-- View: cột cũ giữ nguyên từng dòng; cột mới ở CUỐI
select t.eq((select count(*) from snap3.v_units s full join public.v_units v on v.unit_id = s.unit_id
              where s.j is distinct from (to_jsonb(v) - 'condition' - 'aging_level'))::int, 0,
            'nâng cấp 003: v_units cột cũ giữ nguyên từng chiếc (trạng thái, giá nhập, lãi, ngày tồn)');
select t.eq((select count(*) from snap3.v_lot s full join public.v_lot_summary v on v.lot_id = s.lot_id
              where s.j is distinct from (to_jsonb(v) - 'is_lot_late'))::int, 0, 'nâng cấp 003: v_lot_summary cột cũ giữ nguyên');
select t.eq((select count(*) from snap3.v_order s full join public.v_order_summary v on v.order_id = s.order_id
              where s.j is distinct from (to_jsonb(v) - array['cod_amount_vnd','cod_received_vnd','cod_pending_vnd','deposit_vnd',
                                          'returned_at','return_ship_fee_vnd','keep_deposit','return_note','kept_vnd','profit_date']))::int, 0,
            'nâng cấp 003: v_order_summary cột cũ giữ nguyên (còn phải thu, cần hoàn, lãi)');
select t.eq((select count(*) from public.v_order_summary where cod_pending_vnd <> 0 or cod_received_vnd <> 0 or kept_vnd is not null)::int, 0,
            'nâng cấp 003: đơn cũ không có COD chờ về');
select t.eq((select count(*) from public.v_order_summary
              where profit_date is distinct from case when status in ('shipped','completed') then shipped_at end)::int, 0,
            'nâng cấp 003: profit_date đơn cũ = ngày gửi (đơn đã gửi), null (đơn khác)');
select t.eq((select count(*) from snap3.v_stock s full join public.v_model_stock v on v.model_id = s.model_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 003: v_model_stock giữ nguyên');
select t.eq((select count(*) from snap3.v_balance s full join public.v_intermediary_balance v on v.user_id = s.user_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 003: v_intermediary_balance giữ nguyên');
select t.eq((select count(*) from snap3.v_sugg s full join public.v_suggestions v on v.user_id = s.user_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 003: v_suggestions giữ nguyên');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_units' and ordinal_position > 38),
            'version,condition,aging_level', 'nâng cấp 003: cột mới v_units nằm cuối');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_lot_summary' and ordinal_position > 28),
            'buying_fee_vnd,is_lot_late', 'nâng cấp 003: cột mới v_lot_summary nằm cuối');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_order_summary' and ordinal_position > 25),
            'cod_amount_vnd,cod_received_vnd,cod_pending_vnd,deposit_vnd,returned_at,return_ship_fee_vnd,keep_deposit,return_note,kept_vnd,profit_date',
            'nâng cấp 003: cột mới v_order_summary nằm cuối');
select t.eq((select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
            'customers,intermediary_txns,lots,models,notes,order_lines,orders,payments,sellers,settings,units',
            'nâng cấp 003: realtime giữ đúng 11 bảng');
select t.ok(has_table_privilege('authenticated', 'public.v_order_summary', 'select')
            and not has_table_privilege('anon', 'public.v_order_summary', 'select')
            and not has_table_privilege('anon', 'public.v_units', 'select'), 'nâng cấp 003: quyền đọc view giữ nguyên');
select t.eq((select count(*) from pg_proc where proname in ('receive_lot','ship_order'))::int, 2, 'nâng cấp 003: receive_lot / ship_order mỗi hàm 1 chữ ký');
drop schema snap3 cascade;
