-- Test nghiệp vụ schema v2 (CR-001 + CR-002). Chạy với role authenticated, auth.uid() = user thử.
-- Mỗi kiểm tra in "PASS: ..."; sai thì raise "FAIL: ..." và dừng (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- ========== 0. bootstrap_user ==========
select public.bootstrap_user();
select public.bootstrap_user();   -- idempotent
select t.eq((select string_agg(code_prefix || ':' || next_seq, ',' order by sort_order) from public.models),
            'ZP6:1,KU:1,JU:1', 'bootstrap: 3 model ZP6/KU/JU, next_seq = 1 (gọi 2 lần vẫn 3)');
select id as m_zp6 from public.models where code_prefix = 'ZP6' \gset
select id as m_ku  from public.models where code_prefix = 'KU'  \gset
select id as m_ju  from public.models where code_prefix = 'JU'  \gset
update public.models set default_list_price_vnd = 5200000 where id = :'m_zp6';
select version as m_zp6_ver from public.models where id = :'m_zp6' \gset

-- ========== 1. Lô A: 2 × ZP6 ¥1.010, tỷ giá 3.600 (chưa có ship) ==========
select x->>'lot_id' as lot_a, x::text as lot_a_res from (
  select public.save_lot(null,
    jsonb_build_object('exchange_rate', 3600, 'goofish_url', 'https://www.goofish.com/item?id=555000111',
                       'new_seller', jsonb_build_object('nickname', 'Shop Hàng Châu')),
    jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 2, 'price_cny', 1010))) x) s \gset
select t.eq((select string_agg(code, ',' order by code) from public.units where lot_id = :'lot_a'),
            'ZP6-001,ZP6-002', 'mã tự cấp ZP6-001, ZP6-002');
select t.eq((select goofish_item_id from public.lots where id = :'lot_a'), '555000111', 'tách item id từ link');
select t.eq((select count(*) from public.sellers)::int, 1, 'new_seller tạo người bán');
select t.eq((select string_agg(cost_vnd_auto::text || '/' || list_price_vnd, ',') from public.units where lot_id = :'lot_a'),
            '3636000/5200000,3636000/5200000', 'chưa có ship: giá tạm = ¥×tỷ giá; giá bán dự kiến = mặc định model');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lot_a'), 7272000::bigint, 'phải trả tạm 7.272.000');
select t.eq((select bool_and(cost_is_provisional) from public.v_units where lot_id = :'lot_a'), true, 'cost_is_provisional khi chưa ship');
select t.eq((select version from public.models where id = :'m_zp6'), :m_zp6_ver,
            'cấp mã (next_seq) không tăng version model');
select t.eq((select next_seq from public.models where id = :'m_zp6'), 3, 'next_seq ZP6 = 3');

-- Kiểm tra đầu vào
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 1, 'price_cny', 0))), 'INVALID_AMOUNT', 'giá ¥ = 0 bị chặn');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 0, 'price_cny', 10))), 'INVALID_QTY', 'qty = 0 bị chặn');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 1001, 'price_cny', 10))), 'INVALID_QTY', 'qty = 1001 bị chặn (tối đa 1000)');
select t.err(format('select public.save_lot(null, %L, %L)', '{}',
             jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 1, 'price_cny', 10))), 'EXCHANGE_RATE_REQUIRED', 'thiếu tỷ giá');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600}', '[]'), 'LOT_HAS_NO_LINES', 'lô rỗng');

-- ========== 2. Lô B: KU ¥1.500 (giá bán 6.000.000) + ZP6 ¥1.000 → sửa: bỏ ZP6-003, thêm ZP6 → ZP6-004 ==========
select x->>'lot_id' as lot_b, x->>'duplicate_lot_ids' as lot_b_dups from (
  select public.save_lot(null, jsonb_build_object('exchange_rate', 3500, 'goofish_item_id', '555000111'),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1500, 'list_price_vnd', 6000000),
                      jsonb_build_object('model_id', :'m_zp6', 'qty', 1, 'price_cny', 1000))) x) s \gset
select t.eq(:'lot_b_dups', jsonb_build_array(:'lot_a')::text, 'trùng item id Goofish → trả duplicate_lot_ids');
select t.eq((select string_agg(code, ',' order by code) from public.units where lot_id = :'lot_b'), 'KU-001,ZP6-003', 'lô B: KU-001, ZP6-003');
select id as u_ku1 from public.units where code = 'KU-001' \gset
select id as u_zp3 from public.units where code = 'ZP6-003' \gset
select version as lot_b_ver from public.lots where id = :'lot_b' \gset
select x::text as lot_b_edit from (
  select public.save_lot(:'lot_b', jsonb_build_object('exchange_rate', 3500),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_ku1', 'price_cny', 1550),
                      jsonb_build_object('model_id', :'m_zp6', 'qty', 1, 'price_cny', 1000)), :lot_b_ver) x) s \gset
select t.eq((select string_agg(code, ',' order by code) from public.units where lot_id = :'lot_b'), 'KU-001,ZP6-004',
            'sửa lô: bỏ ZP6-003, chiếc mới là ZP6-004 (không tái dùng mã)');
select t.eq((select price_cny::text || '/' || list_price_vnd || '/' || cost_vnd_auto from public.units where id = :'u_ku1'),
            '1550.00/6000000/5425000', 'sửa giá ¥ chiếc giữ lại: auto = 1550×3500 = 5.425.000');
select t.eq((select (:'lot_b_edit')::jsonb->'removed_units'->0->>'code'), 'ZP6-003', 'removed_units trả ZP6-003');
select t.err(format('select public.save_lot(%L, %L, %L, %s)', :'lot_b', '{"exchange_rate":3500}',
             jsonb_build_array(jsonb_build_object('unit_id', :'u_ku1')), :lot_b_ver), 'VERSION_CONFLICT', 'save_lot version cũ → VERSION_CONFLICT');

-- ========== 3. Đơn O1: khách mới + cọc trong 1 lệnh, giữ ZP6-001 đang về → Đặt trước ==========
select id as u_zp1 from public.units where code = 'ZP6-001' \gset
select id as u_zp2 from public.units where code = 'ZP6-002' \gset
select id as u_zp4 from public.units where code = 'ZP6-004' \gset
select x->>'order_id' as o1, x->>'status' as o1_status, x->>'warning' as o1_warn, x->>'customer_id' as c_lan,
       x->>'deposit_payment_id' as o1_pay from (
  select public.save_order(null,
    jsonb_build_object('new_customer', jsonb_build_object('fb_name', 'Lan Nguyễn', 'phone', '0901000000', 'address', 'Q1'),
                       'deposit_vnd', 1000000, 'ship_fee_vnd', 30000, 'ship_fee_payer', 'shop'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_zp1', 'unit_price_vnd', 5500000))) x) s \gset
select t.eq(:'o1_status', 'preorder', 'đơn có chiếc Đang về → preorder (A6)');
select t.eq(:'o1_warn', 'WAITING_FOR_STOCK', 'warning WAITING_FOR_STOCK');
select t.eq((select fb_name from public.customers where id = :'c_lan'), 'Lan Nguyễn', 'new_customer tạo khách cùng transaction');
select t.eq((select kind || ':' || amount_vnd from public.payments where id = :'o1_pay'), 'deposit:1000000', 'deposit_vnd ghi khoản cọc');
select t.eq((select status || ':' || holding_order_id from public.v_units where unit_id = :'u_zp1'), 'reserved:' || :'o1',
            'v_units: ZP6-001 reserved, giữ cho O1 (D4)');
select t.eq((select receivable_vnd from public.v_order_summary where order_id = :'o1'), 4500000::bigint,
            'còn phải thu = 5.500.000 − cọc 1.000.000 (ship shop chịu không tính khách — BR-10, Q-015)');
-- Lỗi rollback cả transaction: khách mới không bị tạo khi chiếc không hợp lệ
select t.err(format('select public.save_order(null, %L, %L)',
             jsonb_build_object('new_customer', jsonb_build_object('fb_name', 'Không được tạo'), 'deposit_vnd', 1),
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp1'))), 'UNIT_NOT_AVAILABLE', 'chiếc đã giữ cho O1 → UNIT_NOT_AVAILABLE');
select t.eq((select count(*) from public.customers where fb_name = 'Không được tạo')::int, 0, 'đơn lỗi ⇒ không có khách / cọc mồ côi');
select t.err(format('select public.save_order(null, %L, %L)', jsonb_build_object('customer_id', :'c_lan'),
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2'), jsonb_build_object('unit_id', :'u_zp2'))),
             'DUPLICATE_UNIT', '1 chiếc 2 dòng → DUPLICATE_UNIT');
select t.err(format('select public.save_order(null, %L, %L)', '{}', jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2'))),
             'CUSTOMER_REQUIRED', 'không có khách → CUSTOMER_REQUIRED');
select t.err(format('select public.save_order(%L, %L, %L)', :'o1', jsonb_build_object('customer_id', :'c_lan', 'deposit_vnd', 5),
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp1'))), 'DEPOSIT_ONLY_ON_CREATE', 'cọc khi sửa đơn bị chặn');
select t.err(format('select public.save_lot(%L, %L, %L)', :'lot_a', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2'))), 'UNIT_RESERVED', 'bỏ chiếc đang giữ khỏi lô → UNIT_RESERVED');
select t.err(format('select public.cancel_lot(%L)', :'lot_a'), 'LOT_HAS_RESERVED_UNITS', 'huỷ lô có chiếc đã giữ → LOT_HAS_RESERVED_UNITS');
select t.err(format('select public.confirm_preorder(%L)', :'o1'), 'UNIT_NOT_RECEIVED', 'chốt tay khi chưa về → UNIT_NOT_RECEIVED');
select t.err(format('select public.ship_order(%L)', :'o1'), 'ORDER_NOT_CONFIRMED', 'gửi đơn Đặt trước → ORDER_NOT_CONFIRMED (Q-007)');

-- ========== 4. Nhận lô A (ship 600.000) → 3.936.000 / chiếc, phải trả 7.872.000, O1 tự chốt ==========
select t.err(format('select public.receive_lot(%L)', :'lot_a'), 'SHIP_FEE_REQUIRED', 'nhận lô không có ship → SHIP_FEE_REQUIRED (BR-02)');
select x::text as recv_a from (select public.receive_lot(:'lot_a', 600000, '2026-10-01') x) s \gset
select t.eq((select string_agg(cost_vnd_auto::text, ',') from public.units where lot_id = :'lot_a'), '3936000,3936000',
            'giá nhập tự tính = round(1010×3600 + 600000÷2) = 3.936.000 mỗi chiếc');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lot_a'), 7872000::bigint, 'phải trả trung gian = 7.872.000');
select t.eq((:'recv_a')::jsonb->'auto_confirmed_order_ids', jsonb_build_array(:'o1'), 'receive_lot trả O1 trong auto_confirmed_order_ids (A7)');
select t.eq((select status from public.orders where id = :'o1'), 'confirmed', 'O1 tự chuyển Đã chốt');
select t.err(format('select public.save_lot(%L, %L, %L)', :'lot_a', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp1'), jsonb_build_object('unit_id', :'u_zp2'))),
             'LOT_LOCKED', 'lô đã nhận không sửa qua save_lot (A10)');

-- ========== 5. Giá sửa tay + gửi hàng + đổi ship sau khi nhận (A3) ==========
select t.err(format('select public.update_unit(%L, %L, 99)', :'u_zp2', '{"note":"x"}'), 'VERSION_CONFLICT', 'update_unit version sai');
select t.err(format('select public.update_unit(%L, %L)', :'u_zp2', '{"price_cny":1}'), 'INVALID_INPUT', 'update_unit khoá lạ bị chặn');
select x->>'cost_vnd' as zp2_cost from (select public.update_unit(:'u_zp2',
  jsonb_build_object('cost_vnd_override', 4000000, 'serial_no', 'SN-002'),
  (select version from public.units where id = :'u_zp2')) x) s \gset
select t.eq(:'zp2_cost', '4000000', 'sửa tay giá nhập ZP6-002 = 4.000.000');
select x->>'status' as o1_ship from (select public.ship_order(:'o1', 'VN123', '2026-10-05') x) s \gset
select t.eq(:'o1_ship', 'shipped', 'gửi O1 (đã chốt, đủ hàng)');
select t.eq((select status from public.v_units where unit_id = :'u_zp1'), 'sold', 'ZP6-001 → sold');
select t.eq((select profit_vnd from public.v_order_summary where order_id = :'o1'), 1534000::bigint,
            'lãi O1 = 5.500.000 − 3.936.000 − ship shop 30.000 = 1.534.000');
select t.eq((select actual_profit_vnd::text || '/' || days_in_stock from public.v_units where unit_id = :'u_zp1'), '1564000/4',
            'v_units lãi thực tế 1.564.000, tồn 4 ngày (01→05/10)');
select x::text as shipfee from (select public.update_lot_ship_fee(:'lot_a', 800000) x) s \gset
select t.eq((select cost_vnd_auto from public.units where id = :'u_zp1'), 4036000::bigint,
            'đổi ship 800.000: chiếc ĐÃ BÁN không sửa tay tính lại = 4.036.000 (A3)');
select t.eq((select cost_vnd_auto::text || '/' || cost_vnd from public.v_units where unit_id = :'u_zp2'), '4036000/4000000',
            'chiếc sửa tay: auto cập nhật nhưng giá hiệu lực giữ 4.000.000');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lot_a'), 8072000::bigint,
            'phải trả = 2020×3600 + 800.000 = 8.072.000 (không theo giá sửa tay — A4)');
select t.eq((select profit_vnd from public.v_order_summary where order_id = :'o1'), 1434000::bigint, 'lãi O1 theo giá nhập hiện tại = 1.434.000 (A8)');
select x->>'cost_vnd' as zp2_reset from (select public.update_unit(:'u_zp2', '{"cost_vnd_override":null}') x) s \gset
select t.eq(:'zp2_reset', '4036000', 'override = null → về giá tự tính');
select t.eq((select serial_no from public.units where id = :'u_zp2'), 'SN-002', 'patch không có khoá serial_no ⇒ giữ nguyên');
select public.update_unit(:'u_zp1', '{"note":"khách quen","serial_no":"SN-001"}');
select t.eq((select note from public.units where id = :'u_zp1'), 'khách quen', 'sửa ghi chú chiếc đã bán');
select t.err(format('select public.update_lot_ship_fee(%L, 1)', :'lot_b'), 'LOT_NOT_RECEIVED', 'update_lot_ship_fee lô chưa nhận');

-- ========== 6. Hoàn tất (BR-10, Q-010) ==========
select t.err(format('select public.complete_order(%L)', :'o1'), 'RECEIVABLE_NOT_ZERO', 'hoàn tất khi còn nợ → RECEIVABLE_NOT_ZERO');
insert into public.payments (order_id, kind, amount_vnd) values (:'o1', 'payment', 4500000);
select x->>'receivable_vnd' as o1_recv from (select public.complete_order(:'o1') x) s \gset
select t.eq(:'o1_recv', '0', 'trả đủ → hoàn tất, còn phải thu 0');
select t.eq((select status || ':' || completion_forced from public.orders where id = :'o1'), 'completed:false', 'O1 completed, không ép');

-- ========== 7. Huỷ đơn trả chiếc (A5) + Cần hoàn (Q-009) ==========
select x->>'order_id' as o2, x->>'status' as o2_status from (
  select public.save_order(null, jsonb_build_object('customer_id', :'c_lan', 'deposit_vnd', 500000),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2'))) x) s \gset
select t.eq(:'o2_status', 'confirmed', 'mọi chiếc trong kho → confirmed (A6)');
select t.eq((select unit_price_vnd from public.order_lines where order_id = :'o2'), 5200000::bigint, 'thiếu giá dòng → lấy giá bán dự kiến (D3)');
select x::text as o2_cancel from (select public.cancel_order(:'o2') x) s \gset
select t.eq((:'o2_cancel')::jsonb->'released_unit_ids', jsonb_build_array(:'u_zp2'), 'cancel_order trả released_unit_ids');
select t.eq((select status from public.v_units where unit_id = :'u_zp2'), 'in_stock', 'huỷ đơn → ZP6-002 về Trong kho');
select t.eq((select receivable_vnd::text || '/' || refund_due_vnd from public.v_order_summary where order_id = :'o2'), '0/500000',
            'đơn huỷ: không còn nợ, Cần hoàn 500.000 (Q-009)');
select x->>'order_id' as o3 from (select public.save_order(null, jsonb_build_object('customer_id', :'c_lan'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2', 'unit_price_vnd', 5000000))) x) s \gset
select t.eq((select holding_order_id from public.v_units where unit_id = :'u_zp2'), (:'o3')::uuid, 'chiếc đã trả dùng lại được cho O3');

-- ========== 8. Huỷ lô có chiếc giữ bị từ chối; sau khi huỷ đơn thì huỷ được ==========
select x->>'order_id' as o4, x->>'status' as o4_status from (select public.save_order(null, jsonb_build_object('customer_id', :'c_lan'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_ku1'))) x) s \gset
select t.eq(:'o4_status', 'preorder', 'O4 giữ KU-001 đang về → preorder');
select t.err(format('select public.cancel_lot(%L)', :'lot_b'), 'LOT_HAS_RESERVED_UNITS',
             'huỷ lô B khi KU-001 giữ cho O4 → LOT_HAS_RESERVED_UNITS');
select t.ok((select public.cancel_order(:'o4')->>'status') = 'cancelled', 'huỷ O4');
select t.ok((select public.cancel_lot(:'lot_b')->>'status') = 'cancelled', 'huỷ lô B sau khi huỷ O4');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lot_b'), 0::bigint, 'lô huỷ → phải trả 0 (BR-12)');
select t.eq((select string_agg(status, ',') from public.v_units where lot_id = :'lot_b'), 'cancelled,cancelled', 'chiếc lô huỷ → cancelled');
select t.err(format('select public.save_order(null, %L, %L)', jsonb_build_object('customer_id', :'c_lan'),
             jsonb_build_array(jsonb_build_object('unit_id', :'u_ku1'))), 'UNIT_NOT_AVAILABLE', 'chọn chiếc lô huỷ → UNIT_NOT_AVAILABLE');

-- ========== 9. Bỏ chiếc chỉ thuộc đơn đã huỷ; đổi tiền tố không tái dùng mã ==========
select x->>'lot_id' as lot_d from (select public.save_lot(null, '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('model_id', :'m_ju', 'qty', 2, 'price_cny', 800))) x) s \gset
select id as u_ju1 from public.units where code = 'JU-001' \gset
select id as u_ju2 from public.units where code = 'JU-002' \gset
select x->>'order_id' as o6 from (select public.save_order(null, jsonb_build_object('customer_id', :'c_lan'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_ju1', 'unit_price_vnd', 3000000))) x) s \gset
select public.cancel_order(:'o6');
select x::text as lot_d_edit from (select public.save_lot(:'lot_d', '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('unit_id', :'u_ju2'))) x) s \gset
select t.eq((:'lot_d_edit')::jsonb->'detached_cancelled_order_ids', jsonb_build_array(:'o6'),
            'bỏ JU-001 (chỉ thuộc đơn huỷ O6) → trả detached_cancelled_order_ids');
select t.eq((select cost_vnd_auto from public.units where id = :'u_ju2'), 2880000::bigint, 'lô còn 1 chiếc: auto tính lại 800×3600');
update public.models set code_prefix = 'jx' where id = :'m_ju';
select t.eq((select code_prefix from public.models where id = :'m_ju'), 'JX', 'tiền tố chuẩn hoá chữ HOA');
insert into public.models (name, code_prefix) values ('J Ultra mới', 'JU');
select id as m_ju_new from public.models where name = 'J Ultra mới' \gset
select public.save_lot(:'lot_d', '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('unit_id', :'u_ju2'), jsonb_build_object('model_id', :'m_ju_new', 'qty', 1, 'price_cny', 800)));
select t.eq((select string_agg(code, ',' order by code) from public.units where lot_id = :'lot_d'), 'JU-002,JU-003',
            'model mới tiền tố JU: bỏ qua JU-001 (đã bỏ) và JU-002 (đang có) → JU-003');

-- ========== 10. Sắp hết theo model (A9) + giá trị tồn ==========
select x->>'lot_id' as lot_c from (select public.save_lot(null, '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 3, 'price_cny', 1000, 'list_price_vnd', 5100000))) x) s \gset
select public.receive_lot(:'lot_c', 300000, '2026-10-10');
select t.eq((select string_agg(code, ',' order by code) from public.units where lot_id = :'lot_c'), 'ZP6-005,ZP6-006,ZP6-007',
            'lô C tiếp tục ZP6-005..007');
select t.eq((select in_stock_count || '/' || incoming_count || '/' || reserved_count || '/' || sold_count || '/' || sellable_count
             || '/' || is_low_stock from public.v_model_stock where model_id = :'m_zp6'), '3/0/1/1/3/false',
            'ZP6: trong kho 3, đang về 0, đã giữ 1, đã bán 1, có thể bán 3, không sắp hết (ngưỡng 1)');
select t.eq((select stock_value_vnd from public.v_model_stock where model_id = :'m_zp6'), (4036000 + 3 * 3700000)::bigint,
            'giá trị tồn ZP6 = ZP6-002 đã giữ 4.036.000 + 3 × 3.700.000');
select t.eq((select on_hand_count from public.v_model_stock where model_id = :'m_zp6'), 4,
            'ZP6 on_hand = đã về & chưa bán, gồm chiếc đã giữ = 4');
select t.eq((select sellable_count || '/' || is_low_stock from public.v_model_stock where model_id = :'m_ku'), '0/true',
            'KU: có thể bán 0 ≤ ngưỡng 1 → sắp hết');
update public.models set low_stock_threshold = 3 where id = :'m_zp6';
select t.eq((select is_low_stock from public.v_model_stock where model_id = :'m_zp6'), true, 'ZP6 ngưỡng 3: 3 ≤ 3 → sắp hết');
select t.eq((select sellable_count || '/' || is_low_stock from public.v_model_stock where model_id = :'m_ju_new'), '1/true',
            'JU mới: 1 đang về chưa giữ → có thể bán 1 ≤ 1 → sắp hết');
select t.eq((select in_stock_count || '/' || total_qty || '/' || total_cost_vnd from public.v_lot_summary where lot_id = :'lot_c'),
            '3/3/11100000', 'v_lot_summary lô C');
select t.eq((select last_exchange_rate::text || '/' || last_ship_fee_per_unit_vnd from public.v_suggestions), '3600.00/100000',
            'v_suggestions: tỷ giá lô gần nhất, ship/chiếc lô gần nhất (300.000 ÷ 3)');

-- ========== 11. Sửa đơn: đổi chiếc → chiếc cũ được trả ==========
select id as u_zp5 from public.units where code = 'ZP6-005' \gset
select public.save_order(:'o3', jsonb_build_object('customer_id', :'c_lan'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u_zp5', 'unit_price_vnd', 5000000)),
    (select version from public.orders where id = :'o3'));
select t.eq((select string_agg(code || ':' || status, ',' order by code) from public.v_units where unit_id in (:'u_zp2', :'u_zp5')),
            'ZP6-002:in_stock,ZP6-005:reserved', 'sửa O3 đổi ZP6-002 → ZP6-005');

-- ========== 12. Quyền theo cột / RLS ghi ==========
select t.err(format('update public.units set cost_vnd_auto = 1 where id = %L', :'u_zp2'), '42501', 'không ghi trực tiếp units.cost_vnd_auto');
select t.err(format('update public.models set next_seq = 1 where id = %L', :'m_zp6'), '42501', 'không ghi trực tiếp models.next_seq');
select t.err(format('update public.order_lines set cancelled = true where order_id = %L', :'o3'), '42501', 'không ghi trực tiếp order_lines');
select t.err($$insert into public.intermediary_txns (kind, amount_vnd) values ('payable', 1)$$, '42501', 'không tự tạo khoản Phải trả');
update public.intermediary_txns set amount_vnd = 1 where kind = 'payable';
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'lot_a'), 8072000::bigint, 'UPDATE khoản Phải trả bị RLS lọc (0 dòng)');
insert into public.intermediary_txns (kind, amount_vnd, note) values ('transfer', 5000000, 'chuyển 1');
select t.eq((select balance_vnd from public.v_intermediary_balance),
            (select sum(payable_vnd) from public.v_lot_summary) - 5000000, 'còn nợ trung gian = Σ phải trả − đã chuyển');

-- ========== 13. CR-002 Ghi chú ==========
insert into public.notes (body) values ('Hỏi shop Hàng Châu giá KU tháng 11');
select id as n1 from public.notes \gset
update public.notes set body = 'Hỏi giá KU + JU', is_pinned = true where id = :'n1';
select t.eq((select body || '/' || is_pinned || '/' || version || '/' || (user_id = auth.uid()) from public.notes where id = :'n1'),
            'Hỏi giá KU + JU/true/2/true', 'notes: thêm + sửa (version 2, ghim, user_id tự gán)');
select t.err($$insert into public.notes (body) values ('')$$, '23514', 'notes: body rỗng bị chặn');
select t.err($$insert into public.notes (body, user_id) values ('x', '22222222-2222-2222-2222-222222222222')$$, '42501',
             'notes: không tự đặt user_id');

-- ========== 14. Quét AI (Q-012) ==========
select public.ai_scan_reserve('image') as scan1 \gset
select public.ai_scan_finish(:'scan1', 'ok', 'gemini-flash', 100, 50, 0.001);
select t.eq((select status from public.ai_scan_log where id = :'scan1'), 'ok', 'ai_scan_reserve / finish');

-- ========== 15. Storage policy ==========
insert into storage.objects (bucket_id, name) values ('private-images', '11111111-1111-1111-1111-111111111111/goofish/b.jpg');
select t.err($$insert into storage.objects (bucket_id, name) values ('private-images', '22222222-2222-2222-2222-222222222222/x.jpg')$$,
             '42501', 'storage: không ghi vào thư mục người khác');

-- ========== 16. RLS cách ly: user 2 ==========
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.bootstrap_user();
select t.eq((select count(*) from public.units)::int + (select count(*) from public.lots)::int + (select count(*) from public.orders)::int
            + (select count(*) from public.order_lines)::int + (select count(*) from public.customers)::int
            + (select count(*) from public.payments)::int + (select count(*) from public.intermediary_txns)::int
            + (select count(*) from public.notes)::int + (select count(*) from public.sellers)::int
            + (select count(*) from public.v_units)::int + (select count(*) from public.v_order_summary)::int
            + (select count(*) from public.v_lot_summary)::int + (select count(*) from public.v_intermediary_balance)::int
            + (select count(*) from public.ai_scan_log)::int, 0, 'RLS: user 2 không thấy dữ liệu user 1 (bảng + view)');
select t.eq((select count(*) || '/' || sum(in_stock_count + incoming_count) from public.v_model_stock), '3/0',
            'RLS: user 2 chỉ thấy 3 model của mình, tồn 0');
select t.eq((select count(*) from storage.objects)::int, 0, 'storage: user 2 không thấy ảnh user 1');
update public.notes set body = 'hack' where id = :'n1';
delete from public.notes where id = :'n1';
select t.err(format('select public.update_unit(%L, %L)', :'u_zp2', '{"note":"x"}'), 'UNIT_NOT_FOUND', 'RLS RPC: update_unit chiếc user 1');
select t.err(format('select public.save_order(null, %L, %L)', '{"new_customer":{"fb_name":"X"}}',
             jsonb_build_array(jsonb_build_object('unit_id', :'u_zp2'))), 'UNIT_NOT_FOUND', 'RLS RPC: save_order chiếc user 1');
select t.err(format('select public.receive_lot(%L, 1)', :'lot_d'), 'LOT_NOT_FOUND', 'RLS RPC: receive_lot lô user 1');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600}',
             jsonb_build_array(jsonb_build_object('model_id', :'m_zp6', 'qty', 1, 'price_cny', 10))), 'MODEL_NOT_FOUND',
             'RLS RPC: save_lot với model user 1');
select x->>'lot_id' as lot_u2 from (select public.save_lot(null, '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('model_id', (select id from public.models where code_prefix = 'ZP6'), 'qty', 1, 'price_cny', 10))) x) s \gset
select t.eq((select code from public.units where lot_id = :'lot_u2'), 'ZP6-001', 'mã riêng theo user: user 2 cũng bắt đầu ZP6-001');
select t.err(format('select public.save_order(null, %L, %L)', jsonb_build_object('customer_id', :'c_lan'),
             jsonb_build_array(jsonb_build_object('unit_id', (select id from public.units where lot_id = :'lot_u2')))),
             'CUSTOMER_NOT_FOUND', 'RLS RPC: dùng khách của user 1 → CUSTOMER_NOT_FOUND');

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select t.eq((select body from public.notes where id = :'n1'), 'Hỏi giá KU + JU', 'notes: user 2 không sửa / xoá được ghi chú user 1');

-- ========== 17. anon ==========
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select t.err('select count(*) from public.units', '42501', 'anon: không đọc units');
select t.err('select count(*) from public.v_units', '42501', 'anon: không đọc v_units');
select t.err('select count(*) from public.notes', '42501', 'anon: không đọc notes');
select t.err('select count(*) from public.models', '42501', 'anon: không đọc models');
select t.err($$select public.save_lot(null, '{}', '[]')$$, '42501', 'anon: không gọi save_lot');
select t.err($$select public.bootstrap_user()$$, '42501', 'anon: không gọi bootstrap_user');
set role authenticated;
select t.err($$select public.bootstrap_user()$$, 'NOT_AUTHENTICATED', 'authenticated không có JWT sub → NOT_AUTHENTICATED');
select t.err($$select private.recalc_lot(gen_random_uuid())$$, '42501', 'không gọi được hàm private');
reset role;
