-- =============================================================================
-- Kho Cối — 000_reset_v1.sql: XOÁ toàn bộ schema app (v1, và cả v2 nếu đã cài) để cài lại v2.
-- CR-001 A11: dữ liệu thử trên v0.1 bị xoá khi đổi cấu trúc.
--
-- Chạy được nhiều lần (mọi lệnh đều "if exists"). Thứ tự: 000_reset_v1.sql → 001_schema_v2.sql
-- (hoặc dán 1 lần setup-v2.sql trong Supabase SQL Editor).
--
-- XOÁ: thành viên publication supabase_realtime của các bảng app; view; bảng public (v1 + v2) và
--      private.unit_code_retired (v2); hàm app trong public + private (mọi chữ ký, theo tên);
--      4 policy private_images_* trên storage.objects (001 tạo lại).
-- GIỮ:  auth.users (tài khoản đăng nhập), schema private (rỗng — 001 dùng lại), bucket 'private-images'
--       và các file ảnh trong đó (Supabase chặn xoá storage.objects bằng SQL; ảnh cũ không còn được
--       tham chiếu — muốn dọn thì "Empty bucket" trong Dashboard → Storage).
-- KHÔNG đụng: schema auth / storage / realtime của Supabase, bảng hay hàm khác không thuộc app.
-- =============================================================================

begin;

-- 1. Gỡ bảng app khỏi publication realtime (drop table cũng tự gỡ, làm rõ cho chắc)
do $$
declare r record;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    for r in select schemaname, tablename from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public'
                and tablename in ('models','variants','sellers','lots','lot_lines','units','intermediary_txns',
                                  'customers','orders','order_lines','payments','settings','stock_movements',
                                  'ai_scan_log','notes')
    loop
      execute format('alter publication supabase_realtime drop table %I.%I', r.schemaname, r.tablename);
    end loop;
  end if;
end $$;

-- 2. View (v1 + v2)
drop view if exists public.v_suggestions          cascade;
drop view if exists public.v_order_summary        cascade;
drop view if exists public.v_lot_summary          cascade;
drop view if exists public.v_model_stock          cascade;
drop view if exists public.v_units                cascade;
drop view if exists public.v_variant_stock        cascade;
drop view if exists public.v_intermediary_balance cascade;

-- 3. Bảng (v1 + v2). cascade gỡ luôn FK, policy, trigger của bảng.
drop table if exists public.stock_movements   cascade;   -- v1
drop table if exists public.order_lines       cascade;
drop table if exists public.payments          cascade;
drop table if exists public.orders            cascade;
drop table if exists public.lot_lines         cascade;   -- v1
drop table if exists public.units             cascade;   -- v2
drop table if exists public.intermediary_txns cascade;
drop table if exists public.lots              cascade;
drop table if exists public.variants          cascade;   -- v1
drop table if exists public.models            cascade;
drop table if exists public.sellers           cascade;
drop table if exists public.customers         cascade;
drop table if exists public.settings          cascade;
drop table if exists public.ai_scan_log       cascade;
drop table if exists public.notes             cascade;   -- v2 (CR-002)
drop table if exists private.unit_code_retired cascade;  -- v2

-- 4. Hàm app (mọi chữ ký) trong public + private
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname in (
                     'bootstrap_user','save_lot','set_lot_status','receive_lot','update_lot_ship_fee','cancel_lot',
                     'update_unit','save_order','confirm_preorder','ship_order','cancel_order','complete_order',
                     'ai_scan_reserve','ai_scan_finish'))
               or (n.nspname = 'private' and p.proname in (
                     'today_vn','require_uid','check_version','touch_row','touch_model',
                     'recalc_lot','replay_variant_avg','lock_variants','variant_incoming','variant_reserved',
                     'order_fillable','next_unit_code','order_unreceived_codes'))
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- 5. Policy Storage (bucket + file giữ nguyên)
drop policy if exists private_images_select on storage.objects;
drop policy if exists private_images_insert on storage.objects;
drop policy if exists private_images_update on storage.objects;
drop policy if exists private_images_delete on storage.objects;

commit;
