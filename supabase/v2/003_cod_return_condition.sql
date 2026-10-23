-- =============================================================================
-- Kho Cối — 003_cod_return_condition.sql: CR-004 (phần DỮ LIỆU) — COD, Hoàn hàng, tình trạng từng chiếc, ngưỡng tuổi tồn.
-- Nguồn: 1.5-change-control/draft/CR_004_research-best-practice.md (DON-S1, DON-S3, LOT-S1 + KHO-S3, KHO-S1, LOT-S2,
--        HOME-S1) + mục "Quyết định của Chủ dự án (2026-10-23)".
-- Migration CỘNG THÊM cho database ĐANG CHẠY (setup-v2 bản pre-003 + 002_buying_fee.sql) có DỮ LIỆU THẬT.
-- KHÔNG xoá / sửa dữ liệu cũ: mọi cột mới có default ⇒ số liệu cũ (giá nhập, phải trả, còn phải thu, lãi, tồn) giữ nguyên.
--
--   * units.condition            'new'|'like_new'|'used'|'defect' (mặc định 'new' = Mới) — sửa qua update_unit
--                                (khoá patch 'condition') hoặc lúc nhận lô (receive_lot p_units).
--   * payments.method            'transfer'|'cash'|'cod' (mặc định 'transfer' = Chuyển khoản). COD chỉ cho kind 'payment'.
--   * orders.cod_amount_vnd      số tiền hãng ship thu hộ (đặt khi gửi: ship_order p_cod_amount_vnd; sửa khi Đã gửi:
--                                set_order_cod).
--   * orders.status 'returned'   HOÀN HÀNG (khách bom / chuyển hoàn) — chỉ từ 'shipped' (return_order). Các dòng đơn được
--                                nhả (order_lines.cancelled = true) ⇒ chiếc về Trong kho, bán lại được.
--                                Cột mới: returned_at, return_ship_fee_vnd, keep_deposit, return_note.
--   * settings                   aging_warn_days 30, aging_alert_days 60 (tuổi tồn), lot_late_days 21 (lô về trễ).
--   * v_units                    + condition, aging_level ('ok'|'warn'|'alert', chỉ chiếc đã về kho chưa bán)  — cột CUỐI
--   * v_lot_summary              + is_lot_late (lô chưa nhận, đặt quá lot_late_days ngày)                     — cột CUỐI
--   * v_order_summary            luật tiền đơn Hoàn hàng (receivable / refund_due / profit) + cột COD / hoàn hàng  — cột CUỐI
--
-- Luật tiền đơn Hoàn hàng (quyết định Chủ dự án: "chọn giữ cọc hoặc hoàn cọc; ship về (và ship đi nếu shop chịu) trừ lãi"):
--   đã thu ròng         = Σ cọc + Σ thanh toán − Σ hoàn tiền
--   giữ tối đa          = keep_deposit ? Σ cọc : 0           (giữ CỌC — tiền khách trả thêm ngoài cọc vẫn phải hoàn)
--   cần hoàn            = max(đã thu ròng − giữ tối đa, 0)  (giảm dần khi ghi các khoản 'refund')
--   tiền shop giữ       = đã thu ròng − cần hoàn
--   còn phải thu        = 0 (không đòi khách nữa)
--   lãi đơn             = tiền shop giữ − ship đi (nếu shop chịu) − ship chiều về.  Giá nhập chiếc KHÔNG trừ (chiếc về kho).
--                         Khách chịu ship nhưng bom ⇒ phí ship đi shop phải trả hãng: cộng vào p_return_ship_fee_vnd.
--   tháng tính lãi      = tháng returned_at (cột profit_date).
--   Lý do "giữ cọc" ≠ "giữ hết tiền đã thu": nếu khách đã chuyển đủ rồi trả hàng, phần ngoài cọc vẫn là tiền phải hoàn;
--   và lãi tính trên số shop GIỮ LẠI (không đợi ghi khoản hoàn) ⇒ ghi hoàn tiền sau không làm đổi lãi.
-- COD chờ về (đơn Đã gửi / Hoàn tất) = max(min(cod_amount − Σ thu method 'cod', còn phải thu), 0); đơn khác = 0.
--   (chặn bởi còn phải thu ⇒ thu phần còn lại bằng chuyển khoản / đơn đã đủ tiền / đơn hoàn hàng ⇒ không báo "COD chờ về" giả.)
--
-- RPC mới / đổi:
--   receive_lot(p_lot_id, p_ship_fee_vnd, p_received_at, p_expected_version, p_units jsonb default null)  ← thêm p_units
--   ship_order(p_order_id, p_tracking_no, p_shipped_at, p_expected_version, p_cod_amount_vnd bigint default null) ← thêm COD
--   set_order_cod(p_order_id, p_cod_amount_vnd, p_expected_version)                                         ← mới
--   return_order(p_order_id, p_keep_deposit, p_return_ship_fee_vnd, p_returned_at, p_note, p_expected_version) ← mới
--   update_unit: patch thêm khoá 'condition';  save_order: p_order.deposit_method ('transfer'|'cash') cho khoản cọc.
--   (Đổi tham số = drop chữ ký cũ rồi tạo lại ⇒ mỗi RPC vẫn đúng 1 chữ ký; tham số mới ở CUỐI có default ⇒ app cũ gọi bằng
--    tên tham số (PostgREST) vẫn chạy.)
-- Mã lỗi mới: ORDER_NOT_RETURNABLE (hoàn hàng đơn không ở 'Đã gửi').
--
-- LƯU Ý: sau 003, KHÔNG chạy lại 002_buying_fee.sql (002 thay v_lot_summary bằng bản ít cột hơn ⇒ Postgres báo
--        "cannot drop columns from view" và huỷ cả transaction — không hỏng gì, nhưng vô ích).
-- Chạy được nhiều lần (idempotent), 1 transaction: lỗi giữa chừng ⇒ không đổi gì.
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-004 (test so schema: cài mới = pre-003 + 002 + 003).
-- Cách chạy: CI (scripts/apply-migrations.sh theo deploy-order.txt) hoặc Supabase SQL Editor → dán TOÀN BỘ file → Run.
-- =============================================================================

begin;

-- 0. Chặn chạy nhầm: phải có schema v2 VÀ đã chạy 002 (CR-003)
do $$
begin
  if to_regclass('public.units') is null or to_regclass('public.orders') is null or to_regclass('public.settings') is null then
    raise exception 'Chưa có schema v2 (public.units / orders / settings) — cài setup-v2.sql trước, đừng chạy 003 trên DB v1.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lots' and column_name = 'buying_fee_pct') then
    raise exception 'Chưa chạy 002_buying_fee.sql (thiếu lots.buying_fee_pct) — chạy 002 trước rồi mới chạy 003.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Cột mới (if not exists ⇒ chạy lại không lỗi; dòng cũ nhận default). Thứ tự cột = thứ tự cuối bảng ở 001.
--    Check tự đặt tên <bảng>_<cột>_check giống cài mới.
-- -----------------------------------------------------------------------------
alter table public.units
  add column if not exists condition text not null default 'new'
      check (condition in ('new','like_new','used','defect'));                       -- KHO-S3: Mới/Như mới/Đã dùng/Có lỗi

alter table public.orders
  add column if not exists cod_amount_vnd bigint not null default 0 check (cod_amount_vnd >= 0),      -- DON-S1
  add column if not exists returned_at date,                                                          -- DON-S3
  add column if not exists return_ship_fee_vnd bigint not null default 0 check (return_ship_fee_vnd >= 0),
  add column if not exists keep_deposit boolean not null default false,
  add column if not exists return_note text check (length(return_note) <= 1000);

alter table public.payments
  add column if not exists method text not null default 'transfer' check (method in ('transfer','cash','cod'));

alter table public.settings
  add column if not exists aging_warn_days int not null default 30 check (aging_warn_days > 0),       -- KHO-S1 / HOME-S1
  add column if not exists aging_alert_days int not null default 60 check (aging_alert_days > 0),
  add column if not exists lot_late_days int not null default 21 check (lot_late_days > 0),           -- LOT-S2
  add column if not exists bank_info text check (length(bank_info) <= 500);                            -- DON-S2: STK trong tin xác nhận đơn

-- Ràng buộc trạng thái / ngày (drop + add cùng tên ⇒ chạy lại được; dữ liệu cũ thoả vì chưa có đơn 'returned')
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('preorder','confirmed','shipped','completed','cancelled','returned'));
alter table public.orders drop constraint if exists orders_shipped_has_date;
alter table public.orders add constraint orders_shipped_has_date
  check (status not in ('shipped','completed','returned') or shipped_at is not null);
alter table public.orders drop constraint if exists orders_returned_has_date;
alter table public.orders add constraint orders_returned_has_date
  check (status <> 'returned' or returned_at is not null);
alter table public.payments drop constraint if exists payments_cod_is_payment;
alter table public.payments add constraint payments_cod_is_payment
  check (method <> 'cod' or kind = 'payment');                                       -- COD = tiền hãng ship chuyển về
alter table public.settings drop constraint if exists settings_aging_days_order;
alter table public.settings add constraint settings_aging_days_order
  check (aging_warn_days < aging_alert_days);

-- Quyền: units / orders chỉ select cả bảng (sửa qua RPC); payments + settings grant cả bảng ⇒ client ghi trực tiếp
-- payments.method và settings.aging_* / lot_late_days. Grant lại cho chắc (không đổi gì nếu đã có).
grant select on public.units, public.orders to authenticated;
grant select, insert, update, delete on public.payments to authenticated;
grant select, insert, update on public.settings to authenticated;

-- -----------------------------------------------------------------------------
-- 2. View (cột mới ở CUỐI ⇒ create or replace view; security_invoker = true; grant lại)
-- -----------------------------------------------------------------------------

-- Từng chiếc + trạng thái A5 + giá nhập hiệu lực + đơn đang giữ + lãi dự kiến / thực tế + số ngày tồn
-- CR-004 (cột CUỐI): condition; aging_level = tuổi tồn của chiếc ĐÃ VỀ KHO chưa bán (Trong kho / Đã giữ):
--   > aging_alert_days ⇒ 'alert' (đỏ) · > aging_warn_days ⇒ 'warn' (cam) · còn lại 'ok'; chiếc khác ⇒ null.
-- Đơn Hoàn hàng đã nhả dòng (cancelled = true) ⇒ không còn giữ chiếc ⇒ chiếc về Trong kho.
create or replace view public.v_units with (security_invoker = true) as
select u.id                    as unit_id,
       u.user_id,
       u.code,
       u.serial_no,
       u.note,
       u.model_id,
       m.name                  as model_name,
       m.code_prefix,
       u.lot_id,
       l.status                as lot_status,
       l.ordered_at,
       l.received_at,
       l.exchange_rate,
       l.ship_fee_vnd          as lot_ship_fee_vnd,
       l.goofish_item_id,
       l.seller_id,
       u.price_cny,
       u.cost_vnd_auto,
       u.cost_vnd_override,
       coalesce(u.cost_vnd_override, u.cost_vnd_auto)                 as cost_vnd,
       (u.cost_vnd_override is not null)                              as cost_is_overridden,
       (u.cost_vnd_override is null and l.ship_fee_vnd is null)       as cost_is_provisional,
       u.list_price_vnd,
       (l.status = 'received')                                        as is_received,
       case when l.status = 'cancelled'                  then 'cancelled'
            when h.order_status in ('shipped','completed') then 'sold'
            when h.order_status in ('preorder','confirmed') then 'reserved'
            when l.status = 'received'                   then 'in_stock'
            else 'incoming' end                                       as status,
       h.order_line_id         as holding_order_line_id,
       h.order_id              as holding_order_id,
       h.order_status          as holding_order_status,
       h.customer_id           as holding_customer_id,
       h.customer_name         as holding_customer_name,
       h.unit_price_vnd        as order_unit_price_vnd,
       case when h.order_status in ('shipped','completed') then h.unit_price_vnd end as sold_price_vnd,
       h.shipped_at            as sold_at,
       u.list_price_vnd - coalesce(u.cost_vnd_override, u.cost_vnd_auto)            as expected_profit_vnd,
       case when h.order_status in ('shipped','completed')
            then h.unit_price_vnd - coalesce(u.cost_vnd_override, u.cost_vnd_auto) end as actual_profit_vnd,
       case when l.status = 'received'
            then (case when h.order_status in ('shipped','completed') then h.shipped_at
                       else private.today_vn() end) - l.received_at end              as days_in_stock,
       u.created_at,
       u.updated_at,
       u.version,
       u.condition,
       case when l.status = 'received' and (h.order_status is null or h.order_status in ('preorder','confirmed'))
            then case when private.today_vn() - l.received_at > coalesce(st.aging_alert_days, 60) then 'alert'
                      when private.today_vn() - l.received_at > coalesce(st.aging_warn_days, 30)  then 'warn'
                      else 'ok' end end                                              as aging_level
from public.units u
join public.models m on m.id = u.model_id
join public.lots l   on l.id = u.lot_id
left join public.settings st on st.user_id = u.user_id
left join lateral (
  select ol.id as order_line_id, ol.order_id, ol.unit_price_vnd, o.status as order_status,
         o.shipped_at, o.customer_id, c.fb_name as customer_name
  from public.order_lines ol
  join public.orders o    on o.id = ol.order_id
  join public.customers c on c.id = o.customer_id
  where ol.unit_id = u.id and not ol.cancelled and o.status in ('preorder','confirmed','shipped','completed')
  limit 1
) h on true;

-- Lô: số chiếc, tiền hàng, phải trả (BR-12, A4), đếm theo trạng thái chiếc, tóm tắt theo model.
-- CR-003 (cột thêm ở CUỐI để 002 dùng được create or replace view): buying_fee_pct, buying_fee_vnd = round(Σ¥ × tỷ giá × %/100).
-- goods_vnd giữ nghĩa cũ (Σ¥ × tỷ giá, CHƯA gồm phí mua hộ).
-- CR-004 (cột CUỐI): is_lot_late = lô chưa nhận / chưa huỷ và hôm nay − ngày đặt > settings.lot_late_days (mặc định 21).
create or replace view public.v_lot_summary with (security_invoker = true) as
select l.id as lot_id, l.user_id, l.status, l.ordered_at, l.received_at, l.exchange_rate, l.ship_fee_vnd,
       l.seller_id, s.nickname as seller_nickname, l.goofish_url, l.goofish_item_id, l.listing_title,
       l.screenshot_path, l.note, l.version,
       agg.total_qty,
       agg.total_cny,
       round(agg.total_cny * l.exchange_rate)::bigint                         as goods_vnd,
       case when agg.total_qty > 0 and l.ship_fee_vnd is not null
            then round(l.ship_fee_vnd::numeric / agg.total_qty)::bigint end   as ship_per_unit_vnd,
       coalesce(t.amount_vnd, 0)                                              as payable_vnd,
       (l.ship_fee_vnd is null)                                               as cost_is_provisional,
       agg.total_cost_vnd,
       agg.incoming_count, agg.in_stock_count, agg.reserved_count, agg.sold_count,
       agg.models,
       l.buying_fee_pct,
       round(agg.total_cny * l.exchange_rate * (l.buying_fee_pct / 100))::bigint   as buying_fee_vnd,
       (l.status not in ('received','cancelled')
        and private.today_vn() - l.ordered_at > coalesce(st.lot_late_days, 21))    as is_lot_late
from public.lots l
left join public.sellers s on s.id = l.seller_id
left join public.settings st on st.user_id = l.user_id
left join lateral (
  select count(*)::int                                          as total_qty,
         coalesce(sum(vu.price_cny), 0)::numeric(14,2)          as total_cny,
         coalesce(sum(vu.cost_vnd), 0)::bigint                  as total_cost_vnd,
         count(*) filter (where vu.status = 'incoming')::int    as incoming_count,
         count(*) filter (where vu.status = 'in_stock')::int    as in_stock_count,
         count(*) filter (where vu.status = 'reserved')::int    as reserved_count,
         count(*) filter (where vu.status = 'sold')::int        as sold_count,
         coalesce((select jsonb_agg(jsonb_build_object('model_id', g.model_id, 'model_name', g.model_name, 'qty', g.qty)
                                    order by g.model_name)
                     from (select model_id, model_name, count(*)::int as qty from public.v_units
                            where lot_id = l.id group by model_id, model_name) g), '[]'::jsonb) as models
  from public.v_units vu where vu.lot_id = l.id
) agg on true
left join public.intermediary_txns t on t.lot_id = l.id and t.kind = 'payable';

-- Đơn: còn phải thu (BR-10), cần hoàn (Q-009), lãi (A8: Σ(giá chốt − giá nhập hiệu lực HIỆN TẠI) − ship shop chịu)
-- CR-004: đơn Hoàn hàng ('returned'): còn phải thu 0; cần hoàn = max(đã thu ròng − (keep_deposit ? Σ cọc : 0), 0);
--   lãi = (đã thu ròng − cần hoàn) − ship shop chịu − ship chiều về. Cột CUỐI: COD (cod_amount_vnd, cod_received_vnd,
--   cod_pending_vnd), deposit_vnd (Σ cọc), returned_at, return_ship_fee_vnd, keep_deposit, return_note,
--   kept_vnd (tiền shop giữ của đơn hoàn hàng), profit_date (ngày tính lãi: gửi / hoàn hàng).
create or replace view public.v_order_summary with (security_invoker = true) as
select o.id as order_id, o.user_id, o.customer_id, c.fb_name as customer_name, o.status,
       o.order_date, o.shipped_at, o.completed_at, o.completion_forced, o.cancelled_at,
       o.tracking_no, o.ship_fee_vnd, o.ship_fee_payer, o.note, o.version,
       agg.unit_count,
       agg.unit_codes,
       agg.all_units_received,
       agg.goods_vnd,
       agg.cost_vnd,
       case when o.ship_fee_payer = 'customer' then o.ship_fee_vnd else 0 end as ship_charged_vnd,
       coalesce(p.paid_vnd, 0) as paid_vnd,
       mo.receivable_vnd,                                               -- âm = khách trả dư (Q-010)
       mo.refund_due_vnd,
       case when o.status in ('shipped','completed')
            then agg.goods_vnd - agg.cost_vnd - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end
            when o.status = 'returned'
            then coalesce(p.paid_vnd, 0) - mo.refund_due_vnd
                 - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end - o.return_ship_fee_vnd
       end as profit_vnd,
       o.cod_amount_vnd,
       coalesce(p.cod_received_vnd, 0) as cod_received_vnd,
       case when o.status in ('shipped','completed','returned')
            then greatest(least(o.cod_amount_vnd - coalesce(p.cod_received_vnd, 0), mo.receivable_vnd), 0)
            else 0 end as cod_pending_vnd,
       coalesce(p.deposit_vnd, 0) as deposit_vnd,
       o.returned_at,
       o.return_ship_fee_vnd,
       o.keep_deposit,
       o.return_note,
       case when o.status = 'returned' then coalesce(p.paid_vnd, 0) - mo.refund_due_vnd end as kept_vnd,
       case when o.status in ('shipped','completed') then o.shipped_at
            when o.status = 'returned' then o.returned_at end as profit_date
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)::int                                                         as unit_count,
         coalesce(array_agg(u.code order by ol.line_no, u.code), '{}')         as unit_codes,
         coalesce(bool_and(l.status = 'received'), false)                      as all_units_received,
         coalesce(sum(ol.unit_price_vnd), 0)::bigint                           as goods_vnd,
         coalesce(sum(coalesce(u.cost_vnd_override, u.cost_vnd_auto)), 0)::bigint as cost_vnd
  from public.order_lines ol
  join public.units u on u.id = ol.unit_id
  join public.lots l  on l.id = u.lot_id
  where ol.order_id = o.id
) agg on true
left join lateral (
  select sum(case when kind = 'refund' then -amount_vnd else amount_vnd end)::bigint as paid_vnd,
         coalesce(sum(amount_vnd) filter (where method = 'cod'), 0)::bigint        as cod_received_vnd,
         coalesce(sum(amount_vnd) filter (where kind = 'deposit'), 0)::bigint      as deposit_vnd
  from public.payments where order_id = o.id
) p on true
cross join lateral (
  select case when o.status in ('cancelled','returned') then 0
              else agg.goods_vnd + case when o.ship_fee_payer = 'customer' then o.ship_fee_vnd else 0 end
                   - coalesce(p.paid_vnd, 0)
         end as receivable_vnd,
         case when o.status = 'cancelled' then greatest(coalesce(p.paid_vnd, 0), 0)
              when o.status = 'returned'
              then greatest(coalesce(p.paid_vnd, 0) - case when o.keep_deposit then coalesce(p.deposit_vnd, 0) else 0 end, 0)
              else 0 end as refund_due_vnd
) mo;

grant select on public.v_units, public.v_lot_summary, public.v_order_summary to authenticated;

-- -----------------------------------------------------------------------------
-- 3. RPC (create or replace giữ chữ ký; đổi tham số ⇒ drop chữ ký cũ rồi tạo — vẫn đúng 1 chữ ký mỗi RPC)
-- -----------------------------------------------------------------------------
drop function if exists public.receive_lot(uuid, bigint, date, int);
drop function if exists public.ship_order(uuid, text, date, int);

-- receive_lot(p_lot_id, p_ship_fee_vnd bigint|null, p_received_at date|null, p_expected_version, p_units jsonb|null) → jsonb
-- Nhận lô từ BẤT KỲ trạng thái mở nào (Q-011); bắt buộc phí ship (BR-02: tham số hoặc đã nhập trên lô).
-- Tính lại giá nhập tự tính + Phải trả; rồi TỰ CHỐT các đơn Đặt trước có chiếc trong lô này mà mọi chiếc
-- đều đã về kho (A7).
-- CR-004 LOT-S1: p_units (tuỳ chọn) = [{unit_id, condition?, serial_no?}] — ghi tình trạng / seri từng chiếc lúc nhận.
--   condition ∈ new|like_new|used|defect; serial_no '' / null ⇒ xoá seri; khoá thiếu ⇒ giữ nguyên.
--   unit_id phải thuộc lô (UNIT_NOT_FOUND, detail unit_id); trùng ⇒ DUPLICATE_UNIT; khoá lạ / sai dạng ⇒ INVALID_INPUT.
-- Trả về { lot_id, ship_fee_vnd, received_at, payable_vnd,
--          units: [{unit_id, code, cost_vnd, condition, serial_no}], auto_confirmed_order_ids: [uuid], version }
create or replace function public.receive_lot(p_lot_id uuid, p_ship_fee_vnd bigint default null,
                                              p_received_at date default null, p_expected_version int default null,
                                              p_units jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_lot   public.lots%rowtype;
  v_ship  bigint;
  r       record;
  e       jsonb;
  v_key   text;
  v_ids   uuid[] := '{}';
  v_bad   uuid;
  v_conf  jsonb := '[]'::jsonb;
begin
  -- CR-004: kiểm tra dạng p_units trước khi ghi
  if p_units is not null and jsonb_typeof(p_units) <> 'null' then
    if jsonb_typeof(p_units) <> 'array' then
      raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_units';
    end if;
    for e in select value from jsonb_array_elements(p_units) loop
      if jsonb_typeof(e) <> 'object' or nullif(e->>'unit_id', '') is null then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'unit_id';
      end if;
      select k into v_key from jsonb_object_keys(e) k where k not in ('unit_id','condition','serial_no') limit 1;
      if v_key is not null then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = v_key;
      end if;
      if e ? 'condition' and coalesce(e->>'condition', '') not in ('new','like_new','used','defect') then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'condition';
      end if;
      v_ids := v_ids || (e->>'unit_id')::uuid;
    end loop;
    if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
      raise exception using errcode = 'P0001', message = 'DUPLICATE_UNIT';
    end if;
  end if;

  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'received'  then raise exception using errcode = 'P0001', message = 'LOT_ALREADY_RECEIVED'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;
  perform private.check_version(p_expected_version, v_lot.version);

  v_ship := coalesce(p_ship_fee_vnd, v_lot.ship_fee_vnd);
  if v_ship is null then
    raise exception using errcode = 'P0001', message = 'SHIP_FEE_REQUIRED';                      -- BR-02
  end if;
  if v_ship < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'ship_fee_vnd';
  end if;

  select x into v_bad from unnest(v_ids) x
   where not exists (select 1 from public.units u where u.id = x and u.lot_id = p_lot_id) limit 1;
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND', detail = v_bad::text;
  end if;

  update public.lots
     set ship_fee_vnd = v_ship, status = 'received',
         received_at = coalesce(p_received_at, private.today_vn())
   where id = p_lot_id;

  perform private.recalc_lot(p_lot_id);

  -- CR-004 LOT-S1: tình trạng / seri từng chiếc (chỉ khoá có mặt; không đổi thì không tăng version)
  if cardinality(v_ids) > 0 then
    for e in select value from jsonb_array_elements(p_units) loop
      update public.units u
         set condition = case when e ? 'condition' then e->>'condition' else u.condition end,
             serial_no = case when e ? 'serial_no' then nullif(btrim(e->>'serial_no'), '') else u.serial_no end
       where u.id = (e->>'unit_id')::uuid
         and (u.condition, u.serial_no) is distinct from
             (case when e ? 'condition' then e->>'condition' else u.condition end,
              case when e ? 'serial_no' then nullif(btrim(e->>'serial_no'), '') else u.serial_no end);
    end loop;
  end if;

  -- A7: tự chốt đơn Đặt trước đã đủ mọi chiếc trong kho
  for r in select o.id from public.orders o
            where o.user_id = v_uid and o.status = 'preorder'
              and exists (select 1 from public.order_lines ol join public.units u on u.id = ol.unit_id
                           where ol.order_id = o.id and not ol.cancelled and u.lot_id = p_lot_id)
              and not exists (select 1 from public.order_lines ol
                                join public.units u on u.id = ol.unit_id
                                join public.lots l  on l.id = u.lot_id
                               where ol.order_id = o.id and not ol.cancelled and l.status <> 'received')
            order by o.id
            for update of o
  loop
    update public.orders set status = 'confirmed' where id = r.id;
    v_conf := v_conf || to_jsonb(r.id);
  end loop;

  return jsonb_build_object(
    'lot_id', p_lot_id,
    'ship_fee_vnd', v_ship,
    'received_at', (select received_at from public.lots where id = p_lot_id),
    'payable_vnd', (select amount_vnd from public.intermediary_txns where lot_id = p_lot_id and kind = 'payable'),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('unit_id', id, 'code', code,
                                        'cost_vnd', coalesce(cost_vnd_override, cost_vnd_auto),
                                        'condition', condition, 'serial_no', serial_no) order by code), '[]'::jsonb)
                from public.units where lot_id = p_lot_id),
    'auto_confirmed_order_ids', v_conf,
    'version', (select version from public.lots where id = p_lot_id));
end $$;

-- update_unit(p_unit_id, p_patch jsonb, p_expected_version) → jsonb
-- p_patch chỉ gồm các khoá muốn đổi (khoá khác ⇒ INVALID_INPUT):
--   { cost_vnd_override: bigint ≥ 0 | null (null = về giá tự tính), list_price_vnd: bigint ≥ 0 | null,
--     serial_no: text | null, note: text | null, condition: 'new'|'like_new'|'used'|'defect' (CR-004) }
-- Được sửa mọi lúc (cả khi lô đã nhận / chiếc đã bán — A10). Giá ¥ sửa qua save_lot (lô chưa nhận).
-- Trả về { unit_id, code, cost_vnd_auto, cost_vnd_override, cost_vnd, list_price_vnd, serial_no, note, condition, version }
create or replace function public.update_unit(p_unit_id uuid, p_patch jsonb, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_unit  public.units%rowtype;
  v_key   text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_patch';
  end if;
  select v_k into v_key from jsonb_object_keys(p_patch) v_k
   where v_k not in ('cost_vnd_override','list_price_vnd','serial_no','note','condition') limit 1;
  if v_key is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = v_key;
  end if;
  if (p_patch->>'cost_vnd_override')::bigint < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'cost_vnd_override';
  end if;
  if (p_patch->>'list_price_vnd')::bigint < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'list_price_vnd';
  end if;
  if p_patch ? 'condition' and coalesce(p_patch->>'condition', '') not in ('new','like_new','used','defect') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'condition';
  end if;

  select * into v_unit from public.units where id = p_unit_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND'; end if;
  perform private.check_version(p_expected_version, v_unit.version);

  update public.units set
    cost_vnd_override = case when p_patch ? 'cost_vnd_override' then (p_patch->>'cost_vnd_override')::bigint else cost_vnd_override end,
    list_price_vnd    = case when p_patch ? 'list_price_vnd'    then (p_patch->>'list_price_vnd')::bigint    else list_price_vnd end,
    serial_no         = case when p_patch ? 'serial_no' then nullif(btrim(p_patch->>'serial_no'), '') else serial_no end,
    note              = case when p_patch ? 'note'      then nullif(btrim(p_patch->>'note'), '')      else note end,
    condition         = case when p_patch ? 'condition' then p_patch->>'condition'                    else condition end
  where id = p_unit_id
  returning * into v_unit;

  return jsonb_build_object('unit_id', v_unit.id, 'code', v_unit.code,
                            'cost_vnd_auto', v_unit.cost_vnd_auto, 'cost_vnd_override', v_unit.cost_vnd_override,
                            'cost_vnd', coalesce(v_unit.cost_vnd_override, v_unit.cost_vnd_auto),
                            'list_price_vnd', v_unit.list_price_vnd, 'serial_no', v_unit.serial_no,
                            'note', v_unit.note, 'condition', v_unit.condition, 'version', v_unit.version);
end $$;

-- save_order(p_order_id uuid|null, p_order jsonb, p_lines jsonb, p_expected_version) → jsonb
-- Tạo / sửa đơn (chỉ khi Đặt trước / Đã chốt). Trạng thái tự quyết (A6): có chiếc Đang về ⇒ 'preorder',
-- mọi chiếc Trong kho ⇒ 'confirmed'. Chiếc phải: thuộc người dùng, lô không huỷ, không thuộc đơn chưa huỷ khác.
--   p_order = { customer_id | new_customer: {fb_name, fb_url, phone, address, note},
--               order_date, ship_fee_vnd (mặc định 0), ship_fee_payer 'customer'|'shop' (mặc định theo settings),
--               tracking_no, note,
--               deposit_vnd (chỉ khi TẠO: > 0 ⇒ ghi 1 khoản 'deposit'), deposit_paid_at (mặc định = order_date),
--               deposit_method 'transfer'|'cash' (CR-004, mặc định 'transfer') }
--     Tạo khách mới + đơn + cọc trong CÙNG 1 transaction.
--   p_lines = [{unit_id, unit_price_vnd?}]  (≤ 50; thiếu giá ⇒ lấy list_price_vnd của chiếc — D3)
-- Trả về { order_id, status, version, customer_id, deposit_payment_id,
--          warning: 'WAITING_FOR_STOCK' | null, lines: [{unit_id, code, unit_price_vnd}] }
create or replace function public.save_order(p_order_id uuid, p_order jsonb, p_lines jsonb, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := private.require_uid();
  v_order     public.orders%rowtype;
  v_id        uuid;
  v_ids       uuid[];
  v_cust      uuid;
  v_payer     text;
  v_ship      bigint;
  v_date      date;
  v_deposit   bigint;
  v_dep_meth  text;
  v_pay_id    uuid;
  v_status    text;
  v_all_ready boolean := true;
  v_missing   uuid;
  r           record;
  v_out       jsonb;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_order';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'ORDER_HAS_NO_LINES';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_LINES';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
              where jsonb_typeof(e) <> 'object' or nullif(e->>'unit_id', '') is null) then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'unit_id';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e where (e->>'unit_price_vnd')::bigint < 0) then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'unit_price_vnd';
  end if;
  v_ids := array(select (e->>'unit_id')::uuid from jsonb_array_elements(p_lines) e);
  if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_UNIT';
  end if;

  v_ship     := coalesce(nullif(p_order->>'ship_fee_vnd', '')::bigint, 0);
  v_deposit  := coalesce(nullif(p_order->>'deposit_vnd', '')::bigint, 0);
  v_dep_meth := coalesce(nullif(p_order->>'deposit_method', ''), 'transfer');            -- CR-004
  v_payer    := coalesce(nullif(p_order->>'ship_fee_payer', ''),
                         (select default_ship_fee_payer from public.settings where user_id = v_uid), 'customer');
  if v_ship < 0 or v_deposit < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if v_payer not in ('customer','shop') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'ship_fee_payer';
  end if;
  if v_dep_meth not in ('transfer','cash') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'deposit_method';
  end if;
  if p_order_id is not null and v_deposit > 0 then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ONLY_ON_CREATE';
  end if;

  -- (1) Khoá CHIA SẺ các lô của chiếc được chọn: chặn receive_lot / cancel_lot / save_lot chạy chen giữa
  perform 1 from public.lots
   where id in (select lot_id from public.units where id = any (v_ids) and user_id = v_uid)
   order by id for share;

  -- (2) Đơn
  if p_order_id is not null then
    select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
    if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
    if v_order.status not in ('preorder','confirmed') then
      raise exception using errcode = 'P0001', message = 'ORDER_LOCKED';
    end if;
    perform private.check_version(p_expected_version, v_order.version);
  end if;

  -- (3) Khoá các chiếc theo thứ tự id: 2 thiết bị chọn cùng 1 chiếc ⇒ máy sau chờ rồi bị từ chối
  perform 1 from public.units where id = any (v_ids) and user_id = v_uid order by id for update;
  select x into v_missing from unnest(v_ids) x
   where not exists (select 1 from public.units u where u.id = x and u.user_id = v_uid) limit 1;
  if v_missing is not null then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND', detail = v_missing::text;
  end if;

  for r in select u.id, u.code, l.status as lot_status, h.order_id, h.status as order_status
             from public.units u
             join public.lots l on l.id = u.lot_id
             left join lateral (
               select ol.order_id, o.status from public.order_lines ol join public.orders o on o.id = ol.order_id
                where ol.unit_id = u.id and not ol.cancelled
                  and (p_order_id is null or ol.order_id <> p_order_id)
                limit 1) h on true
            where u.id = any (v_ids)
            order by u.code
  loop
    if r.lot_status = 'cancelled' then
      raise exception using errcode = 'P0001', message = 'UNIT_NOT_AVAILABLE',
        detail = jsonb_build_object('unit_id', r.id, 'code', r.code, 'reason', 'lot_cancelled')::text;
    end if;
    if r.order_id is not null then
      raise exception using errcode = 'P0001', message = 'UNIT_NOT_AVAILABLE',
        detail = jsonb_build_object('unit_id', r.id, 'code', r.code, 'order_id', r.order_id,
                   'reason', case when r.order_status in ('shipped','completed') then 'sold' else 'reserved' end)::text;
    end if;
    if r.lot_status <> 'received' then
      v_all_ready := false;
    end if;
  end loop;
  v_status := case when v_all_ready then 'confirmed' else 'preorder' end;          -- A6

  -- Khách: có sẵn hoặc tạo mới trong cùng transaction
  v_cust := nullif(p_order->>'customer_id', '')::uuid;
  if v_cust is not null then
    if not exists (select 1 from public.customers where id = v_cust and user_id = v_uid) then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_NOT_FOUND';
    end if;
  elsif jsonb_typeof(p_order->'new_customer') = 'object'
        and nullif(btrim(p_order->'new_customer'->>'fb_name'), '') is not null then
    insert into public.customers (user_id, fb_name, fb_url, phone, address, note)
    values (v_uid, btrim(p_order->'new_customer'->>'fb_name'),
            nullif(btrim(p_order->'new_customer'->>'fb_url'), ''), nullif(btrim(p_order->'new_customer'->>'phone'), ''),
            nullif(btrim(p_order->'new_customer'->>'address'), ''), nullif(btrim(p_order->'new_customer'->>'note'), ''))
    returning id into v_cust;
  else
    raise exception using errcode = 'P0001', message = 'CUSTOMER_REQUIRED';
  end if;

  if p_order_id is null then
    v_date := coalesce(nullif(p_order->>'order_date', '')::date, private.today_vn());
    insert into public.orders (user_id, customer_id, order_date, status, tracking_no, ship_fee_vnd, ship_fee_payer, note)
    values (v_uid, v_cust, v_date, v_status, nullif(btrim(p_order->>'tracking_no'), ''), v_ship, v_payer,
            nullif(p_order->>'note', ''))
    returning id into v_id;
  else
    v_date := coalesce(nullif(p_order->>'order_date', '')::date, v_order.order_date);
    update public.orders set
      customer_id = v_cust, order_date = v_date, status = v_status,
      tracking_no = nullif(btrim(p_order->>'tracking_no'), ''), ship_fee_vnd = v_ship,
      ship_fee_payer = v_payer, note = nullif(p_order->>'note', '')
    where id = p_order_id;
    v_id := p_order_id;
    delete from public.order_lines where order_id = v_id;          -- chưa gửi ⇒ thay toàn bộ dòng an toàn
  end if;

  begin
    insert into public.order_lines (user_id, order_id, line_no, unit_id, unit_price_vnd)
    select v_uid, v_id, x.ord::smallint, u.id, coalesce((x.e->>'unit_price_vnd')::bigint, u.list_price_vnd)
      from jsonb_array_elements(p_lines) with ordinality as x(e, ord)
      join public.units u on u.id = (x.e->>'unit_id')::uuid;
  exception
    when not_null_violation then
      raise exception using errcode = 'P0001', message = 'UNIT_PRICE_REQUIRED';
    when unique_violation then                 -- lưới an toàn (index một phần), bình thường đã chặn ở trên
      raise exception using errcode = 'P0001', message = 'UNIT_NOT_AVAILABLE';
  end;

  if v_deposit > 0 then
    insert into public.payments (user_id, order_id, paid_at, kind, amount_vnd, note, method)
    values (v_uid, v_id, coalesce(nullif(p_order->>'deposit_paid_at', '')::date, v_date), 'deposit', v_deposit, 'Cọc khi tạo đơn',
            v_dep_meth)
    returning id into v_pay_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('unit_id', u.id, 'code', u.code, 'unit_price_vnd', ol.unit_price_vnd)
                            order by ol.line_no), '[]'::jsonb)
    into v_out
    from public.order_lines ol join public.units u on u.id = ol.unit_id
   where ol.order_id = v_id;

  return jsonb_build_object('order_id', v_id, 'status', v_status,
                            'version', (select version from public.orders where id = v_id),
                            'customer_id', v_cust, 'deposit_payment_id', v_pay_id,
                            'warning', case when v_status = 'preorder' then 'WAITING_FOR_STOCK' end,
                            'lines', v_out);
end $$;

-- ship_order(p_order_id, p_tracking_no text|null, p_shipped_at date|null, p_expected_version, p_cod_amount_vnd bigint|null)
--   → { order_id, status: 'shipped', shipped_at, cod_amount_vnd, version }
-- Chỉ từ Đã chốt (Q-007); mọi chiếc phải đã về kho (A8). Không chụp giá vốn (A8: lãi theo giá nhập hiện tại).
-- CR-004 DON-S1: p_cod_amount_vnd = tiền hãng ship thu hộ (≥ 0; null ⇒ giữ giá trị đang có, mặc định 0).
create or replace function public.ship_order(p_order_id uuid, p_tracking_no text default null,
                                             p_shipped_at date default null, p_expected_version int default null,
                                             p_cod_amount_vnd bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
  v_not   jsonb;
begin
  if p_cod_amount_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'cod_amount_vnd';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_CONFIRMED';
  end if;
  perform private.check_version(p_expected_version, v_order.version);
  v_not := private.order_unreceived_codes(p_order_id);
  if jsonb_array_length(v_not) > 0 then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_RECEIVED', detail = v_not::text;
  end if;

  update public.orders
     set status = 'shipped', shipped_at = coalesce(p_shipped_at, private.today_vn()),
         tracking_no = coalesce(nullif(btrim(p_tracking_no), ''), tracking_no),
         cod_amount_vnd = coalesce(p_cod_amount_vnd, cod_amount_vnd)
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', 'shipped',
                            'shipped_at', (select shipped_at from public.orders where id = p_order_id),
                            'cod_amount_vnd', (select cod_amount_vnd from public.orders where id = p_order_id),
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- set_order_cod(p_order_id, p_cod_amount_vnd bigint ≥ 0, p_expected_version) → { order_id, cod_amount_vnd, version }
-- CR-004 DON-S1: sửa số COD hãng ship thu hộ khi đơn ĐANG Đã gửi. Đơn chưa gửi ⇒ ORDER_NOT_SHIPPED (đặt COD lúc
-- ship_order); Hoàn tất / Huỷ / Hoàn hàng ⇒ ORDER_LOCKED.
create or replace function public.set_order_cod(p_order_id uuid, p_cod_amount_vnd bigint, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
begin
  if p_cod_amount_vnd is null or p_cod_amount_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'cod_amount_vnd';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('preorder','confirmed') then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_SHIPPED';
  end if;
  if v_order.status <> 'shipped' then
    raise exception using errcode = 'P0001', message = 'ORDER_LOCKED';
  end if;
  perform private.check_version(p_expected_version, v_order.version);
  update public.orders set cod_amount_vnd = p_cod_amount_vnd where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'cod_amount_vnd', p_cod_amount_vnd,
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- return_order(p_order_id, p_keep_deposit boolean, p_return_ship_fee_vnd bigint ≥ 0 (null = 0),
--              p_returned_at date|null (mặc định hôm nay, không trước ngày gửi), p_note text|null (≤ 1000),
--              p_expected_version)
--   → { order_id, status: 'returned', returned_at, keep_deposit, return_ship_fee_vnd, refund_due_vnd, profit_vnd,
--       released_unit_ids: [uuid], version }
-- CR-004 DON-S3 "Hoàn hàng / khách không nhận": CHỈ từ Đã gửi (khác ⇒ ORDER_NOT_RETURNABLE, detail = trạng thái).
-- Nhả mọi dòng đơn (order_lines.cancelled = true) ⇒ chiếc về Trong kho, bán lại được. Luật tiền: xem đầu file.
-- Tiền đã thu không tự hoàn: cần hoàn hiện ở v_order_summary.refund_due_vnd tới khi ghi khoản 'refund'.
create or replace function public.return_order(p_order_id uuid, p_keep_deposit boolean, p_return_ship_fee_vnd bigint,
                                               p_returned_at date default null, p_note text default null,
                                               p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := private.require_uid();
  v_order    public.orders%rowtype;
  v_fee      bigint := coalesce(p_return_ship_fee_vnd, 0);
  v_note     text := nullif(btrim(p_note), '');
  v_date     date;
  v_released jsonb;
begin
  if p_keep_deposit is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_keep_deposit';
  end if;
  if v_fee < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'return_ship_fee_vnd';
  end if;
  if length(v_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'note';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'shipped' then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_RETURNABLE', detail = v_order.status;
  end if;
  perform private.check_version(p_expected_version, v_order.version);

  v_date := coalesce(p_returned_at, greatest(private.today_vn(), v_order.shipped_at));
  if v_date < v_order.shipped_at then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'returned_at';
  end if;

  update public.orders
     set status = 'returned', returned_at = v_date, keep_deposit = p_keep_deposit,
         return_ship_fee_vnd = v_fee, return_note = v_note
   where id = p_order_id;
  with upd as (
    update public.order_lines set cancelled = true where order_id = p_order_id and not cancelled returning unit_id
  ) select coalesce(jsonb_agg(unit_id), '[]'::jsonb) into v_released from upd;

  return (select jsonb_build_object('order_id', p_order_id, 'status', 'returned', 'returned_at', v_date,
                                    'keep_deposit', p_keep_deposit, 'return_ship_fee_vnd', v_fee,
                                    'refund_due_vnd', s.refund_due_vnd, 'profit_vnd', s.profit_vnd,
                                    'released_unit_ids', v_released, 'version', s.version)
            from public.v_order_summary s where s.order_id = p_order_id);
end $$;

-- Quyền thực thi: chỉ authenticated (hàm mới mặc định cho PUBLIC execute ⇒ revoke)
revoke execute on function public.receive_lot(uuid, bigint, date, int, jsonb) from public, anon;
revoke execute on function public.ship_order(uuid, text, date, int, bigint) from public, anon;
revoke execute on function public.set_order_cod(uuid, bigint, int) from public, anon;
revoke execute on function public.return_order(uuid, boolean, bigint, date, text, int) from public, anon;
revoke execute on function public.update_unit(uuid, jsonb, int) from public, anon;
revoke execute on function public.save_order(uuid, jsonb, jsonb, int) from public, anon;
grant execute on function
  public.receive_lot(uuid, bigint, date, int, jsonb),
  public.ship_order(uuid, text, date, int, bigint),
  public.set_order_cod(uuid, bigint, int),
  public.return_order(uuid, boolean, bigint, date, text, int),
  public.update_unit(uuid, jsonb, int),
  public.save_order(uuid, jsonb, jsonb, int)
to authenticated;

-- 4. Không tính lại dữ liệu cũ: chiếc cũ = 'new', khoản thu cũ = 'transfer', đơn cũ COD 0 / không hoàn hàng
--    ⇒ mọi số liệu cũ giữ nguyên. Realtime: không có bảng mới ⇒ publication giữ nguyên.

commit;

-- PostgREST (API Supabase) nạp lại cấu trúc để app thấy cột / RPC mới ngay
notify pgrst, 'reload schema';
