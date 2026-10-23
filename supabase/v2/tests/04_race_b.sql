-- Phiên B (máy 2): chọn CÙNG ZP6-006 khi A chưa commit ⇒ phải chờ khoá rồi bị từ chối UNIT_NOT_AVAILABLE.
\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'B_START ' || clock_timestamp()::time;
select t.err(format('select public.save_order(null, %L, %L)',
  jsonb_build_object('new_customer', jsonb_build_object('fb_name', 'Khách máy 2'), 'deposit_vnd', 200000),
  jsonb_build_array(jsonb_build_object('unit_id', (select id from public.units where code = 'ZP6-006')))),
  'UNIT_NOT_AVAILABLE', 'race: phiên B chọn ZP6-006 đang bị phiên A giữ → UNIT_NOT_AVAILABLE');
select 'B_END ' || clock_timestamp()::time;
select t.eq((select count(*) from public.order_lines ol join public.units u on u.id = ol.unit_id
              where u.code = 'ZP6-006' and not ol.cancelled)::int, 1, 'race: ZP6-006 chỉ thuộc 1 đơn chưa huỷ');
select t.eq((select count(*) from public.customers where fb_name = 'Khách máy 2')::int, 0,
            'race: phiên B rollback sạch (không có khách / cọc mồ côi)');
