-- Test CR-009 (008_local_ship.sql): ship Kho VN → Lumi trả ngay (giá nhập + sổ quỹ, không vào nợ trung gian), nhận cối không
-- cần ship TQ→VN, tất toán ship TQ→VN gộp (settle_cn_ship), lãi dự kiến chiếc đã giữ = giá chốt. Dùng user thử 10 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('10101010-1010-1010-1010-101010101010', 'u10@test.local'),
                                         ('11111111-2222-3333-4444-555555555555', 'u11@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '10101010-1010-1010-1010-101010101010', false);
select public.bootstrap_user();
select id as m_ku from public.models where code_prefix = 'KU' \gset
select (private.today_vn() - 20)::text as d20, (private.today_vn() - 10)::text as d10, (private.today_vn() - 2)::text as d2 \gset

-- 3 cối (mỗi cối 1 lô), ¥1.000 × 3.600, phí 0%. A có ship VN→Lumi 50.000 ngay khi tạo.
select x->>'lot_id' as la from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d20', 'buying_fee_pct', 0, 'local_ship_vnd', 50000),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1000, 'list_price_vnd', 5000000))) x) s \gset
select x->>'lot_id' as lb from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d20', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1000, 'list_price_vnd', 5000000))) x) s \gset
select x->>'lot_id' as lc from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1000, 'list_price_vnd', 5000000))) x) s \gset
select id as ua from public.units where lot_id = :'la' \gset
select id as ub from public.units where lot_id = :'lb' \gset
select id as uc from public.units where lot_id = :'lc' \gset

select t.eq((select cost_vnd_auto from public.units where id = :'ua'), 3650000::bigint, 'CR-009: ship VN→Lumi vào giá nhập (3.600.000 + 50.000)');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'la'), 3600000::bigint, 'CR-009: ship VN→Lumi KHÔNG vào phải trả trung gian');
select t.eq((select amount_vnd || '/' || direction || '/' || entry_date from public.cash_entries where lot_id = :'la' and kind = 'local_ship'),
            '50000/out/' || :'d20', 'CR-009: bút toán sổ quỹ local_ship (tiền ra, chưa nhận ⇒ ngày đặt)');
select t.eq((select cost_is_provisional from public.v_units where unit_id = :'ua'), true, 'CR-009: chưa có ship TQ→VN ⇒ giá nhập tạm tính');

-- Nhận A không cần ship TQ→VN; bút toán chuyển sang ngày nhận
select public.receive_lot(:'la', null, :'d2'::date);
select t.eq((select status from public.lots where id = :'la'), 'received', 'CR-009: nhận cối không cần ship TQ→VN');
select t.eq((select entry_date::text from public.cash_entries where lot_id = :'la' and kind = 'local_ship'), :'d2', 'CR-009: bút toán local_ship theo ngày nhận');
-- Nhận B kèm ship VN→Lumi 40.000
select public.receive_lot(:'lb', null, :'d2'::date, null, null, 40000);
select t.eq((select local_ship_vnd from public.lots where id = :'lb'), 40000::bigint, 'CR-009: receive_lot ghi p_local_ship_vnd');
select t.eq((select cost_vnd_auto from public.units where id = :'ub'), 3640000::bigint, 'CR-009: giá nhập B = 3.600.000 + 40.000');
-- Sửa ship VN→Lumi của B → 0 ⇒ bỏ bút toán
select public.set_lot_local_ship(:'lb', 0);
select t.eq((select local_ship_vnd from public.lots where id = :'lb'), null::bigint, 'CR-009: set_lot_local_ship 0 ⇒ null');
select t.eq((select count(*)::int from public.cash_entries where lot_id = :'lb' and kind = 'local_ship'), 0, 'CR-009: bỏ ship ⇒ xoá bút toán');
select t.eq((select cost_vnd_auto from public.units where id = :'ub'), 3600000::bigint, 'CR-009: bỏ ship ⇒ giá nhập về 3.600.000');
select public.set_lot_local_ship(:'lb', 40000);

-- save_lot sửa (app mới không gửi khoá ship) ⇒ giữ ship
select public.save_lot(:'lc', jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'local_ship_vnd', 30000),
    jsonb_build_array(jsonb_build_object('unit_id', :'uc', 'price_cny', 1000, 'list_price_vnd', 5000000)));
select public.save_lot(:'lc', jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'note', 'ghi chú'),
    jsonb_build_array(jsonb_build_object('unit_id', :'uc', 'price_cny', 1000, 'list_price_vnd', 5000000)));
select t.eq((select local_ship_vnd from public.lots where id = :'lc'), 30000::bigint, 'CR-009: save_lot thiếu khoá local_ship_vnd ⇒ giữ nguyên');

-- Tất toán ship TQ→VN gộp 3 cối: 100.000 ⇒ 33.334 / 33.333 / 33.333 (đồng lẻ cho cối đặt sớm nhất, rồi theo id)
select public.settle_cn_ship(array[:'la', :'lb', :'lc']::uuid[], 100000, :'d2'::date, null) as st \gset
select t.eq((select sum(ship_fee_vnd)::bigint from public.lots where id in (:'la', :'lb', :'lc')), 100000::bigint, 'CR-009: chia đủ tổng ship TQ→VN');
select t.eq((select ship_fee_vnd from public.lots where id = :'lc'), 33333::bigint, 'CR-009: cối đặt muộn nhất nhận phần chia không lẻ');
select t.eq((select max(ship_fee_vnd) - min(ship_fee_vnd) from public.lots where id in (:'la', :'lb', :'lc')), 1::bigint, 'CR-009: chia đều (lệch tối đa 1 ₫)');
select t.eq((select cost_vnd_auto from public.units where id = :'uc'), (3600000 + 33333 + 30000)::bigint, 'CR-009: giá nhập = hàng + ship TQ→VN chia + ship VN→Lumi');
select t.eq((select cost_is_provisional from public.v_units where unit_id = :'uc'), false, 'CR-009: có ship TQ→VN ⇒ hết tạm tính');
select t.eq((select count(*)::int from public.cash_entries where kind = 'intermediary' and lot_id in (:'la', :'lb', :'lc') and note = 'Ship TQ→VN'), 3,
            'CR-009: ghi Đã chuyển từng cối (sổ quỹ tiền ra)');
select t.eq((select sum(outstanding_vnd)::bigint from public.v_lot_summary where lot_id in (:'la', :'lb', :'lc')), 3 * 3600000::bigint,
            'CR-009: tất toán ship không đổi còn nợ trung gian (chỉ còn tiền hàng)');
select t.eq((select ship_out_vnd from public.v_cash_monthly where month = date_trunc('month', :'d2'::date)::date)
              >= (select coalesce(sum(amount_vnd), 0) from public.cash_entries where kind = 'local_ship' and date_trunc('month', entry_date) = date_trunc('month', :'d2'::date)), true,
            'CR-009: v_cash_monthly.ship_out gồm local_ship');
select t.err(format('select public.settle_cn_ship(%L::uuid[], 1000)', array[:'la', :'la']), 'DUPLICATE_LOT', 'CR-009: settle_cn_ship cối trùng');
select t.err(format('select public.settle_cn_ship(%L::uuid[], 0)', array[:'la']), 'INVALID_AMOUNT', 'CR-009: settle_cn_ship tổng 0');
select t.err('select public.settle_cn_ship(''{}''::uuid[], 1000)', 'INVALID_INPUT', 'CR-009: settle_cn_ship không chọn cối');

-- Lãi dự kiến chiếc đã giữ = giá chốt trên đơn − giá nhập
insert into public.customers (fb_name) values ('Khách CR-009') returning id as cu \gset
select public.save_order(null, jsonb_build_object('customer_id', :'cu', 'order_date', :'d2', 'ship_fee_vnd', 0, 'ship_fee_payer', 'customer'),
    jsonb_build_array(jsonb_build_object('unit_id', :'ua', 'unit_price_vnd', 4200000)));
select t.eq((select status || '/' || expected_profit_vnd from public.v_units where unit_id = :'ua'),
            'reserved/' || (4200000 - (select cost_vnd_auto from public.units where id = :'ua')), 'CR-009: lãi dự kiến chiếc đã giữ theo giá chốt');
select t.eq((select expected_profit_vnd from public.v_units where unit_id = :'ub'),
            5000000 - (select cost_vnd_auto from public.units where id = :'ub'), 'CR-009: chiếc chưa giữ vẫn theo giá bán dự kiến');

-- Người khác không tất toán được cối của mình
select set_config('request.jwt.claim.sub', '11111111-2222-3333-4444-555555555555', false);
select t.err(format('select public.settle_cn_ship(%L::uuid[], 1000)', array[:'la']), 'LOT_NOT_FOUND', 'CR-009: RLS - cối người khác ⇒ LOT_NOT_FOUND');
select t.err(format('select public.set_lot_local_ship(%L, 1000)', :'la'), 'LOT_NOT_FOUND', 'CR-009: RLS - set_lot_local_ship cối người khác');
reset role;
