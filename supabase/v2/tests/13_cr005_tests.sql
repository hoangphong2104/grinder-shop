-- Test CR-005 (phần dữ liệu): trạng thái lô mới, trả trung gian theo lô (pay_lot, save_lot paid_now), sổ quỹ (trigger tự sinh +
-- ghi tay + RLS), delete_order, cài đặt VietQR, vốn đang về. Chạy trên DB đã có CR-005 (cài mới 001, hoặc DB thật mô phỏng + 005).
-- Dùng user thử 5 riêng. Ngày tính lùi từ private.today_vn() ⇒ không phụ thuộc ngày chạy.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'u5@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);
select public.bootstrap_user();
select id as h_zp6 from public.models where code_prefix = 'ZP6' \gset
select id as h_ku  from public.models where code_prefix = 'KU'  \gset
select (private.today_vn() - 40)::text as d40, (private.today_vn() - 30)::text as d30, (private.today_vn() - 20)::text as d20,
       (private.today_vn() - 10)::text as d10, (private.today_vn() - 5)::text as d5, (private.today_vn() - 3)::text as d3,
       private.today_vn()::text as d0 \gset

-- ========== 1. Trạng thái lô (Kho TQ → Kho VN → Kho Lumi) ==========
-- A: 2 × ZP6 ¥1.000, tỷ giá 3.600, phí 0%, đặt d40, KHÔNG gửi status ⇒ cn_warehouse; tạm tính mỗi chiếc 3.600.000
select x->>'lot_id' as la from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d40', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'h_zp6', 'qty', 2, 'price_cny', 1000, 'list_price_vnd', 5000000))) x) s \gset
select t.eq((select status from public.lots where id = :'la'), 'cn_warehouse', 'CR-005: lô mới không gửi status ⇒ Kho TQ (cn_warehouse)');
-- B: gửi mã cũ 'vn_shipping' (app cũ) ⇒ vn_warehouse
select x->>'lot_id' as lb from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d30', 'status', 'vn_shipping', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'h_ku', 'qty', 1, 'price_cny', 1500))) x) s \gset
select t.eq((select status from public.lots where id = :'lb'), 'vn_warehouse', 'CR-005: save_lot nhận mã cũ vn_shipping ⇒ vn_warehouse');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600,"status":"received"}',
             jsonb_build_array(jsonb_build_object('model_id', :'h_zp6', 'qty', 1, 'price_cny', 1))), 'INVALID_STATUS_FOR_SAVE',
             'CR-005: save_lot status received → INVALID_STATUS_FOR_SAVE');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600,"status":"kho_lumi"}',
             jsonb_build_array(jsonb_build_object('model_id', :'h_zp6', 'qty', 1, 'price_cny', 1))), 'INVALID_STATUS_FOR_SAVE',
             'CR-005: save_lot status lạ → INVALID_STATUS_FOR_SAVE');
-- Sửa lô B không gửi status ⇒ giữ vn_warehouse
select public.save_lot(:'lb', jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d30', 'note', 'sửa ghi chú'),
    jsonb_build_array(jsonb_build_object('unit_id', (select id from public.units where lot_id = :'lb'))));
select t.eq((select status || '/' || note from public.lots where id = :'lb'), 'vn_warehouse/sửa ghi chú', 'CR-005: sửa lô thiếu khoá status ⇒ giữ trạng thái');
-- set_lot_status: chỉ đi tới
select t.err(format('select public.set_lot_status(%L, %L)', :'lb', 'cn_warehouse'), 'INVALID_STATUS_TRANSITION',
             'CR-005: set_lot_status Kho VN → Kho TQ (lùi) → INVALID_STATUS_TRANSITION');
select version as la_v from public.lots where id = :'la' \gset
select public.set_lot_status(:'la', 'at_forwarder');
select t.eq((select status || '/' || (version = :la_v) from public.lots where id = :'la'), 'cn_warehouse/true',
            'CR-005: set_lot_status mã cũ at_forwarder = Kho TQ, đang Kho TQ ⇒ không đổi, không tăng version');
select t.eq((select public.set_lot_status(:'la', 'vn_warehouse', :la_v)->>'status'), 'vn_warehouse', 'CR-005: set_lot_status Kho TQ → Kho VN');
select t.err(format('select public.set_lot_status(%L, %L)', :'la', 'received'), 'INVALID_STATUS_FOR_SAVE',
             'CR-005: set_lot_status received → INVALID_STATUS_FOR_SAVE (nhận hàng = receive_lot)');
select t.err(format('select public.set_lot_status(%L, %L, 1)', :'la', 'vn_warehouse'), 'VERSION_CONFLICT', 'CR-005: set_lot_status version cũ → VERSION_CONFLICT');
reset role;
select t.err(format('update public.lots set status = %L where id = %L', 'ordered', :'la'), '23514', 'CR-005: mã cũ ordered bị check chặn');
set role authenticated;
-- C: nhận thẳng từ Kho TQ (Q-011: từ mọi trạng thái mở)
select x->>'lot_id' as lc from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d20', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'h_ku', 'qty', 1, 'price_cny', 1000, 'list_price_vnd', 4500000))) x) s \gset
select public.receive_lot(:'lc', 0, :'d10');
select t.eq((select status from public.lots where id = :'lc'), 'received', 'CR-005: receive_lot từ Kho TQ ⇒ Kho Lumi (received)');
select t.err(format('select public.set_lot_status(%L, %L)', :'lc', 'vn_warehouse'), 'LOT_LOCKED', 'CR-005: set_lot_status lô đã nhận → LOT_LOCKED');
select t.eq((select is_lot_late::text from public.v_lot_summary where lot_id = :'la'), 'true', 'CR-005: lô Kho VN đặt 40 ngày ⇒ về trễ');
select t.eq((select is_lot_late::text from public.v_lot_summary where lot_id = :'lc'), 'false', 'CR-005: lô đã nhận ⇒ không trễ');

-- ========== 2. Trả trung gian theo lô ==========
-- D: 2 × ZP6 ¥1.000 tỷ giá 3.600, ship chưa biết, paid_now ⇒ khoản Đã chuyển 7.200.000 gắn lô, ngày = ngày đặt d20
select x::text as rd from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d20', 'buying_fee_pct', 0, 'paid_now', true),
    jsonb_build_array(jsonb_build_object('model_id', :'h_zp6', 'qty', 2, 'price_cny', 1000))) x) s \gset
select (:'rd')::jsonb->>'lot_id' as ld \gset
select t.eq((select kind || ':' || amount_vnd || ':' || txn_date || ':' || (id::text = (:'rd')::jsonb->>'paid_txn_id')
               from public.intermediary_txns where lot_id = :'ld' and kind = 'transfer'), 'transfer:7200000:' || :'d20' || ':true',
            'CR-005: save_lot paid_now ⇒ Đã chuyển 7.200.000 gắn lô, ngày đặt, trả paid_txn_id');
select t.eq((select payable_vnd || '/' || paid_vnd || '/' || outstanding_vnd from public.v_lot_summary where lot_id = :'ld'), '7200000/7200000/0',
            'CR-005: v_lot_summary lô D: phải trả 7.200.000, đã trả 7.200.000, còn nợ 0');
select t.eq(((:'rd')::jsonb->>'outstanding_vnd'), '0', 'CR-005: save_lot trả outstanding_vnd');
select t.eq((select direction || ':' || kind || ':' || amount_vnd || ':' || entry_date || ':' || (lot_id = :'ld') || ':' || is_auto
               from public.cash_entries where txn_id = ((:'rd')::jsonb->>'paid_txn_id')::uuid),
            'out:intermediary:7200000:' || :'d20' || ':true:true', 'CR-005: sổ quỹ tự ghi tiền ra trả trung gian (gắn lô)');
select t.err(format('select public.pay_lot(%L)', :'ld'), 'LOT_ALREADY_PAID', 'CR-005: pay_lot khi lô hết nợ → LOT_ALREADY_PAID');
-- Sửa lô D với paid_now ⇒ bỏ qua (không trả thêm)
select public.save_lot(:'ld', jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d20', 'paid_now', true),
    (select jsonb_agg(jsonb_build_object('unit_id', id)) from public.units where lot_id = :'ld'));
select t.eq((select count(*) from public.intermediary_txns where lot_id = :'ld' and kind = 'transfer')::int, 1, 'CR-005: paid_now khi SỬA lô bị bỏ qua');
-- Nhận lô với ship 400.000 ⇒ phải trả 7.600.000, còn nợ 400.000 (= ship) ⇒ "Đã thanh toán ship"
select public.receive_lot(:'ld', 400000, :'d10');
select t.eq((select payable_vnd || '/' || outstanding_vnd from public.v_lot_summary where lot_id = :'ld'), '7600000/400000',
            'CR-005: nhập ship sau ⇒ còn nợ = ship 400.000');
select t.err(format('select public.pay_lot(%L, null, %L)', :'ld', repeat('x', 1001)), 'INVALID_INPUT', 'CR-005: pay_lot ghi chú > 1000 → INVALID_INPUT');
select x::text as rp from (select public.pay_lot(:'ld', :'d5', '  Trả ship lô D  ') x) s \gset
select t.eq((:'rp')::jsonb->>'amount_vnd' || '/' || ((:'rp')::jsonb->>'paid_vnd') || '/' || ((:'rp')::jsonb->>'outstanding_vnd'), '400000/7600000/0',
            'CR-005: pay_lot trả đúng phần còn nợ 400.000');
select t.eq((select txn_date || '/' || note || '/' || lot_id from public.intermediary_txns where id = ((:'rp')::jsonb->>'txn_id')::uuid),
            :'d5' || '/Trả ship lô D/' || :'ld', 'CR-005: pay_lot ghi ngày + ghi chú (đã cắt khoảng trắng) + lô');
select t.eq((select outstanding_vnd from public.v_lot_summary where lot_id = :'ld'), 0::bigint, 'CR-005: sau pay_lot còn nợ 0');
select t.err(format('select public.pay_lot(%L)', :'ld'), 'LOT_ALREADY_PAID', 'CR-005: pay_lot lần 2 → LOT_ALREADY_PAID');
-- Lô A chưa trả: pay_lot mặc định hôm nay, không ghi chú
select t.eq((select public.pay_lot(:'la')->>'amount_vnd'), '7200000', 'CR-005: pay_lot lô A (chưa trả) = 7.200.000');
select t.eq((select txn_date::text || '/' || coalesce(note, '-') from public.intermediary_txns where lot_id = :'la' and kind = 'transfer'), :'d0' || '/-',
            'CR-005: pay_lot mặc định ngày hôm nay, ghi chú null');
-- Lô huỷ / lô không tồn tại
select x->>'lot_id' as le from (select public.save_lot(null, '{"exchange_rate":3600}',
    jsonb_build_array(jsonb_build_object('model_id', :'h_ku', 'qty', 1, 'price_cny', 10))) x) s \gset
select public.cancel_lot(:'le');
select t.err(format('select public.pay_lot(%L)', :'le'), 'LOT_CANCELLED', 'CR-005: pay_lot lô huỷ → LOT_CANCELLED');
select t.err(format('select public.pay_lot(%L)', gen_random_uuid()), 'LOT_NOT_FOUND', 'CR-005: pay_lot lô không có → LOT_NOT_FOUND');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600,"paid_now":"yes"}',
             jsonb_build_array(jsonb_build_object('model_id', :'h_ku', 'qty', 1, 'price_cny', 10))), 'INVALID_INPUT', 'CR-005: paid_now không phải bool → INVALID_INPUT');
select t.eq((select count(*) from public.intermediary_txns where lot_id = :'lb' and kind = 'transfer')::int, 0, 'CR-005: không gửi paid_now ⇒ không trả');

-- ========== 3. Khoản Đã chuyển ghi tay ↔ sổ quỹ ==========
insert into public.intermediary_txns (txn_date, kind, amount_vnd, lot_id, note) values (:'d3', 'transfer', 1000000, :'lb', 'ứng lô B');
select id as tb from public.intermediary_txns where note = 'ứng lô B' \gset
select t.eq((select paid_vnd || '/' || outstanding_vnd from public.v_lot_summary where lot_id = :'lb'), '1000000/4400000',
            'CR-005: client ghi Đã chuyển gắn lô B ⇒ đã trả 1.000.000, còn nợ 4.400.000');
select t.eq((select amount_vnd || '/' || entry_date || '/' || (lot_id = :'lb') from public.cash_entries where txn_id = :'tb'), '1000000/' || :'d3' || '/true',
            'CR-005: Đã chuyển ghi tay ⇒ bút toán tiền ra');
update public.intermediary_txns set amount_vnd = 1200000, txn_date = :'d5' where id = :'tb';
select t.eq((select amount_vnd || '/' || entry_date from public.cash_entries where txn_id = :'tb'), '1200000/' || :'d5', 'CR-005: sửa khoản Đã chuyển ⇒ bút toán sửa theo');
update public.intermediary_txns set amount_vnd = 0 where id = :'tb';
select t.eq((select count(*) from public.cash_entries where txn_id = :'tb')::int, 0, 'CR-005: khoản Đã chuyển về 0 ₫ ⇒ bỏ bút toán');
update public.intermediary_txns set amount_vnd = 1000000 where id = :'tb';
delete from public.intermediary_txns where id = :'tb';
select t.eq((select count(*) from public.cash_entries where txn_id = :'tb')::int, 0, 'CR-005: xoá khoản Đã chuyển ⇒ xoá bút toán');
select t.err(format('insert into public.intermediary_txns (kind, amount_vnd, lot_id) values (%L, 1, %L)', 'adjustment', :'lb'), '23514',
             'CR-005: Điều chỉnh không gắn lô (itx_lot_by_kind)');
insert into public.intermediary_txns (kind, amount_vnd, note) values ('adjustment', -50000, 'giảm phí');
select t.eq((select count(*) from public.cash_entries where kind = 'intermediary' and amount_vnd = 50000)::int, 0, 'CR-005: Điều chỉnh công nợ không vào sổ quỹ');

-- ========== 4. Khoản thu khách ↔ sổ quỹ ==========
insert into public.customers (fb_name) values ('Khách sổ quỹ');
select id as h_c from public.customers where fb_name = 'Khách sổ quỹ' \gset
select id as ha1 from public.units where lot_id = :'la' order by code limit 1 \gset
select id as hc1 from public.units where lot_id = :'lc' \gset
select id as hd1 from public.units where lot_id = :'ld' order by code limit 1 \gset
select id as hd2 from public.units where lot_id = :'ld' order by code limit 1 offset 1 \gset
-- O1: KU (lô C, đã về) giá 4.500.000, ship 30.000 SHOP chịu, cọc 1.000.000 ngày d10
select x->>'order_id' as o1, x->>'deposit_payment_id' as o1_dep from (select public.save_order(null,
    jsonb_build_object('customer_id', :'h_c', 'order_date', :'d10', 'ship_fee_vnd', 30000, 'ship_fee_payer', 'shop', 'deposit_vnd', 1000000),
    jsonb_build_array(jsonb_build_object('unit_id', :'hc1', 'unit_price_vnd', 4500000))) x) s \gset
select t.eq((select direction || ':' || kind || ':' || amount_vnd || ':' || entry_date || ':' || (order_id = :'o1') from public.cash_entries where payment_id = :'o1_dep'),
            'in:customer_payment:1000000:' || :'d10' || ':true', 'CR-005: cọc khi tạo đơn ⇒ tiền vào');
insert into public.payments (order_id, paid_at, kind, amount_vnd, note) values (:'o1', :'d5', 'payment', 3500000, 'CK');
select id as o1_pay from public.payments where order_id = :'o1' and kind = 'payment' \gset
select t.eq((select direction || ':' || amount_vnd || ':' || note from public.cash_entries where payment_id = :'o1_pay'), 'in:3500000:CK',
            'CR-005: client ghi thanh toán ⇒ tiền vào (kèm ghi chú)');
update public.payments set amount_vnd = 3600000, paid_at = :'d3' where id = :'o1_pay';
select t.eq((select amount_vnd || '/' || entry_date from public.cash_entries where payment_id = :'o1_pay'), '3600000/' || :'d3', 'CR-005: sửa khoản thu ⇒ bút toán theo');
insert into public.payments (order_id, kind, amount_vnd) values (:'o1', 'refund', 100000);
select id as o1_ref from public.payments where order_id = :'o1' and kind = 'refund' \gset
select t.eq((select direction || ':' || kind || ':' || amount_vnd from public.cash_entries where payment_id = :'o1_ref'), 'out:customer_refund:100000',
            'CR-005: hoàn tiền khách ⇒ tiền ra');
update public.payments set kind = 'payment' where id = :'o1_ref';
select t.eq((select direction || ':' || kind from public.cash_entries where payment_id = :'o1_ref'), 'in:customer_payment', 'CR-005: đổi loại khoản thu ⇒ bút toán đổi chiều');
delete from public.payments where id = :'o1_ref';
select t.eq((select count(*) from public.cash_entries where payment_id = :'o1_ref')::int, 0, 'CR-005: xoá khoản thu ⇒ xoá bút toán');

-- ========== 5. Ship shop chịu / ship chiều về ==========
select t.eq((select count(*) from public.cash_entries where order_id = :'o1' and kind = 'ship_shop')::int, 0, 'CR-005: đơn chưa gửi ⇒ chưa ghi ship');
select public.ship_order(p_order_id => :'o1', p_shipped_at => :'d5');
select t.eq((select direction || ':' || amount_vnd || ':' || entry_date from public.cash_entries where order_id = :'o1' and kind = 'ship_shop'),
            'out:30000:' || :'d5', 'CR-005: gửi đơn shop chịu ship ⇒ tiền ra 30.000 ngày gửi');
select public.complete_order(:'o1', true);
select t.eq((select count(*) from public.cash_entries where order_id = :'o1' and kind = 'ship_shop')::int, 1, 'CR-005: hoàn tất không ghi ship lần 2');
-- O2: ZP6 (lô D, đã về) khách trả ship ⇒ không ghi ship; khách bom ⇒ hoàn hàng, ship về 25.000
select x->>'order_id' as o2 from (select public.save_order(null,
    jsonb_build_object('customer_id', :'h_c', 'order_date', :'d5', 'ship_fee_vnd', 40000, 'ship_fee_payer', 'customer'),
    jsonb_build_array(jsonb_build_object('unit_id', :'hd1', 'unit_price_vnd', 5000000))) x) s \gset
select public.ship_order(p_order_id => :'o2', p_shipped_at => :'d5');
select t.eq((select count(*) from public.cash_entries where order_id = :'o2')::int, 0, 'CR-005: khách trả ship ⇒ không ghi ship vào quỹ');
select public.return_order(:'o2', false, 25000, :'d3');
select t.eq((select direction || ':' || kind || ':' || amount_vnd || ':' || entry_date from public.cash_entries where order_id = :'o2'),
            'out:return_ship:25000:' || :'d3', 'CR-005: hoàn hàng ⇒ tiền ra ship chiều về 25.000 ngày hoàn');
-- O3: ZP6 còn lại, shop chịu ship 35.000, gửi rồi hoàn hàng ship về 0 ⇒ chỉ ship đi
select x->>'order_id' as o3 from (select public.save_order(null,
    jsonb_build_object('customer_id', :'h_c', 'order_date', :'d5', 'ship_fee_vnd', 35000, 'ship_fee_payer', 'shop'),
    jsonb_build_array(jsonb_build_object('unit_id', :'hd2', 'unit_price_vnd', 5000000))) x) s \gset
select public.ship_order(p_order_id => :'o3', p_shipped_at => :'d3');
select public.return_order(:'o3', false, 0, :'d0');
select t.eq((select string_agg(kind || ':' || amount_vnd, ',' order by kind) from public.cash_entries where order_id = :'o3'), 'ship_shop:35000',
            'CR-005: hoàn hàng ship về 0 ⇒ chỉ còn ship đi shop chịu');

-- ========== 6. Bút toán ghi tay + RLS ==========
insert into public.cash_entries (entry_date, direction, amount_vnd, kind, note) values (:'d40', 'in', 50000000, 'capital_in', 'Vốn ban đầu');
insert into public.cash_entries (entry_date, direction, amount_vnd, kind, expense_category, note) values (:'d3', 'out', 120000, 'expense', 'Đóng gói', 'Hộp carton');
insert into public.cash_entries (direction, amount_vnd, kind) values ('out', 2000000, 'capital_out');
insert into public.cash_entries (direction, amount_vnd, kind, note) values ('in', 5000, 'adjustment', 'lệch quỹ');
select t.eq((select string_agg(kind || ':' || direction || ':' || is_auto || ':' || (user_id = auth.uid()), ',' order by kind)
               from public.cash_entries where not is_auto), 'adjustment:in:false:true,capital_in:in:false:true,capital_out:out:false:true,expense:out:false:true',
            'CR-005: ghi tay nạp vốn / rút vốn / chi phí / điều chỉnh (is_auto false, user_id tự gán)');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind) values ('in', 1, 'expense')$$, '23514', 'CR-005: chi phí phải là tiền ra');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind) values ('out', 1, 'capital_in')$$, '23514', 'CR-005: nạp vốn phải là tiền vào');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind) values ('out', 0, 'expense')$$, '23514', 'CR-005: số tiền 0 bị chặn');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind, expense_category) values ('in', 1, 'capital_in', 'x')$$, '23514',
             'CR-005: loại chi phí chỉ cho kind expense');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind) values ('in', 1, 'customer_payment')$$, '42501',
             'CR-005: client không tự ghi bút toán loại tự sinh (RLS)');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind, is_auto) values ('in', 1, 'capital_in', true)$$, '42501',
             'CR-005: client không đặt is_auto (quyền theo cột)');
select t.err(format('insert into public.cash_entries (direction, amount_vnd, kind, order_id) values (%L, 1, %L, %L)', 'out', 'expense', :'o1'), '42501',
             'CR-005: client không đặt liên kết nguồn (order_id)');
select t.err($$insert into public.cash_entries (direction, amount_vnd, kind, user_id) values ('in', 1, 'capital_in', '11111111-1111-1111-1111-111111111111')$$,
             '42501', 'CR-005: client không tự đặt user_id');
update public.cash_entries set amount_vnd = 150000 where kind = 'expense';
select t.eq((select amount_vnd || '/' || version from public.cash_entries where kind = 'expense'), '150000/2', 'CR-005: sửa bút toán ghi tay (version tự tăng)');
select t.err($$update public.cash_entries set version = 99 where kind = 'expense'$$, '42501', 'CR-005: không ghi trực tiếp version');
select t.err($$update public.cash_entries set kind = 'customer_payment', direction = 'in' where kind = 'expense'$$, '42501',
             'CR-005: không đổi bút toán ghi tay thành loại tự sinh (RLS with check)');
update public.cash_entries set amount_vnd = 1 where payment_id = :'o1_pay';
delete from public.cash_entries where payment_id = :'o1_dep';
select t.eq((select string_agg(amount_vnd::text, ',' order by amount_vnd) from public.cash_entries where payment_id in (:'o1_pay', :'o1_dep')), '1000000,3600000',
            'CR-005: bút toán tự sinh không sửa / xoá tay được (RLS lọc 0 dòng)');
delete from public.cash_entries where kind = 'adjustment';
select t.eq((select count(*) from public.cash_entries where kind = 'adjustment')::int, 0, 'CR-005: xoá bút toán ghi tay');

-- ========== 7. Số dư quỹ ==========
-- vào: cọc 1.000.000 + thanh toán 3.600.000 + nạp vốn 50.000.000 = 54.600.000
-- ra : trả trung gian 7.200.000 (D) + 400.000 (ship D) + 7.200.000 (A) + ship O1 30.000 + ship về O2 25.000 + ship O3 35.000
--      + chi phí 150.000 + rút vốn 2.000.000 = 17.040.000 ⇒ số dư 37.560.000
select t.eq((select total_in_vnd || '/' || total_out_vnd || '/' || balance_vnd || '/' || entry_count from public.v_cash_balance),
            '54600000/17040000/37560000/11', 'CR-005: v_cash_balance vào 54.600.000, ra 17.040.000, số dư 37.560.000 (11 bút toán)');
select t.eq((select sum(net_vnd)::bigint || '/' || sum(in_vnd)::bigint || '/' || sum(out_vnd)::bigint from public.v_cash_monthly), '37560000/54600000/17040000',
            'CR-005: Σ v_cash_monthly khớp số dư');
select t.eq((select (sum(customer_in_vnd) - sum(refund_out_vnd) - sum(intermediary_out_vnd) - sum(ship_out_vnd) - sum(expense_out_vnd)
                    + sum(capital_in_vnd) - sum(capital_out_vnd) + sum(adjustment_net_vnd))::bigint from public.v_cash_monthly), 37560000::bigint,
            'CR-005: tách theo loại cộng lại = ròng');
select t.eq((select sum(ship_out_vnd)::bigint || '/' || sum(intermediary_out_vnd)::bigint from public.v_cash_monthly), '90000/14800000',
            'CR-005: v_cash_monthly ship (đi + về) 90.000, trả trung gian 14.800.000');

-- ========== 8. Vốn đang về (v_model_stock) ==========
-- ZP6: lô A (Kho VN, 2 chiếc tạm tính 3.600.000) ⇒ đang về 7.200.000; trong kho: 2 chiếc lô D (3.800.000, đơn hoàn hàng nhả) = 7.600.000
select t.eq((select stock_value_vnd || '/' || incoming_value_vnd || '/' || total_capital_vnd from public.v_model_stock where model_id = :'h_zp6'),
            '7600000/7200000/14800000', 'CR-005: ZP6 vốn trong kho 7.600.000 + đang về 7.200.000 = 14.800.000');
-- KU: lô B (1 chiếc 5.400.000 đang về, Kho VN) + lô C (đã bán) + lô E (huỷ, không tính) ⇒ đang về 5.400.000, trong kho 0
-- Đặt trước chiếc lô B (chưa về): vẫn tính vào vốn đang về
select public.save_order(null, jsonb_build_object('customer_id', :'h_c'), jsonb_build_array(jsonb_build_object('unit_id', (select id from public.units where lot_id = :'lb'), 'unit_price_vnd', 7000000)));
select t.eq((select stock_value_vnd || '/' || incoming_value_vnd || '/' || total_capital_vnd || '/' || reserved_count from public.v_model_stock where model_id = :'h_ku'),
            '0/5400000/5400000/1', 'CR-005: KU đang về 5.400.000 gồm chiếc đã giữ cho đơn đặt trước; lô huỷ / đã bán không tính');

-- ========== 9. Xoá đơn ==========
select version as o1_v from public.orders where id = :'o1' \gset
select t.err(format('select public.delete_order(%L, %s)', :'o1', :o1_v - 1), 'VERSION_CONFLICT', 'CR-005: delete_order version cũ → VERSION_CONFLICT');
select t.err(format('select public.delete_order(%L)', gen_random_uuid()), 'ORDER_NOT_FOUND', 'CR-005: delete_order đơn không có → ORDER_NOT_FOUND');
select x::text as rdel from (select public.delete_order(:'o1', :o1_v) x) s \gset
select t.eq((:'rdel')::jsonb->>'status' || '/' || jsonb_array_length((:'rdel')::jsonb->'deleted_payment_ids') || '/' || ((:'rdel')::jsonb->>'deleted_cash_entry_count'),
            'completed/2/3', 'CR-005: delete_order đơn Hoàn tất: xoá 2 khoản thu + 3 bút toán (cọc, thanh toán, ship)');
select t.eq((:'rdel')::jsonb->'released_unit_ids', jsonb_build_array(:'hc1'), 'CR-005: delete_order trả chiếc được nhả');
select t.eq((select count(*) from public.orders where id = :'o1')::int + (select count(*) from public.order_lines where order_id = :'o1')::int
            + (select count(*) from public.payments where order_id = :'o1')::int + (select count(*) from public.cash_entries where order_id = :'o1')::int
            + (select count(*) from public.cash_entries where payment_id in (:'o1_pay', :'o1_dep'))::int, 0,
            'CR-005: đơn, dòng đơn, khoản thu, bút toán của đơn đều đã xoá');
select t.eq((select status || '/' || coalesce(holding_order_id::text, 'null') from public.v_units where unit_id = :'hc1'), 'in_stock/null',
            'CR-005: chiếc của đơn đã xoá về Kho Lumi, bán lại được');
select t.eq((select balance_vnd from public.v_cash_balance), 37560000::bigint - 4600000 + 30000, 'CR-005: số dư quỹ bỏ tiền thu + ship của đơn đã xoá');
-- Xoá đơn Đặt trước (chưa có tiền) + đơn Hoàn hàng
select t.eq((select public.delete_order(o.id)->>'status' from public.orders o where o.status = 'preorder' and o.user_id = auth.uid()), 'preorder',
            'CR-005: xoá đơn Đặt trước');
select t.eq((select public.delete_order(:'o2')->>'deleted_cash_entry_count'), '1', 'CR-005: xoá đơn Hoàn hàng ⇒ xoá bút toán ship chiều về');
select t.eq((select count(*) from public.orders where user_id = auth.uid())::int, 1, 'CR-005: còn 1 đơn (O3)');

-- ========== 10. Cài đặt VietQR ==========
update public.settings set bank_bin = '970436', bank_account_no = '0123456789', bank_account_name = 'NGUYEN VAN A';
select t.eq((select bank_bin || '/' || bank_account_no || '/' || bank_account_name from public.settings), '970436/0123456789/NGUYEN VAN A',
            'CR-005: lưu ngân hàng (BIN) + số TK + tên TK');
select t.err($$update public.settings set bank_bin = '97043'$$, '23514', 'CR-005: BIN không đủ 6 số bị chặn');
select t.err($$update public.settings set bank_bin = '97043A'$$, '23514', 'CR-005: BIN có chữ bị chặn');
select t.err($$update public.settings set bank_account_no = '0123 456'$$, '23514', 'CR-005: số TK có khoảng trắng bị chặn');
select t.err($$update public.settings set bank_account_no = '01234567890123456789'$$, '23514', 'CR-005: số TK > 19 ký tự bị chặn');
select t.err($$update public.settings set bank_account_name = '   '$$, '23514', 'CR-005: tên TK rỗng bị chặn');
select t.err(format('update public.settings set bank_account_name = %L', repeat('A', 51)), '23514', 'CR-005: tên TK > 50 ký tự bị chặn');
update public.settings set bank_bin = null, bank_account_no = null, bank_account_name = null;
select t.ok((select bank_bin is null and bank_account_no is null from public.settings), 'CR-005: xoá cấu hình VietQR (null) được');

-- ========== 11. Cách ly + anon ==========
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select t.eq((select count(*) from public.cash_entries)::int + (select count(*) from public.v_cash_monthly)::int, 0,
            'CR-005: user 2 không thấy sổ quỹ user 5');
select t.eq((select count(*) from public.v_cash_balance where user_id = '55555555-5555-5555-5555-555555555555')::int, 0, 'CR-005: user 2 không thấy số dư user 5');
delete from public.cash_entries where kind = 'capital_in';
select t.err(format('select public.pay_lot(%L)', :'lb'), 'LOT_NOT_FOUND', 'CR-005: pay_lot lô của người khác → LOT_NOT_FOUND');
select t.err(format('select public.delete_order(%L)', :'o3'), 'ORDER_NOT_FOUND', 'CR-005: delete_order đơn của người khác → ORDER_NOT_FOUND');
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);
select t.eq((select count(*) from public.cash_entries where kind = 'capital_in')::int, 1, 'CR-005: user 2 không xoá được bút toán user 5');
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select t.err('select count(*) from public.cash_entries', '42501', 'CR-005: anon không đọc cash_entries');
select t.err('select count(*) from public.v_cash_balance', '42501', 'CR-005: anon không đọc v_cash_balance');
select t.err($$select public.pay_lot(gen_random_uuid())$$, '42501', 'CR-005: anon không gọi pay_lot');
select t.err($$select public.delete_order(gen_random_uuid())$$, '42501', 'CR-005: anon không gọi delete_order');
set role authenticated;
select t.err($$select private.cash_sync_payment(gen_random_uuid())$$, '42501', 'CR-005: không gọi được hàm private sổ quỹ');
reset role;
select t.ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('pay_lot','delete_order'))
                 or (n.nspname = 'private' and p.proname like 'cash\_%')), 'CR-005: RPC + hàm sổ quỹ SECURITY DEFINER + search_path rỗng');
select t.ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class where relname in ('v_cash_balance','v_cash_monthly')),
            'CR-005: view sổ quỹ security_invoker = true');
select t.ok((select relrowsecurity from pg_class where oid = 'public.cash_entries'::regclass), 'CR-005: RLS bật trên cash_entries');
select t.ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'cash_entries'), 'CR-005: realtime có cash_entries');
