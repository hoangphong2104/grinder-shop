-- Test CR-013 (011_cn_ship_flag.sql): khoản tất toán ship TQ → VN được đánh dấu is_cn_ship; client không tự đặt cờ.
-- Dùng user thử 14 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('14141414-1414-1414-1414-141414141414', 'u14@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '14141414-1414-1414-1414-141414141414', false);
select public.bootstrap_user();
select id as m_ku from public.models where code_prefix = 'KU' \gset
select x->>'lot_id' as la from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'buying_fee_pct', 0, 'paid_now', true),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 1, 'price_cny', 1000))) x) s \gset
select t.eq((select bool_or(is_cn_ship) from public.intermediary_txns where lot_id = :'la' and kind = 'transfer'), false, 'CR-013: trả tiền hàng không phải ship TQ→VN');
select public.settle_cn_ship(array[:'la']::uuid[], 80000, null, 'Đợt 03/11');
select t.eq((select count(*)::int from public.intermediary_txns where lot_id = :'la' and kind = 'transfer' and is_cn_ship and note = 'Đợt 03/11'), 1,
            'CR-013: tất toán ship (ghi chú riêng) vẫn đánh dấu is_cn_ship');
select t.err('insert into public.intermediary_txns (kind, amount_vnd, is_cn_ship) values (''transfer'', 1, true)', '42501', 'CR-013: client không tự đặt cờ is_cn_ship');
reset role;
