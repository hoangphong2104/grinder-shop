-- Test CR-011 (010_order_fee.sql): phí COD / phí khác của đơn - trừ lãi, bút toán sổ quỹ 'order_fee', phí COD mặc định.
-- Dùng user thử 13 riêng.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
insert into auth.users (id, email) values ('13131313-1313-1313-1313-131313131313', 'u13@test.local') on conflict (id) do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '13131313-1313-1313-1313-131313131313', false);
select public.bootstrap_user();
select t.eq((select default_cod_fee_vnd from public.settings), 5500::bigint, 'CR-011: phí COD mặc định 5.500');
select id as m_ku from public.models where code_prefix = 'KU' \gset
select (private.today_vn() - 10)::text as d10, (private.today_vn() - 2)::text as d2 \gset
insert into public.customers (fb_name) values ('Khách CR-011') returning id as cu \gset
select x->>'lot_id' as la from (select public.save_lot(null, jsonb_build_object('exchange_rate', 3600, 'ordered_at', :'d10', 'buying_fee_pct', 0),
    jsonb_build_array(jsonb_build_object('model_id', :'m_ku', 'qty', 2, 'price_cny', 1000))) x) s \gset
select public.receive_lot(:'la', 0, :'d2'::date);
select id as u1 from public.units where lot_id = :'la' order by code limit 1 \gset
select id as u2 from public.units where lot_id = :'la' order by code desc limit 1 \gset

-- Đơn COD: gửi kèm COD ⇒ tự điền phí 5.500, trừ lãi, bút toán order_fee ngày gửi
select x->>'order_id' as o1 from (select public.save_order(null, jsonb_build_object('customer_id', :'cu', 'order_date', :'d2', 'ship_fee_vnd', 0, 'ship_fee_payer', 'customer'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u1', 'unit_price_vnd', 5000000))) x) s \gset
select public.ship_order(:'o1', null, :'d2'::date, null, 5000000);
select t.eq((select fee_vnd from public.orders where id = :'o1'), 5500::bigint, 'CR-011: gửi có COD ⇒ phí COD mặc định');
select t.eq((select profit_vnd from public.v_order_summary where order_id = :'o1'), (5000000 - 3600000 - 5500)::bigint, 'CR-011: phí trừ vào lãi đơn');
select t.eq((select amount_vnd || '/' || direction || '/' || entry_date from public.cash_entries where order_id = :'o1' and kind = 'order_fee'),
            '5500/out/' || :'d2', 'CR-011: bút toán phí đơn (tiền ra, ngày gửi)');
-- Sửa phí (vd. thêm phí rút tiền COD) ⇒ bút toán theo; 0 ⇒ xoá
select public.set_order_fee(:'o1', 8000);
select t.eq((select amount_vnd from public.cash_entries where order_id = :'o1' and kind = 'order_fee'), 8000::bigint, 'CR-011: sửa phí ⇒ bút toán theo');
select public.set_order_fee(:'o1', 0);
select t.eq((select count(*)::int from public.cash_entries where order_id = :'o1' and kind = 'order_fee'), 0, 'CR-011: phí 0 ⇒ xoá bút toán');
select public.set_order_fee(:'o1', 5500);
-- Lùi về Đã chốt ⇒ bỏ bút toán (đơn chưa gửi), phí giữ trên đơn
select public.revert_order(:'o1');
select t.eq((select count(*)::int from public.cash_entries where order_id = :'o1' and kind = 'order_fee'), 0, 'CR-011: đơn chưa gửi ⇒ chưa ghi phí vào sổ quỹ');
select t.eq((select fee_vnd from public.orders where id = :'o1'), 5500::bigint, 'CR-011: phí giữ trên đơn');
select public.ship_order(:'o1', null, :'d2'::date);
select t.eq((select fee_vnd from public.orders where id = :'o1'), 5500::bigint, 'CR-011: gửi lại không cộng thêm phí');

-- Đơn không COD ⇒ không tự điền phí; COD mặc định 0 ⇒ không điền
update public.settings set default_cod_fee_vnd = 0;
select x->>'order_id' as o2 from (select public.save_order(null, jsonb_build_object('customer_id', :'cu', 'order_date', :'d2'),
    jsonb_build_array(jsonb_build_object('unit_id', :'u2', 'unit_price_vnd', 4000000))) x) s \gset
select public.ship_order(:'o2', null, :'d2'::date, null, 4000000);
select t.eq((select fee_vnd from public.orders where id = :'o2'), 0::bigint, 'CR-011: phí COD mặc định 0 ⇒ không tự điền');
select t.err(format('select public.set_order_fee(%L, -1)', :'o2'), 'INVALID_AMOUNT', 'CR-011: phí âm bị từ chối');
select t.err(format('update public.orders set fee_vnd = 1 where id = %L', :'o2'), '42501', 'CR-011: client không sửa thẳng fee_vnd');
reset role;
