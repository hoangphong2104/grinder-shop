-- Test CR-003 "Phí mua hộ" (CR file §7). Chạy trên DB đã có CR-003 (cài mới 001, hoặc v2 cũ + 002_buying_fee.sql).
-- Dùng user thử 3 riêng (không đụng dữ liệu test 03). Mỗi kiểm tra in "PASS: ..."; sai thì "FAIL: ..." và dừng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'u3@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select public.bootstrap_user();
select id as f_zp6 from public.models where code_prefix = 'ZP6' \gset
select id as f_ku  from public.models where code_prefix = 'KU'  \gset

-- ========== 1. Cài đặt: phí mua hộ mặc định ==========
select t.eq((select default_buying_fee_pct from public.settings), 0::numeric, 'CR-003: settings.default_buying_fee_pct mặc định 0');
update public.settings set default_buying_fee_pct = 3;      -- client sửa trực tiếp (grant cả bảng settings)
select t.eq((select default_buying_fee_pct::text from public.settings), '3.00', 'CR-003: client đặt phí mặc định 3%');
select t.err($$update public.settings set default_buying_fee_pct = 100.01$$, '23514', 'CR-003: phí mặc định > 100 bị chặn');
select t.err($$update public.settings set default_buying_fee_pct = -1$$, '23514', 'CR-003: phí mặc định < 0 bị chặn');

-- ========== 2. Lô 2 × ¥1.010, tỷ giá 3.600, KHÔNG gửi phí ⇒ lấy mặc định 3% ==========
select x->>'lot_id' as f_lot, x->>'payable_vnd' as f_lot_pay from (
  select public.save_lot(null, jsonb_build_object('exchange_rate', 3600),
    jsonb_build_array(jsonb_build_object('model_id', :'f_zp6', 'qty', 2, 'price_cny', 1010))) x) s \gset
select t.eq((select buying_fee_pct::text from public.lots where id = :'f_lot'), '3.00', 'CR-003: lô mới không gửi phí ⇒ lấy mặc định settings 3%');
select t.eq((select string_agg(cost_vnd_auto::text, ',') from public.units where lot_id = :'f_lot'), '3745080,3745080',
            'CR-003: chưa ship: giá tạm = round(1010×3600×1,03) = 3.745.080');
select t.eq(:'f_lot_pay', '7490160', 'CR-003: save_lot trả phải trả tạm = round(2020×3600×1,03) = 7.490.160');
select t.eq((select goods_vnd::text || '/' || buying_fee_pct || '/' || buying_fee_vnd || '/' || payable_vnd
               from public.v_lot_summary where lot_id = :'f_lot'), '7272000/3.00/218160/7490160',
            'CR-003: v_lot_summary tiền hàng 7.272.000 (chưa gồm phí) / 3% / phí 218.160 / phải trả 7.490.160');

-- ========== 3. Nhận lô, ship 600.000 ⇒ 4.045.080 / chiếc, phải trả 8.090.160 ==========
select x::text as f_recv from (select public.receive_lot(:'f_lot', 600000, '2026-10-20') x) s \gset
select t.eq((select string_agg(cost_vnd_auto::text, ',') from public.units where lot_id = :'f_lot'), '4045080,4045080',
            'CR-003: giá nhập tự tính = round(1010×3600×1,03 + 600000÷2) = 4.045.080');
select t.eq((:'f_recv')::jsonb->>'payable_vnd', '8090160', 'CR-003: phải trả = round(2020×3600×1,03 + 600000) = 8.090.160');
select t.eq((select amount_vnd from public.intermediary_txns where lot_id = :'f_lot' and kind = 'payable'), 8090160::bigint,
            'CR-003: khoản Phải trả trung gian = 8.090.160');
select t.eq((select string_agg(cost_vnd::text, ',') from public.v_units where lot_id = :'f_lot'), '4045080,4045080',
            'CR-003: v_units giá hiệu lực 4.045.080');

-- ========== 4. Giá sửa tay không bị phí / ship ảnh hưởng ==========
select id as f_u1 from public.units where lot_id = :'f_lot' order by code limit 1 \gset
select id as f_u2 from public.units where lot_id = :'f_lot' order by code desc limit 1 \gset
select public.update_unit(:'f_u2', '{"cost_vnd_override":4000000}');
select public.update_lot_ship_fee(:'f_lot', 800000);
select t.eq((select cost_vnd_auto::text || '/' || cost_vnd from public.v_units where unit_id = :'f_u1'), '4145080/4145080',
            'CR-003: đổi ship 800.000: chiếc không sửa tay = round(3.745.080 + 400.000) = 4.145.080');
select t.eq((select cost_vnd_auto::text || '/' || cost_vnd_override || '/' || cost_vnd from public.v_units where unit_id = :'f_u2'),
            '4145080/4000000/4000000', 'CR-003: chiếc sửa tay giữ 4.000.000 (auto vẫn cập nhật)');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'f_lot'), 8290160::bigint,
            'CR-003: phải trả = 7.490.160 + 800.000 = 8.290.160 (không theo giá sửa tay)');

-- ========== 5. Khoá phí sau khi nhận (Q-014 / A10) ==========
select t.err(format('select public.save_lot(%L, %L, %L)', :'f_lot', '{"exchange_rate":3600,"buying_fee_pct":5}',
             jsonb_build_array(jsonb_build_object('unit_id', :'f_u1'), jsonb_build_object('unit_id', :'f_u2'))),
             'LOT_LOCKED', 'CR-003: đổi phí mua hộ lô đã nhận → LOT_LOCKED');
select t.err(format('update public.lots set buying_fee_pct = 5 where id = %L', :'f_lot'), '42501',
             'CR-003: client không ghi trực tiếp lots.buying_fee_pct');
select t.eq((select buying_fee_pct::text from public.lots where id = :'f_lot'), '3.00', 'CR-003: phí lô đã nhận vẫn 3%');

-- ========== 6. Gửi phí riêng khi tạo (ghi đè mặc định), sửa khi chưa nhận ==========
select x->>'lot_id' as f_lot2 from (
  select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'buying_fee_pct', 2.5),
    jsonb_build_array(jsonb_build_object('model_id', :'f_ku', 'qty', 1, 'price_cny', 100))) x) s \gset
select t.eq((select l.buying_fee_pct::text || '/' || u.cost_vnd_auto from public.lots l join public.units u on u.lot_id = l.id
              where l.id = :'f_lot2'), '2.50/369000', 'CR-003: gửi 2,5% ⇒ lưu 2.50, giá = round(100×3600×1,025) = 369.000');
select id as f_u3 from public.units where lot_id = :'f_lot2' \gset
select public.save_lot(:'f_lot2', '{"exchange_rate":3600}', jsonb_build_array(jsonb_build_object('unit_id', :'f_u3')));
select t.eq((select buying_fee_pct::text from public.lots where id = :'f_lot2'), '2.50', 'CR-003: sửa lô không gửi phí ⇒ giữ nguyên 2,5%');
select public.save_lot(:'f_lot2', '{"exchange_rate":3600,"buying_fee_pct":0}', jsonb_build_array(jsonb_build_object('unit_id', :'f_u3')));
select t.eq((select l.buying_fee_pct::text || '/' || u.cost_vnd_auto || '/' || s.payable_vnd || '/' || s.buying_fee_vnd
               from public.lots l join public.units u on u.lot_id = l.id join public.v_lot_summary s on s.lot_id = l.id
              where l.id = :'f_lot2'), '0.00/360000/360000/0', 'CR-003: lô chưa nhận sửa phí về 0% ⇒ tính lại 360.000');
select public.save_lot(:'f_lot2', '{"exchange_rate":3600,"buying_fee_pct":"1.75"}', jsonb_build_array(jsonb_build_object('unit_id', :'f_u3')));
select t.eq((select cost_vnd_auto from public.units where id = :'f_u3'), 366300::bigint, 'CR-003: 1,75% ⇒ round(360.000 × 1,0175) = 366.300');
select t.eq((select last_buying_fee_pct::text from public.v_suggestions), '1.75', 'CR-003: v_suggestions.last_buying_fee_pct = lô gần nhất');
select x->>'lot_id' as f_lot3 from (
  select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'f_ku', 'qty', 1, 'price_cny', 100))) x) s \gset
select t.eq((select buying_fee_pct::text from public.lots where id = :'f_lot3'), '0.00', 'CR-003: gửi 0% rõ ràng ⇒ 0% (không lấy mặc định 3%)');
select t.ok((select public.cancel_lot(:'f_lot3')->>'status') = 'cancelled', 'CR-003: huỷ lô 0%');
select t.eq((select payable_vnd from public.v_lot_summary where lot_id = :'f_lot3'), 0::bigint, 'CR-003: lô huỷ ⇒ phải trả 0');

-- ========== 7. Kiểm tra đầu vào ==========
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600,"buying_fee_pct":100.01}',
             jsonb_build_array(jsonb_build_object('model_id', :'f_ku', 'qty', 1, 'price_cny', 10))), 'INVALID_AMOUNT', 'CR-003: phí > 100 → INVALID_AMOUNT');
select t.err(format('select public.save_lot(null, %L, %L)', '{"exchange_rate":3600,"buying_fee_pct":-0.5}',
             jsonb_build_array(jsonb_build_object('model_id', :'f_ku', 'qty', 1, 'price_cny', 10))), 'INVALID_AMOUNT', 'CR-003: phí âm → INVALID_AMOUNT');
select t.ok((select public.save_lot(null, '{"exchange_rate":3600,"buying_fee_pct":100}',
               jsonb_build_array(jsonb_build_object('model_id', :'f_ku', 'qty', 1, 'price_cny', 10)))->>'payable_vnd') = '72000',
            'CR-003: phí 100% hợp lệ ⇒ round(10×3600×2) = 72.000');

-- ========== 8. Lô 0% giống hệt công thức cũ ==========
select t.eq((select count(*) from public.v_lot_summary where buying_fee_pct = 0 and buying_fee_vnd <> 0)::int, 0,
            'CR-003: lô 0% ⇒ buying_fee_vnd = 0');
reset role;
