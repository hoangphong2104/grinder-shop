-- Chạy SAU setup-v2.sql trên DB v1 có dữ liệu: kiểm tra v1 đã bị xoá sạch, v2 đủ đối tượng; tạo helper test (schema t).
\set ON_ERROR_STOP 1
reset role;

drop schema if exists t cascade;
create schema t;
grant usage on schema t to anon, authenticated;

create function t.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_name;
  end if;
  raise notice 'PASS: %', p_name;
end $$;

create function t.eq(p_actual anycompatible, p_expected anycompatible, p_name text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % — expected [%], got [%]', p_name, p_expected, p_actual;
  end if;
  raise notice 'PASS: % = %', p_name, p_actual;
end $$;

-- Chạy p_sql, phải lỗi với message hoặc SQLSTATE = p_expect. Trả về detail của lỗi.
create function t.err(p_sql text, p_expect text, p_name text) returns text language plpgsql as $$
declare v_msg text; v_state text; v_detail text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate, v_detail = pg_exception_detail;
    if v_msg = p_expect or v_state = p_expect then
      raise notice 'PASS: % → % %', p_name, v_state, v_msg;
      return coalesce(v_detail, '');
    end if;
    raise exception 'FAIL: % — expected %, got % %', p_name, p_expect, v_state, v_msg;
  end;
  raise exception 'FAIL: % — expected error %, got none', p_name, p_expect;
end $$;
grant execute on all functions in schema t to anon, authenticated;

-- v1 không còn
select t.ok(to_regclass('public.variants') is null and to_regclass('public.lot_lines') is null
            and to_regclass('public.stock_movements') is null and to_regclass('public.v_variant_stock') is null,
            'reset: bảng/view v1 (variants, lot_lines, stock_movements, v_variant_stock) đã xoá');
select t.eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'private' and p.proname in ('replay_variant_avg','lock_variants','variant_incoming',
                                                            'variant_reserved','order_fillable'))::int, 0,
            'reset: hàm private v1 đã xoá');
select t.eq((select count(*) from pg_proc where proname = 'save_lot')::int, 1, 'reset: chỉ còn 1 chữ ký save_lot (v2)');
select t.eq((select count(*) from pg_proc where proname = 'save_order')::int, 1, 'reset: chỉ còn 1 chữ ký save_order (v2)');
select t.eq((select string_agg(pg_get_function_identity_arguments(oid), '') from pg_proc where proname = 'save_lot'),
            'p_lot_id uuid, p_lot jsonb, p_groups jsonb, p_expected_version integer', 'chữ ký save_lot v2');
-- v2 đủ
select t.ok(to_regclass('public.units') is not null and to_regclass('public.notes') is not null
            and to_regclass('public.v_units') is not null and to_regclass('public.v_model_stock') is not null
            and to_regclass('private.unit_code_retired') is not null, 'v2: units, notes, v_units, v_model_stock, unit_code_retired có');
select t.eq((select count(*) from public.models)::int, 0, 'v2: dữ liệu v1 đã xoá (A11) — models rỗng');
-- CR-005 / CR-008: cài mới (001 có sổ quỹ + danh bạ kho) thêm cash_entries + warehouses; DB nâng cấp (fixture pre-003) chưa có
select t.eq((select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
            case when to_regclass('public.cash_entries') is not null then 'cash_entries,' else '' end
            || 'customers,intermediary_txns,lots,models,notes,order_lines,orders,payments,sellers,settings,units'
            || case when to_regclass('public.warehouses') is not null then ',warehouses' else '' end,
            'realtime: đúng các bảng v2 (11 + cash_entries nếu có CR-005 + warehouses nếu có CR-008)');
select t.eq((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects')::int, 4,
            'storage: 4 policy private_images_*');
select t.eq((select count(*) from storage.buckets where id = 'private-images')::int, 1, 'storage: bucket giữ nguyên');
select t.eq((select count(*) from storage.objects)::int, 1, 'storage: file cũ giữ nguyên (không xoá bằng SQL)');
select t.eq((select count(*) from auth.users)::int, 2, 'auth.users giữ nguyên');
select t.ok((select bool_and(relrowsecurity) from pg_class
              where oid in ('public.models'::regclass, 'public.units'::regclass, 'public.lots'::regclass,
                            'public.orders'::regclass, 'public.order_lines'::regclass, 'public.notes'::regclass,
                            'public.payments'::regclass, 'public.customers'::regclass, 'public.sellers'::regclass,
                            'public.intermediary_txns'::regclass, 'public.settings'::regclass, 'public.ai_scan_log'::regclass)),
            'RLS bật trên mọi bảng public');
select t.ok((select bool_and(prosecdef and proconfig @> array['search_path=""'])
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('save_lot','save_order','receive_lot','update_unit',
                                                           'cancel_lot','ship_order','bootstrap_user')),
            'RPC: SECURITY DEFINER + search_path rỗng');
select t.ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class
              where relname in ('v_units','v_model_stock','v_lot_summary','v_order_summary','v_intermediary_balance','v_suggestions')),
            'view: security_invoker = true');
