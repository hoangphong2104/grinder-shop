-- Test CR-004 (phần dữ liệu): tình trạng chiếc, hình thức thu + COD, Hoàn hàng, tuổi tồn / lô trễ, RLS cột mới.
-- Chạy trên DB đã có CR-004 (cài mới 001, hoặc v2 cũ + 002 + 003). Dùng user thử 4 riêng (không đụng dữ liệu test 03 / 05).
-- Ngày "cố định" = tính lùi từ private.today_vn() (giờ VN) ⇒ kết quả không phụ thuộc ngày chạy.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'u4@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select public.bootstrap_user();
select id as g_zp6 from public.models where code_prefix = 'ZP6' \gset
select id as g_ku  from public.models where code_prefix = 'KU'  \gset
select (private.today_vn() - 80)::text as d80, (private.today_vn() - 65)::text as d65, (private.today_vn() - 50)::text as d50,
       (private.today_vn() - 45)::text as d45, (private.today_vn() - 31)::text as d31, (private.today_vn() - 30)::text as d30,
       (private.today_vn() - 22)::text as d22, (private.today_vn() - 21)::text as d21, (private.today_vn() - 5)::text as d5,
       (private.today_vn() - 6)::text as d6, (private.today_vn() - 2)::text as d2, private.today_vn()::text as d0 \gset

-- ========== 0. Cài đặt mặc định ==========
select t.eq((select aging_warn_days || '/' || aging_alert_days || '/' || lot_late_days from public.settings), '30/60/21',
            'CR-004: settings mặc định tồn lâu 30/60 ngày, lô trễ 21 ngày');

-- ========== 1. Lô (giá nhập = round(¥ × tỷ giá × (1 + 0%) + ship ÷ số chiếc)) ==========
-- L1: 3 × ZP6 ¥1.000, tỷ giá 3.600, đặt d80, nhận d65, ship 300.000 ⇒ mỗi chiếc 3.600.000 + 100.000 = 3.700.000
select x->>'lot_id' as l1 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d80', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'g_zp6', 'qty', 3, 'price_cny', 1000, 'list_price_vnd', 5000000))) x) s \gset
select id as g_u1 from public.units where lot_id = :'l1' order by code limit 1 \gset
select id as g_u2 from public.units where lot_id = :'l1' order by code limit 1 offset 1 \gset
select id as g_u3 from public.units where lot_id = :'l1' order by code limit 1 offset 2 \gset
-- L2: 2 × KU ¥1.500, đặt d50, nhận d31, ship 200.000 ⇒ 5.400.000 + 100.000 = 5.500.000
select x->>'lot_id' as l2 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d50', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'g_ku', 'qty', 2, 'price_cny', 1500, 'list_price_vnd', 7000000))) x) s \gset
select id as g_k1 from public.units where lot_id = :'l2' order by code limit 1 \gset
select id as g_k2 from public.units where lot_id = :'l2' order by code limit 1 offset 1 \gset
-- L3: 1 × KU ¥1.500, đặt d45, nhận d30, ship 0 ⇒ 5.400.000
select x->>'lot_id' as l3 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d45', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'g_ku', 'qty', 1, 'price_cny', 1500))) x) s \gset
-- L4: đặt d22 (chưa về) · L5: đặt d21 (chưa về) · L6: đặt d80 rồi huỷ
select x->>'lot_id' as l4 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d22', 'status', 'vn_shipping'),
    jsonb_build_array(jsonb_build_object('model_id', :'g_zp6', 'qty', 1, 'price_cny', 1000))) x) s \gset
select x->>'lot_id' as l5 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d21'),
    jsonb_build_array(jsonb_build_object('model_id', :'g_zp6', 'qty', 1, 'price_cny', 1000))) x) s \gset
select x->>'lot_id' as l6 from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d80'),
    jsonb_build_array(jsonb_build_object('model_id', :'g_ku', 'qty', 1, 'price_cny', 10))) x) s \gset
select public.cancel_lot(:'l6');

-- ========== 2. Tình trạng chiếc (KHO-S3, LOT-S1) ==========
select t.eq((select string_agg(condition, ',' order by code) from public.units where lot_id = :'l1'), 'new,new,new',
            'CR-004: chiếc mới mặc định condition = new (Mới)');
select t.err(format('select public.receive_lot(%L, 300000, %L, null, %L)', :'l1', :'d65',
             jsonb_build_array(jsonb_build_object('unit_id', :'g_u1', 'condition', 'broken'))), 'INVALID_INPUT',
             'CR-004: receive_lot p_units tình trạng lạ → INVALID_INPUT');
select t.err(format('select public.receive_lot(%L, 300000, %L, null, %L)', :'l1', :'d65',
             jsonb_build_array(jsonb_build_object('unit_id', :'g_u1', 'price_cny', 1))), 'INVALID_INPUT',
             'CR-004: receive_lot p_units khoá lạ → INVALID_INPUT');
select t.err(format('select public.receive_lot(%L, 300000, %L, null, %L)', :'l1', :'d65',
             jsonb_build_array(jsonb_build_object('unit_id', :'g_k1', 'condition', 'used'))), 'UNIT_NOT_FOUND',
             'CR-004: receive_lot p_units chiếc của lô khác → UNIT_NOT_FOUND');
select t.err(format('select public.receive_lot(%L, 300000, %L, null, %L)', :'l1', :'d65',
             jsonb_build_array(jsonb_build_object('unit_id', :'g_u1'), jsonb_build_object('unit_id', :'g_u1'))), 'DUPLICATE_UNIT',
             'CR-004: receive_lot p_units trùng chiếc → DUPLICATE_UNIT');
select t.err(format('select public.receive_lot(%L, 300000, %L, null, %L)', :'l1', :'d65', '{"unit_id":"x"}'), 'INVALID_INPUT',
             'CR-004: receive_lot p_units không phải mảng → INVALID_INPUT');
select t.eq((select (status in ('ordered','cn_warehouse')) || '/' || (ship_fee_vnd is null) from public.lots where id = :'l1'), 'true/true',
            'CR-004: receive_lot lỗi p_units ⇒ lô không đổi (rollback)');
select x::text as g_recv1 from (select public.receive_lot(p_lot_id => :'l1', p_ship_fee_vnd => 300000, p_received_at => :'d65',
    p_units => jsonb_build_array(jsonb_build_object('unit_id', :'g_u1', 'condition', 'used', 'serial_no', ' SN-A '),
                                 jsonb_build_object('unit_id', :'g_u2', 'condition', 'defect'))) x) s \gset
select t.eq((select string_agg(condition || ':' || coalesce(serial_no, '-'), ',' order by code) from public.units where lot_id = :'l1'),
            'used:SN-A,defect:-,new:-', 'CR-004: nhận lô ghi tình trạng + seri từng chiếc (chiếc không gửi giữ Mới)');
select t.eq((:'g_recv1')::jsonb->'units'->0->>'condition', 'used', 'CR-004: receive_lot trả condition trong units[]');
select t.eq((select string_agg(cost_vnd_auto::text, ',') from public.units where lot_id = :'l1'), '3700000,3700000,3700000',
            'CR-004: giá nhập L1 = 1000×3600 + 300000÷3 = 3.700.000 (p_units không ảnh hưởng giá)');
-- Gọi kiểu cũ (không p_units, tham số theo tên như PostgREST) vẫn chạy
select public.receive_lot(p_lot_id => :'l2', p_ship_fee_vnd => 200000, p_received_at => :'d31');
select public.receive_lot(p_lot_id => :'l3', p_ship_fee_vnd => 0, p_received_at => :'d30', p_units => '[]'::jsonb);
select t.eq((select string_agg(cost_vnd_auto::text, ',') from public.units where lot_id in (:'l2', :'l3')), '5500000,5500000,5400000',
            'CR-004: receive_lot không p_units (gọi kiểu cũ) vẫn nhận: KU 5.500.000 ×2, 5.400.000');
select version as g_u3_ver from public.units where id = :'g_u3' \gset
select x->>'condition' as g_u3_cond from (select public.update_unit(:'g_u3', '{"condition":"like_new"}', :g_u3_ver) x) s \gset
select t.eq(:'g_u3_cond' || '/' || (select version - :g_u3_ver from public.units where id = :'g_u3'), 'like_new/1',
            'CR-004: update_unit đổi condition → like_new, version +1');
select t.err(format('select public.update_unit(%L, %L)', :'g_u3', '{"condition":"broken"}'), 'INVALID_INPUT', 'CR-004: update_unit condition lạ → INVALID_INPUT');
select t.err(format('select public.update_unit(%L, %L)', :'g_u3', '{"condition":null}'), 'INVALID_INPUT', 'CR-004: update_unit condition null → INVALID_INPUT');
select t.eq((select string_agg(condition, ',' order by code) from public.v_units where lot_id = :'l1'), 'used,defect,like_new',
            'CR-004: v_units.condition');
select t.err(format('update public.units set condition = %L where id = %L', 'used', :'g_u3'), '42501',
             'CR-004: client không ghi trực tiếp units.condition (chỉ qua RPC)');

-- ========== 3. Tuổi tồn (KHO-S1) và lô trễ (LOT-S2) ==========
-- L1 nhận d65 ⇒ 65 > 60 ⇒ alert · L2 nhận d31 ⇒ 31 > 30 ⇒ warn · L3 nhận d30 ⇒ 30 không > 30 ⇒ ok · L4 chưa về ⇒ null
select t.eq((select string_agg(distinct days_in_stock || ':' || aging_level, ',') from public.v_units where lot_id = :'l1'), '65:alert',
            'CR-004: tồn 65 ngày > 60 → aging_level alert');
select t.eq((select string_agg(distinct days_in_stock || ':' || aging_level, ',') from public.v_units where lot_id = :'l2'), '31:warn',
            'CR-004: tồn 31 ngày > 30 → warn');
select t.eq((select days_in_stock || ':' || aging_level from public.v_units where lot_id = :'l3'), '30:ok', 'CR-004: tồn 30 ngày (biên) → ok');
select t.eq((select coalesce(aging_level, 'null') from public.v_units where lot_id = :'l4'), 'null', 'CR-004: chiếc Đang về → aging_level null');
select t.eq((select is_lot_late::text from public.v_lot_summary where lot_id = :'l4'), 'true', 'CR-004: lô đặt 22 ngày chưa về > 21 → is_lot_late');
select t.eq((select is_lot_late::text from public.v_lot_summary where lot_id = :'l5'), 'false', 'CR-004: lô đặt 21 ngày (biên) → không trễ');
select t.eq((select string_agg(is_lot_late::text, ',' order by ordered_at) from public.v_lot_summary where lot_id in (:'l1', :'l6')), 'false,false',
            'CR-004: lô đã nhận / đã huỷ → không trễ');
update public.settings set aging_alert_days = 70, lot_late_days = 22;           -- client sửa trực tiếp (grant cả bảng)
select t.eq((select string_agg(distinct aging_level, ',') from public.v_units where lot_id = :'l1') || '/'
            || (select is_lot_late::text from public.v_lot_summary where lot_id = :'l4'), 'warn/false',
            'CR-004: đổi ngưỡng (đỏ 70, trễ 22) → L1 65 ngày thành warn, L4 22 ngày hết trễ');
update public.settings set aging_alert_days = 60, lot_late_days = 21;
select t.err($$update public.settings set aging_warn_days = 60$$, '23514', 'CR-004: ngưỡng cam ≥ ngưỡng đỏ bị chặn');
select t.err($$update public.settings set aging_warn_days = 0$$, '23514', 'CR-004: ngưỡng tồn ≤ 0 bị chặn');
select t.err($$update public.settings set lot_late_days = 0$$, '23514', 'CR-004: ngưỡng lô trễ ≤ 0 bị chặn');

-- ========== 4. Khách + hình thức thu ==========
insert into public.customers (fb_name) values ('Khách COD');
select id as g_c from public.customers where fb_name = 'Khách COD' \gset

-- ========== 5. COD (DON-S1): O1 = ZP6 g_u3 (giá nhập 3.700.000) giá 5.000.000, ship 30.000 khách trả, cọc 1.000.000 tiền mặt ==========
-- Khách phải trả = 5.000.000 + 30.000 = 5.030.000; sau cọc còn 4.030.000
select x->>'order_id' as o1, x->>'deposit_payment_id' as o1_dep from (select public.save_order(null,
    jsonb_build_object('customer_id', :'g_c', 'ship_fee_vnd', 30000, 'ship_fee_payer', 'customer', 'deposit_vnd', 1000000, 'deposit_method', 'cash'),
    jsonb_build_array(jsonb_build_object('unit_id', :'g_u3', 'unit_price_vnd', 5000000))) x) s \gset
select t.eq((select kind || ':' || method || ':' || amount_vnd from public.payments where id = :'o1_dep'), 'deposit:cash:1000000',
            'CR-004: save_order deposit_method = cash ⇒ khoản cọc tiền mặt');
select t.err(format('select public.save_order(null, %L, %L)', jsonb_build_object('customer_id', :'g_c', 'deposit_vnd', 1, 'deposit_method', 'cod'),
             jsonb_build_array(jsonb_build_object('unit_id', :'g_k2'))), 'INVALID_INPUT', 'CR-004: cọc bằng COD → INVALID_INPUT');
select t.eq((select cod_amount_vnd || '/' || cod_pending_vnd || '/' || receivable_vnd from public.v_order_summary where order_id = :'o1'),
            '0/0/4030000', 'CR-004: đơn chưa gửi: COD 0, chờ về 0, còn thu 4.030.000');
select t.err(format('select public.set_order_cod(%L, 1)', :'o1'), 'ORDER_NOT_SHIPPED', 'CR-004: set_order_cod khi chưa gửi → ORDER_NOT_SHIPPED');
select t.err(format('select public.ship_order(%L, null, null, null, -1)', :'o1'), 'INVALID_AMOUNT', 'CR-004: ship_order COD âm → INVALID_AMOUNT');
select x::text as o1_ship from (select public.ship_order(p_order_id => :'o1', p_tracking_no => 'GHN1', p_shipped_at => :'d6',
    p_cod_amount_vnd => 4030000) x) s \gset
select t.eq((:'o1_ship')::jsonb->>'cod_amount_vnd', '4030000', 'CR-004: ship_order đặt COD 4.030.000');
select t.eq((select cod_amount_vnd || '/' || cod_received_vnd || '/' || cod_pending_vnd from public.v_order_summary where order_id = :'o1'),
            '4030000/0/4030000', 'CR-004: COD chờ về = min(4.030.000 − 0, còn thu 4.030.000) = 4.030.000');
select public.set_order_cod(:'o1', 4000000, (select version from public.orders where id = :'o1'));
select t.eq((select cod_amount_vnd || '/' || cod_pending_vnd from public.v_order_summary where order_id = :'o1'), '4000000/4000000',
            'CR-004: set_order_cod khi Đã gửi → 4.000.000, chờ về 4.000.000');
select t.err(format('select public.set_order_cod(%L, -5)', :'o1'), 'INVALID_AMOUNT', 'CR-004: set_order_cod âm → INVALID_AMOUNT');
select t.err(format('select public.set_order_cod(%L, 1, 1)', :'o1'), 'VERSION_CONFLICT', 'CR-004: set_order_cod version cũ → VERSION_CONFLICT');
select public.set_order_cod(:'o1', 4030000);
insert into public.payments (order_id, kind, amount_vnd, method) values (:'o1', 'payment', 2000000, 'cod');
-- đã thu COD 2.000.000 ⇒ chờ về = min(4.030.000 − 2.000.000, còn thu 5.030.000 − 3.000.000 = 2.030.000) = 2.030.000
select t.eq((select cod_received_vnd || '/' || cod_pending_vnd || '/' || receivable_vnd from public.v_order_summary where order_id = :'o1'),
            '2000000/2030000/2030000', 'CR-004: hãng chuyển 2.000.000 COD → chờ về 2.030.000');
insert into public.payments (order_id, kind, amount_vnd, method) values (:'o1', 'payment', 2030000, 'cod');
select t.eq((select cod_pending_vnd || '/' || receivable_vnd || '/' || paid_vnd from public.v_order_summary where order_id = :'o1'),
            '0/0/5030000', 'CR-004: nhận đủ COD → chờ về 0, còn thu 0, đã thu 5.030.000');
select t.ok((select public.complete_order(:'o1')->>'status') = 'completed', 'CR-004: đơn COD đủ tiền hoàn tất được');
select t.eq((select profit_vnd || '/' || profit_date from public.v_order_summary where order_id = :'o1'), '1300000/' || :'d6',
            'CR-004: lãi O1 = 5.000.000 − 3.700.000 = 1.300.000 (ship khách trả), tính theo ngày gửi');
select t.err(format('select public.set_order_cod(%L, 1)', :'o1'), 'ORDER_LOCKED', 'CR-004: set_order_cod đơn Hoàn tất → ORDER_LOCKED');

-- ========== 6. Hình thức thu (payments.method) ==========
select t.eq((select string_agg(method, ',' order by created_at) from public.payments where order_id = :'o1'), 'cash,cod,cod',
            'CR-004: payments.method lưu đúng hình thức');
insert into public.payments (order_id, kind, amount_vnd) values (:'o1', 'refund', 1);
select t.eq((select method from public.payments where order_id = :'o1' and kind = 'refund'), 'transfer', 'CR-004: không gửi method ⇒ mặc định transfer');
delete from public.payments where order_id = :'o1' and kind = 'refund';
select t.err(format('insert into public.payments (order_id, kind, amount_vnd, method) values (%L, %L, 1, %L)', :'o1', 'payment', 'momo'),
             '23514', 'CR-004: hình thức thu lạ bị chặn');
select t.err(format('insert into public.payments (order_id, kind, amount_vnd, method) values (%L, %L, 1, %L)', :'o1', 'deposit', 'cod'),
             '23514', 'CR-004: cọc bằng COD bị chặn (COD chỉ cho thanh toán)');
select t.err(format('insert into public.payments (order_id, kind, amount_vnd, method) values (%L, %L, 1, %L)', :'o1', 'refund', 'cod'),
             '23514', 'CR-004: hoàn tiền bằng COD bị chặn');

-- ========== 7. Hoàn hàng GIỮ cọc (DON-S3): O3 = KU g_k1 (giá nhập 5.500.000) giá 7.000.000, ship 40.000 SHOP chịu ==========
-- Thu: cọc 1.000.000 + thanh toán 500.000 = 1.500.000; gửi d5 với COD 5.500.000 (= 7.000.000 − 1.500.000); khách bom.
select x->>'order_id' as o3 from (select public.save_order(null,
    jsonb_build_object('customer_id', :'g_c', 'ship_fee_vnd', 40000, 'ship_fee_payer', 'shop', 'deposit_vnd', 1000000),
    jsonb_build_array(jsonb_build_object('unit_id', :'g_k1', 'unit_price_vnd', 7000000))) x) s \gset
insert into public.payments (order_id, kind, amount_vnd) values (:'o3', 'payment', 500000);
select t.err(format('select public.return_order(%L, true, 0)', :'o3'), 'ORDER_NOT_RETURNABLE', 'CR-004: hoàn hàng đơn Đã chốt → ORDER_NOT_RETURNABLE');
select public.ship_order(p_order_id => :'o3', p_shipped_at => :'d5', p_cod_amount_vnd => 5500000);
select t.eq((select profit_vnd || '/' || cod_pending_vnd from public.v_order_summary where order_id = :'o3'), '1460000/5500000',
            'CR-004: trước khi hoàn: lãi = 7.000.000 − 5.500.000 − 40.000 = 1.460.000; COD chờ về 5.500.000');
select t.err(format('select public.return_order(%L, true, -1)', :'o3'), 'INVALID_AMOUNT', 'CR-004: ship chiều về âm → INVALID_AMOUNT');
select t.err(format('select public.return_order(%L, null, 0)', :'o3'), 'INVALID_INPUT', 'CR-004: thiếu lựa chọn giữ / hoàn cọc → INVALID_INPUT');
select t.err(format('select public.return_order(%L, true, 0, %L)', :'o3', :'d6'), 'INVALID_INPUT', 'CR-004: ngày hoàn trước ngày gửi → INVALID_INPUT');
select t.err(format('select public.return_order(%L, true, 0, null, null, 1)', :'o3'), 'VERSION_CONFLICT', 'CR-004: return_order version cũ → VERSION_CONFLICT');
select x::text as o3_ret from (select public.return_order(:'o3', true, 45000, :'d2', '  Khách bom, hãng chuyển hoàn  ',
    (select version from public.orders where id = :'o3')) x) s \gset
-- đã thu ròng 1.500.000; giữ tối đa = Σ cọc 1.000.000 ⇒ cần hoàn = 1.500.000 − 1.000.000 = 500.000; shop giữ 1.000.000
-- lãi = 1.000.000 − ship đi shop chịu 40.000 − ship chiều về 45.000 = 915.000; còn thu 0; COD chờ về 0 (không thu được)
select t.eq((:'o3_ret')::jsonb->>'status' || '/' || ((:'o3_ret')::jsonb->>'refund_due_vnd') || '/' || ((:'o3_ret')::jsonb->>'profit_vnd'),
            'returned/500000/915000', 'CR-004: return_order (giữ cọc) trả status returned, cần hoàn 500.000, lãi 915.000');
select t.eq((:'o3_ret')::jsonb->'released_unit_ids', jsonb_build_array(:'g_k1'), 'CR-004: return_order trả released_unit_ids');
select t.eq((select receivable_vnd || '/' || refund_due_vnd || '/' || kept_vnd || '/' || profit_vnd || '/' || cod_pending_vnd
                    || '/' || deposit_vnd || '/' || return_ship_fee_vnd || '/' || keep_deposit || '/' || profit_date || '/' || return_note
               from public.v_order_summary where order_id = :'o3'),
            '0/500000/1000000/915000/0/1000000/45000/true/' || :'d2' || '/Khách bom, hãng chuyển hoàn',
            'CR-004: v_order_summary đơn hoàn hàng giữ cọc: còn thu 0, cần hoàn 500.000, giữ 1.000.000, lãi 915.000, COD chờ 0');
select t.eq((select goods_vnd || '/' || unit_count from public.v_order_summary where order_id = :'o3'), '7000000/1',
            'CR-004: đơn hoàn hàng vẫn hiện chiếc + tiền hàng (lịch sử)');
select t.eq((select status || '/' || coalesce(holding_order_id::text, 'null') || '/' || aging_level from public.v_units where unit_id = :'g_k1'),
            'in_stock/null/warn', 'CR-004: chiếc của đơn hoàn hàng về Trong kho, không ai giữ, tuổi tồn tính tiếp (31 ngày → warn)');
-- Ghi hoàn 500.000 ⇒ cần hoàn 0; tiền giữ + lãi KHÔNG đổi (lãi đã tính trên số giữ lại)
insert into public.payments (order_id, kind, amount_vnd, note) values (:'o3', 'refund', 500000, 'Hoàn phần ngoài cọc');
select t.eq((select refund_due_vnd || '/' || kept_vnd || '/' || profit_vnd from public.v_order_summary where order_id = :'o3'), '0/1000000/915000',
            'CR-004: ghi hoàn 500.000 → cần hoàn 0, giữ 1.000.000, lãi vẫn 915.000');
-- Chặn chuyển trạng thái
select t.err(format('select public.complete_order(%L, true)', :'o3'), 'ORDER_NOT_SHIPPED', 'CR-004: đơn hoàn hàng không hoàn tất được');
select t.err(format('select public.cancel_order(%L)', :'o3'), 'ORDER_LOCKED', 'CR-004: đơn hoàn hàng không huỷ được');
select t.err(format('select public.return_order(%L, true, 0)', :'o3'), 'ORDER_NOT_RETURNABLE', 'CR-004: hoàn hàng 2 lần → ORDER_NOT_RETURNABLE');
select t.err(format('select public.set_order_cod(%L, 0)', :'o3'), 'ORDER_LOCKED', 'CR-004: set_order_cod đơn hoàn hàng → ORDER_LOCKED');
select t.err(format('select public.ship_order(%L)', :'o3'), 'ORDER_NOT_CONFIRMED', 'CR-004: gửi lại đơn hoàn hàng → ORDER_NOT_CONFIRMED');
select t.err(format('select public.save_order(%L, %L, %L)', :'o3', jsonb_build_object('customer_id', :'g_c'),
             jsonb_build_array(jsonb_build_object('unit_id', :'g_k1'))), 'ORDER_LOCKED', 'CR-004: sửa đơn hoàn hàng → ORDER_LOCKED');
select t.err(format('select public.return_order(%L, true, 0)', :'o1'), 'ORDER_NOT_RETURNABLE', 'CR-004: hoàn hàng đơn Hoàn tất → ORDER_NOT_RETURNABLE');
-- Bán lại chiếc đã hoàn
select x->>'order_id' as o4, x->>'status' as o4_st from (select public.save_order(null, jsonb_build_object('customer_id', :'g_c'),
    jsonb_build_array(jsonb_build_object('unit_id', :'g_k1', 'unit_price_vnd', 6800000))) x) s \gset
select t.eq(:'o4_st' || '/' || (select status || ':' || holding_order_id || ':' || aging_level from public.v_units where unit_id = :'g_k1'),
            'confirmed/reserved:' || :'o4' || ':warn', 'CR-004: chiếc đã hoàn bán lại được (O4 Đã chốt, chiếc Đã giữ, vẫn có tuổi tồn)');
select public.ship_order(:'o4', null, :'d0');
select t.eq((select status || '/' || sold_price_vnd || '/' || coalesce(aging_level, 'null') from public.v_units where unit_id = :'g_k1'),
            'sold/6800000/null', 'CR-004: bán lại → Đã bán theo O4, hết tính tuổi tồn');
select t.eq((select count(*) from public.order_lines where unit_id = :'g_k1')::int || '/'
            || (select count(*) from public.order_lines where unit_id = :'g_k1' and not cancelled)::int, '2/1',
            'CR-004: chiếc có 2 dòng đơn (O3 đã nhả + O4), chỉ 1 dòng còn hiệu lực');

-- ========== 8. Hoàn hàng HOÀN cọc: O5 = ZP6 g_u1 (giá nhập 3.700.000) giá 5.000.000, ship 30.000 khách trả, cọc 800.000 ==========
select x->>'order_id' as o5 from (select public.save_order(null,
    jsonb_build_object('customer_id', :'g_c', 'ship_fee_vnd', 30000, 'ship_fee_payer', 'customer', 'deposit_vnd', 800000),
    jsonb_build_array(jsonb_build_object('unit_id', :'g_u1', 'unit_price_vnd', 5000000))) x) s \gset
select public.ship_order(p_order_id => :'o5', p_cod_amount_vnd => 4230000);       -- COD = 5.030.000 − 800.000
select x::text as o5_ret from (select public.return_order(p_order_id => :'o5', p_keep_deposit => false, p_return_ship_fee_vnd => 35000) x) s \gset
-- đã thu ròng 800.000; giữ tối đa 0 ⇒ cần hoàn 800.000; giữ 0; lãi = 0 − 0 (ship khách chịu) − 35.000 = −35.000
select t.eq((select receivable_vnd || '/' || refund_due_vnd || '/' || kept_vnd || '/' || profit_vnd || '/' || cod_pending_vnd || '/' || returned_at
               from public.v_order_summary where order_id = :'o5'), '0/800000/0/-35000/0/' || :'d0',
            'CR-004: hoàn hàng hoàn cọc: cần hoàn 800.000, giữ 0, lãi −35.000, ngày hoàn mặc định hôm nay');
select t.eq((select status || '/' || condition || '/' || aging_level from public.v_units where unit_id = :'g_u1'), 'in_stock/used/alert',
            'CR-004: chiếc về kho giữ tình trạng Đã dùng, tuổi tồn 65 ngày → alert');
insert into public.payments (order_id, kind, amount_vnd) values (:'o5', 'refund', 800000);
select t.eq((select refund_due_vnd || '/' || kept_vnd || '/' || profit_vnd from public.v_order_summary where order_id = :'o5'), '0/0/-35000',
            'CR-004: ghi hoàn 800.000 → cần hoàn 0, lãi vẫn −35.000');
-- Tồn theo model: ZP6 Trong kho = g_u1 (hoàn về) + g_u2 = 2; KU: g_k2 + L3 = 2 trong kho, 1 đã bán (g_k1 theo O4)
select t.eq((select string_agg(code_prefix || ':' || in_stock_count || '/' || sold_count || '/' || stock_value_vnd, ',' order by code_prefix)
               from public.v_model_stock where code_prefix in ('ZP6','KU')),
            'KU:2/1/10900000,ZP6:2/1/7400000', 'CR-004: v_model_stock tính chiếc hoàn về là Trong kho (giá trị tồn ZP6 = 2 × 3.700.000)');

-- ========== 9. Tháng tính lãi: đơn hoàn hàng tính theo returned_at ==========
select t.eq((select string_agg(status || ':' || profit_date, ',' order by profit_date, status) from public.v_order_summary
              where order_id in (:'o1', :'o3', :'o5')), 'completed:' || :'d6' || ',returned:' || :'d2' || ',returned:' || :'d0',
            'CR-004: profit_date = ngày gửi (đơn bán) / ngày hoàn (đơn hoàn hàng)');

-- ========== 10. Chữ ký + quyền RPC ==========
reset role;
select t.eq((select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ' | ' order by p.proname)
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('receive_lot','ship_order','return_order','set_order_cod')),
            'receive_lot(p_lot_id uuid, p_ship_fee_vnd bigint, p_received_at date, p_expected_version integer, p_units jsonb'
            -- CR-009 (008) thêm p_local_ship_vnd ở cuối
            || case when to_regprocedure('public.set_lot_local_ship(uuid, bigint, int)') is not null then ', p_local_ship_vnd bigint' else '' end || ') | '
            || 'return_order(p_order_id uuid, p_keep_deposit boolean, p_return_ship_fee_vnd bigint, p_returned_at date, p_note text, p_expected_version integer) | '
            || 'set_order_cod(p_order_id uuid, p_cod_amount_vnd bigint, p_expected_version integer) | '
            || 'ship_order(p_order_id uuid, p_tracking_no text, p_shipped_at date, p_expected_version integer, p_cod_amount_vnd bigint)',
            'CR-004: mỗi RPC đúng 1 chữ ký (receive_lot, ship_order thêm tham số cuối; return_order, set_order_cod mới)');
select t.ok((select bool_and(has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                             and p.prosecdef and p.proconfig @> array['search_path=""'])
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('receive_lot','ship_order','return_order','set_order_cod','update_unit','save_order')),
            'CR-004: RPC mới / đổi: authenticated gọi được, anon không; SECURITY DEFINER + search_path rỗng');
select t.ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class
              where relname in ('v_units','v_lot_summary','v_order_summary')), 'CR-004: view vẫn security_invoker = true');
select t.ok(has_column_privilege('authenticated', 'public.payments', 'method', 'insert')
            and has_column_privilege('authenticated', 'public.settings', 'aging_warn_days', 'update')
            and has_column_privilege('authenticated', 'public.orders', 'cod_amount_vnd', 'select')
            and not has_column_privilege('authenticated', 'public.orders', 'cod_amount_vnd', 'update')
            and not has_column_privilege('authenticated', 'public.orders', 'keep_deposit', 'update')
            and not has_column_privilege('authenticated', 'public.units', 'condition', 'update'),
            'CR-004: quyền cột: ghi trực tiếp payments.method / settings.aging_*; orders COD / hoàn hàng, units.condition chỉ qua RPC');

-- ========== 11. RLS cột mới ==========
set role authenticated;
select t.err(format('update public.orders set cod_amount_vnd = 1 where id = %L', :'o3'), '42501', 'CR-004: client không ghi trực tiếp orders.cod_amount_vnd');
select t.err(format('update public.orders set status = %L, returned_at = now() where id = %L', 'returned', :'o4'), '42501',
             'CR-004: client không tự chuyển đơn sang Hoàn hàng');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select t.eq((select count(*) from public.v_order_summary where order_id in (:'o1', :'o3', :'o5'))::int
            + (select count(*) from public.payments where order_id in (:'o1', :'o3', :'o5'))::int
            + (select count(*) from public.v_units where unit_id in (:'g_u1', :'g_k1'))::int
            + (select count(*) from public.v_lot_summary where lot_id = :'l4')::int, 0,
            'CR-004 RLS: user 2 không thấy đơn / khoản thu / chiếc / lô của user 4');
select t.err(format('select public.return_order(%L, true, 0)', :'o4'), 'ORDER_NOT_FOUND', 'CR-004 RLS: user 2 return_order đơn user 4 → ORDER_NOT_FOUND');
select t.err(format('select public.set_order_cod(%L, 0)', :'o4'), 'ORDER_NOT_FOUND', 'CR-004 RLS: user 2 set_order_cod đơn user 4 → ORDER_NOT_FOUND');
select t.err(format('select public.receive_lot(%L, 0, null, null, %L)', :'l4', '[]'), 'LOT_NOT_FOUND', 'CR-004 RLS: user 2 receive_lot lô user 4 → LOT_NOT_FOUND');
update public.settings set aging_warn_days = 5 where user_id = '44444444-4444-4444-4444-444444444444';
update public.payments set method = 'cash' where order_id = :'o3';
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select t.eq((select aging_warn_days from public.settings)::text || '/'
            || (select string_agg(method, ',' order by created_at) from public.payments where order_id = :'o3'), '30/transfer,transfer,transfer',
            'CR-004 RLS: user 2 không sửa được cài đặt / hình thức thu của user 4');
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select t.err($$select public.return_order(gen_random_uuid(), true, 0)$$, '42501', 'CR-004: anon không gọi return_order');
select t.err($$select public.set_order_cod(gen_random_uuid(), 0)$$, '42501', 'CR-004: anon không gọi set_order_cod');
select t.err('select count(*) from public.v_order_summary', '42501', 'CR-004: anon không đọc v_order_summary');
reset role;
