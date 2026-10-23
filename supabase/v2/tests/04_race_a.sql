-- Phiên A (máy 1): giữ ZP6-006 rồi chờ 3 giây mới commit.
\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
begin;
select 'A_SAVED ' || (public.save_order(null,
  jsonb_build_object('customer_id', (select id from public.customers where fb_name = 'Lan Nguyễn')),
  jsonb_build_array(jsonb_build_object('unit_id', (select id from public.units where code = 'ZP6-006'))))->>'status');
select 'A_SLEEP ' || clock_timestamp()::time;
select pg_sleep(3);
commit;
select 'A_COMMIT ' || clock_timestamp()::time;
