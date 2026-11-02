-- Test CR-010 (009_revert.sql): lùi 1 bước trạng thái cối (revert_lot) và đơn (revert_order). Dùng user thử 12 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('12121212-1212-1212-1212-121212121212', 'u12@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '12121212-1212-1212-1212-121212121212', false);
select public.bootstrap_user();
select id as m_ku from public.models where code_prefix = 'KU' \gset
select (private.today_vn() - 10)::text as d10, (private.today_vn() - 3)::text as d3 \gset
insert into public.customers (fb_name) values ('Khách CR-010') returning id as cu \gset

-- ===== Cối =====
select x->>'lot_id' as la from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1000))) x) s \gset
select t.err(format('select public.revert_lot(%L)', :'la'), 'NOTHING_TO_REVERT', 'CR-010: Kho TQ không lùi được nữa');
select public.set_lot_status(:'la', 'vn_warehouse');
select public.revert_lot(:'la');
select t.eq((select status from public.lots where id = :'la'), 'cn_warehouse', 'CR-010: Kho VN → Kho TQ');

-- Kho Lumi → Kho VN: đơn Đã chốt giữ cối ⇒ về Đặt trước; nhận lại ⇒ tự chốt lại
select public.receive_lot(:'la', null, :'d3'::date);
select id as ua from public.units where lot_id = :'la' \gset
select x->>'order_id' as o1 from (select public.save_order(null, jsonb_build_object('customer_id', :'cu', 'order_date', :'d3', 'ship_fee_vnd', 30000, 'ship_fee_payer', 'shop'),
    jsonb_build_array(jsonb_build_object('unit_id', :'ua', 'unit_price_vnd', 5000000))) x) s \gset
select t.eq((select status from public.orders where id = :'o1'), 'confirmed', 'CR-010: chuẩn bị - đơn Đã chốt');
select public.revert_lot(:'la') as rl \gset
select t.eq((select status || '/' || coalesce(received_at::text, 'null') from public.lots where id = :'la'), 'vn_warehouse/null', 'CR-010: Kho Lumi → Kho VN, bỏ ngày nhận');
select t.eq((select status from public.orders where id = :'o1'), 'preorder', 'CR-010: đơn Đã chốt giữ cối ⇒ về Đặt trước');
select t.eq((:'rl'::jsonb->'reverted_order_ids'->>0), :'o1', 'CR-010: trả về đơn đã lùi');
select public.receive_lot(:'la', null, :'d3'::date);
select t.eq((select status from public.orders where id = :'o1'), 'confirmed', 'CR-010: nhận lại ⇒ đơn tự chốt lại');

-- ===== Đơn =====
select public.ship_order(:'o1', null, :'d3'::date);
select t.eq((select count(*)::int from public.cash_entries where order_id = :'o1' and kind = 'ship_shop'), 1, 'CR-010: chuẩn bị - bút toán ship shop chịu');
select t.err(format('select public.revert_lot(%L)', :'la'), 'LOT_HAS_SOLD_UNITS', 'CR-010: cối đang giao khách ⇒ không lùi cối được');
select public.revert_order(:'o1');
select t.eq((select status || '/' || coalesce(shipped_at::text, 'null') from public.orders where id = :'o1'), 'confirmed/null', 'CR-010: Vận chuyển → Đã chốt, bỏ ngày gửi');
select t.eq((select count(*)::int from public.cash_entries where order_id = :'o1' and kind = 'ship_shop'), 0, 'CR-010: bỏ bút toán ship shop chịu');
select public.ship_order(:'o1', null, :'d3'::date);
select public.complete_order(:'o1', true);
select public.revert_order(:'o1');
select t.eq((select status || '/' || coalesce(completed_at::text, 'null') || '/' || completion_forced from public.orders where id = :'o1'),
            'shipped/null/false', 'CR-010: Đã giao → Vận chuyển');
select public.return_order(:'o1', false, 20000);
select t.eq((select count(*)::int from public.order_lines where order_id = :'o1' and not cancelled), 0, 'CR-010: chuẩn bị - hoàn hàng nhả chiếc');
select public.revert_order(:'o1');
select t.eq((select status || '/' || coalesce(returned_at::text, 'null') || '/' || return_ship_fee_vnd from public.orders where id = :'o1'),
            'shipped/null/0', 'CR-010: Hoàn hàng → Vận chuyển, bỏ thông tin hoàn');
select t.eq((select status from public.v_units where unit_id = :'ua'), 'sold', 'CR-010: chiếc giữ lại cho đơn (đang giao)');
select t.eq((select count(*)::int from public.cash_entries where order_id = :'o1' and kind = 'return_ship'), 0, 'CR-010: bỏ bút toán ship chiều về');

-- Huỷ đơn → khôi phục; chiếc đã sang đơn khác ⇒ UNIT_NOT_AVAILABLE
select public.revert_order(:'o1');   -- shipped → confirmed
select t.err(format('select public.revert_order(%L)', :'o1'), 'NOTHING_TO_REVERT', 'CR-010: Đã chốt không lùi được nữa');
select public.cancel_order(:'o1');
select public.revert_order(:'o1');
select t.eq((select status || '/' || coalesce(cancelled_at::text, 'null') from public.orders where id = :'o1'), 'confirmed/null', 'CR-010: Huỷ → Đã chốt (hàng đã về)');
select public.cancel_order(:'o1');
select x->>'order_id' as o2 from (select public.save_order(null, jsonb_build_object('customer_id', :'cu', 'order_date', :'d3'),
    jsonb_build_array(jsonb_build_object('unit_id', :'ua', 'unit_price_vnd', 5100000))) x) s \gset
select t.err(format('select public.revert_order(%L)', :'o1'), 'UNIT_NOT_AVAILABLE', 'CR-010: chiếc đã bán cho đơn khác ⇒ không khôi phục đơn');
select t.eq((select status from public.orders where id = :'o1'), 'cancelled', 'CR-010: lỗi ⇒ đơn giữ nguyên Huỷ');

-- Huỷ cối → khôi phục (Kho TQ), phải trả tính lại
select x->>'lot_id' as lb from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 500))) x) s \gset
select public.cancel_lot(:'lb');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lb'), 0::bigint, 'CR-010: chuẩn bị - cối huỷ phải trả 0');
select public.revert_lot(:'lb');
select t.eq((select status || '/' || coalesce(cancelled_at::text, 'null') from public.lots where id = :'lb'), 'cn_warehouse/null', 'CR-010: Huỷ → Kho TQ');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lb'), 1800000::bigint, 'CR-010: khôi phục ⇒ phải trả tính lại');
reset role;
