-- =============================================================================
-- Kho Cối — 005_cash_status_qr.sql: CR-005 (phần DỮ LIỆU) — trạng thái lô thống nhất, trả trung gian theo lô,
--   sổ quỹ (cash_entries), xoá đơn, tài khoản VietQR, vốn gồm hàng đang về.
-- Nguồn: 1.5-change-control/draft/CR_005_so-quy-trang-thai-qr.md §"Dữ liệu" + bảng "Quyết định của Chủ dự án".
-- Migration CỘNG THÊM cho database ĐANG CHẠY (setup-v2 bản pre-003 + 002 + 003 + 004) có DỮ LIỆU THẬT.
--
--   * lots.status        còn 4 mã: cn_warehouse (Kho TQ) · vn_warehouse (Kho VN) · received (Kho Lumi) · cancelled.
--                        CHUYỂN DỮ LIỆU: ordered / cn_shipping / at_forwarder → cn_warehouse; vn_shipping → vn_warehouse
--                        (dòng lô đổi trạng thái ⇒ version + 1 như mọi lần sửa). Mặc định lô mới = cn_warehouse.
--                        save_lot / set_lot_status vẫn NHẬN mã cũ (app cũ đang mở trên máy khác) và tự đổi sang mã mới.
--                        set_lot_status chỉ đi TỚI: cn_warehouse → vn_warehouse (lùi ⇒ INVALID_STATUS_TRANSITION;
--                        sửa nhầm thì sửa lô qua save_lot). receive_lot nhận từ mọi trạng thái mở (không đổi).
--                        Mã đơn GIỮ NGUYÊN (shipped = "Vận chuyển tới khách", completed = "Đã giao" — chỉ đổi nhãn ở app).
--   * intermediary_txns  khoản 'transfer' được gắn lot_id (tuỳ chọn) ⇒ biết lô nào đã trả. Ràng buộc itx_payable_has_lot
--                        thay bằng itx_lot_by_kind: payable PHẢI có lô, adjustment KHÔNG có lô, transfer tuỳ ý.
--                        Client ghi / sửa được cột lot_id của khoản Đã chuyển (FK (lot_id, user_id) ⇒ chỉ lô của mình).
--   * v_lot_summary      + paid_vnd (Σ transfer gắn lô), outstanding_vnd (= payable_vnd − paid_vnd; âm = trả dư) — cột CUỐI
--   * pay_lot(p_lot_id, p_paid_at, p_note)  ghi 1 khoản Đã chuyển = phần còn nợ của lô (0 ⇒ LOT_ALREADY_PAID).
--   * save_lot           p_lot.paid_now (bool, chỉ khi TẠO): true ⇒ ghi khoản Đã chuyển = phải trả lúc tạo (ngày = ngày đặt).
--                        Sửa lô mà thiếu khoá status ⇒ GIỮ trạng thái hiện tại (trước đây về 'ordered').
--   * cash_entries       SỔ QUỸ (một quỹ chung, bắt đầu từ 0 — không có số dư đầu kỳ). Bút toán tự sinh (is_auto, trigger):
--                          khoản thu khách deposit / payment → in 'customer_payment'; refund → out 'customer_refund'
--                          khoản Đã chuyển trung gian (> 0) → out 'intermediary' (kèm lot_id nếu có)
--                          đơn đã gửi (shipped / completed / returned) và ship_fee_payer = 'shop', phí > 0 → out 'ship_shop'
--                          đơn Hoàn hàng có return_ship_fee_vnd > 0 → out 'return_ship'
--                        Sửa nguồn ⇒ bút toán sửa theo; xoá nguồn ⇒ bút toán xoá theo (FK on delete cascade).
--                        Bút toán ghi tay: expense (có expense_category) / capital_in / capital_out / adjustment (in hoặc out).
--                        Client chỉ thêm / sửa / xoá bút toán ghi tay (RLS + quyền theo cột); bút toán tự sinh chỉ đọc.
--                        BACKFILL: tạo bút toán tự sinh cho TOÀN BỘ dữ liệu cũ ⇒ số dư quỹ phản ánh lịch sử.
--   * v_cash_balance     (user_id, total_in_vnd, total_out_vnd, balance_vnd, entry_count) — 1 dòng / người dùng (theo settings)
--   * v_cash_monthly     theo tháng: in / out / net + tách theo loại.
--   * delete_order(p_order_id, p_expected_version)  xoá HẲN đơn (mọi trạng thái): dòng đơn (nhả chiếc), khoản thu
--                        (+ bút toán sổ quỹ), bút toán ship.
--   * settings           + bank_bin (6 số BIN NAPAS), bank_account_no (1..19 chữ / số), bank_account_name (1..50 ký tự)
--                        cho VietQR. bank_info cũ giữ làm dòng chữ in trong tin nhắn.
--   * v_model_stock      + incoming_value_vnd (giá nhập chiếc đang về, chưa nhận, chưa bán), total_capital_vnd
--                        (= stock_value_vnd + incoming_value_vnd) — cột CUỐI
--   * Realtime: thêm public.cash_entries.
-- Mã lỗi mới: LOT_ALREADY_PAID (pay_lot khi lô không còn nợ; detail {payable_vnd, paid_vnd, outstanding_vnd}),
--             INVALID_STATUS_TRANSITION (set_lot_status lùi Kho VN → Kho TQ; detail 'from→to').
--
-- LƯU Ý: sau 005, KHÔNG chạy lại 002 / 003 (thay v_lot_summary bằng bản ít cột ⇒ lỗi "cannot drop columns from view",
--        transaction huỷ — không hỏng gì, nhưng vô ích).
-- Chạy được nhiều lần (idempotent), 1 transaction: lỗi giữa chừng ⇒ không đổi gì.
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-005 (test so schema: cài mới = pre-003 + 002..005).
-- Cách chạy: CI (scripts/apply-migrations.sh theo deploy-order.txt) hoặc Supabase SQL Editor → dán TOÀN BỘ file → Run.
-- =============================================================================

begin;

-- 0. Chặn chạy nhầm: phải có schema v2 + 002 + 003 + 004
do $$
begin
  if to_regclass('public.units') is null or to_regclass('public.lots') is null or to_regclass('public.settings') is null then
    raise exception 'Chưa có schema v2 (public.units / lots / settings) — cài setup-v2.sql trước, đừng chạy 005 trên DB v1.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payments' and column_name = 'method') then
    raise exception 'Chưa chạy 003_cod_return_condition.sql (thiếu payments.method) — chạy 002, 003, 004 trước rồi mới chạy 005.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'notes' and column_name = 'color') then
    raise exception 'Chưa chạy 004_note_color.sql (thiếu notes.color) — chạy 004 trước rồi mới chạy 005.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Trạng thái lô: chuyển dữ liệu + ràng buộc mới
-- -----------------------------------------------------------------------------
alter table public.lots drop constraint if exists lots_status_check;
update public.lots
   set status = case when status = 'vn_shipping' then 'vn_warehouse' else 'cn_warehouse' end
 where status in ('ordered','cn_shipping','at_forwarder','vn_shipping');
alter table public.lots add constraint lots_status_check
  check (status in ('cn_warehouse','vn_warehouse','received','cancelled'));
alter table public.lots alter column status set default 'cn_warehouse';

-- -----------------------------------------------------------------------------
-- 2. Khoản Đã chuyển gắn lô (tuỳ chọn)
-- -----------------------------------------------------------------------------
alter table public.intermediary_txns drop constraint if exists itx_payable_has_lot;
alter table public.intermediary_txns drop constraint if exists itx_lot_by_kind;
alter table public.intermediary_txns add constraint itx_lot_by_kind
  check (kind = 'transfer' or (kind = 'payable') = (lot_id is not null));
grant insert (lot_id) on public.intermediary_txns to authenticated;
grant update (lot_id) on public.intermediary_txns to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Cài đặt VietQR (cột CUỐI; check tự đặt tên settings_<cột>_check như cài mới)
-- -----------------------------------------------------------------------------
alter table public.settings
  add column if not exists bank_bin text check (bank_bin ~ '^[0-9]{6}$'),
  add column if not exists bank_account_no text check (bank_account_no ~ '^[0-9A-Za-z]{1,19}$'),
  add column if not exists bank_account_name text check (length(btrim(bank_account_name)) between 1 and 50);
grant select, insert, update on public.settings to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sổ quỹ
-- -----------------------------------------------------------------------------
create table if not exists public.cash_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date        date not null default private.today_vn(),
  direction         text not null check (direction in ('in','out')),
  amount_vnd        bigint not null check (amount_vnd > 0),
  kind              text not null check (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship',
                                                  'expense','capital_in','capital_out','adjustment')),
  expense_category  text check (length(btrim(expense_category)) between 1 and 60),
  note              text check (length(note) <= 1000),
  payment_id        uuid references public.payments(id) on delete cascade,
  txn_id            uuid references public.intermediary_txns(id) on delete cascade,
  order_id          uuid references public.orders(id) on delete cascade,
  lot_id            uuid references public.lots(id) on delete cascade,
  is_auto           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int not null default 1,
  constraint cash_kind_direction check (
    (kind in ('customer_payment','capital_in') and direction = 'in')
    or (kind in ('customer_refund','intermediary','ship_shop','return_ship','expense','capital_out') and direction = 'out')
    or kind = 'adjustment'),
  constraint cash_auto_kind check (is_auto = (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship'))),
  constraint cash_expense_category check (kind = 'expense' or expense_category is null),
  constraint cash_auto_source check (
    (kind not in ('customer_payment','customer_refund') or payment_id is not null)
    and (kind <> 'intermediary' or txn_id is not null)
    and (kind not in ('ship_shop','return_ship') or order_id is not null)),
  constraint cash_manual_no_source check (is_auto or (payment_id is null and txn_id is null and order_id is null and lot_id is null))
);
create unique index if not exists cash_entries_payment_uq on public.cash_entries (payment_id);
create unique index if not exists cash_entries_txn_uq     on public.cash_entries (txn_id);
create unique index if not exists cash_entries_ship_uq    on public.cash_entries (order_id, kind) where kind in ('ship_shop','return_ship');
create index if not exists cash_entries_user_date_idx     on public.cash_entries (user_id, entry_date);
create index if not exists cash_entries_order_idx         on public.cash_entries (order_id);
create index if not exists cash_entries_lot_idx           on public.cash_entries (lot_id);

drop trigger if exists cash_entries_touch on public.cash_entries;
create trigger cash_entries_touch before insert or update on public.cash_entries
  for each row execute function private.touch_row();

-- Quyền + RLS: đọc mọi bút toán; ghi / sửa / xoá tay chỉ bút toán ghi tay (expense / capital_in / capital_out / adjustment).
-- is_auto + cột liên kết không được grant ⇒ client không tự tạo bút toán tự sinh (check cash_auto_kind chặn thêm lần nữa).
revoke all on public.cash_entries from anon, authenticated;
grant select, delete on public.cash_entries to authenticated;
grant insert (entry_date, direction, amount_vnd, kind, expense_category, note) on public.cash_entries to authenticated;
grant update (entry_date, direction, amount_vnd, kind, expense_category, note) on public.cash_entries to authenticated;
alter table public.cash_entries enable row level security;
drop policy if exists cash_select on public.cash_entries;
drop policy if exists cash_insert on public.cash_entries;
drop policy if exists cash_update on public.cash_entries;
drop policy if exists cash_delete on public.cash_entries;
create policy cash_select on public.cash_entries for select to authenticated
  using (user_id = (select auth.uid()));
create policy cash_insert on public.cash_entries for insert to authenticated
  with check (user_id = (select auth.uid()) and not is_auto and kind in ('expense','capital_in','capital_out','adjustment'));
create policy cash_update on public.cash_entries for update to authenticated
  using (user_id = (select auth.uid()) and not is_auto and kind in ('expense','capital_in','capital_out','adjustment'))
  with check (user_id = (select auth.uid()) and not is_auto and kind in ('expense','capital_in','capital_out','adjustment'));
create policy cash_delete on public.cash_entries for delete to authenticated
  using (user_id = (select auth.uid()) and not is_auto and kind in ('expense','capital_in','capital_out','adjustment'));

-- -----------------------------------------------------------------------------
-- 5. Hàm nội bộ: đổi mã trạng thái cũ + đồng bộ bút toán tự sinh (SECURITY DEFINER: trigger chạy khi client ghi
--    payments / intermediary_txns trực tiếp, mà client không được ghi bút toán tự sinh)
-- -----------------------------------------------------------------------------

-- Mã trạng thái lô cũ (trước CR-005) → mã mới; mã khác giữ nguyên (null ⇒ null).
create or replace function private.normalize_lot_status(p_status text) returns text
language sql immutable set search_path = '' as $$
  select case when p_status in ('ordered','cn_shipping','at_forwarder') then 'cn_warehouse'
              when p_status = 'vn_shipping' then 'vn_warehouse'
              else p_status end
$$;

-- Khoản thu khách → bút toán: deposit / payment ⇒ in 'customer_payment'; refund ⇒ out 'customer_refund'.
create or replace function private.cash_sync_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payments%rowtype;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then
    delete from public.cash_entries where payment_id = p_payment_id;
    return;
  end if;
  insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, note, payment_id, order_id, is_auto)
  values (p.user_id, p.paid_at, case when p.kind = 'refund' then 'out' else 'in' end, p.amount_vnd,
          case when p.kind = 'refund' then 'customer_refund' else 'customer_payment' end, p.note, p.id, p.order_id, true)
  on conflict (payment_id) do update
     set user_id = excluded.user_id, entry_date = excluded.entry_date, direction = excluded.direction,
         amount_vnd = excluded.amount_vnd, kind = excluded.kind, note = excluded.note, order_id = excluded.order_id
   where (c.user_id, c.entry_date, c.direction, c.amount_vnd, c.kind, c.note, c.order_id)
         is distinct from (excluded.user_id, excluded.entry_date, excluded.direction, excluded.amount_vnd, excluded.kind,
                           excluded.note, excluded.order_id);
end $$;

-- Khoản trung gian → bút toán: chỉ 'transfer' > 0 ⇒ out 'intermediary' (kèm lot_id). Khác ⇒ không có bút toán.
create or replace function private.cash_sync_txn(p_txn_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.intermediary_txns%rowtype;
begin
  select * into t from public.intermediary_txns where id = p_txn_id;
  if not found or t.kind <> 'transfer' or t.amount_vnd <= 0 then
    delete from public.cash_entries where txn_id = p_txn_id;
    return;
  end if;
  insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, note, txn_id, lot_id, is_auto)
  values (t.user_id, t.txn_date, 'out', t.amount_vnd, 'intermediary', t.note, t.id, t.lot_id, true)
  on conflict (txn_id) do update
     set user_id = excluded.user_id, entry_date = excluded.entry_date, amount_vnd = excluded.amount_vnd,
         note = excluded.note, lot_id = excluded.lot_id
   where (c.user_id, c.entry_date, c.amount_vnd, c.note, c.lot_id)
         is distinct from (excluded.user_id, excluded.entry_date, excluded.amount_vnd, excluded.note, excluded.lot_id);
end $$;

-- Đơn → bút toán ship: 'ship_shop' khi đơn đã gửi (shipped / completed / returned), shop chịu ship, phí > 0 (ngày gửi);
-- 'return_ship' khi đơn Hoàn hàng có phí ship chiều về > 0 (ngày hoàn). Hết điều kiện ⇒ xoá bút toán.
create or replace function private.cash_sync_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    delete from public.cash_entries where order_id = p_order_id and kind in ('ship_shop','return_ship');
    return;
  end if;
  if o.status in ('shipped','completed','returned') and o.ship_fee_payer = 'shop' and o.ship_fee_vnd > 0 then
    insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, order_id, is_auto)
    values (o.user_id, o.shipped_at, 'out', o.ship_fee_vnd, 'ship_shop', o.id, true)
    on conflict (order_id, kind) where kind in ('ship_shop','return_ship') do update
       set user_id = excluded.user_id, entry_date = excluded.entry_date, amount_vnd = excluded.amount_vnd
     where (c.user_id, c.entry_date, c.amount_vnd) is distinct from (excluded.user_id, excluded.entry_date, excluded.amount_vnd);
  else
    delete from public.cash_entries where order_id = p_order_id and kind = 'ship_shop';
  end if;
  if o.status = 'returned' and o.return_ship_fee_vnd > 0 then
    insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, order_id, is_auto)
    values (o.user_id, o.returned_at, 'out', o.return_ship_fee_vnd, 'return_ship', o.id, true)
    on conflict (order_id, kind) where kind in ('ship_shop','return_ship') do update
       set user_id = excluded.user_id, entry_date = excluded.entry_date, amount_vnd = excluded.amount_vnd
     where (c.user_id, c.entry_date, c.amount_vnd) is distinct from (excluded.user_id, excluded.entry_date, excluded.amount_vnd);
  else
    delete from public.cash_entries where order_id = p_order_id and kind = 'return_ship';
  end if;
end $$;

-- Trigger (sau insert / update; xoá nguồn ⇒ FK on delete cascade xoá bút toán)
create or replace function private.cash_on_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.cash_sync_payment(new.id);
  return null;
end $$;

create or replace function private.cash_on_txn() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'transfer' then
    perform private.cash_sync_txn(new.id);
  end if;
  return null;
end $$;

create or replace function private.cash_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.cash_sync_order(new.id);
  return null;
end $$;

drop trigger if exists payments_cash on public.payments;
create trigger payments_cash after insert or update on public.payments
  for each row execute function private.cash_on_payment();
drop trigger if exists intermediary_txns_cash on public.intermediary_txns;
create trigger intermediary_txns_cash after insert or update on public.intermediary_txns
  for each row execute function private.cash_on_txn();
drop trigger if exists orders_cash on public.orders;
create trigger orders_cash
  after insert or update of status, ship_fee_vnd, ship_fee_payer, shipped_at, returned_at, return_ship_fee_vnd on public.orders
  for each row execute function private.cash_on_order();

revoke execute on function private.normalize_lot_status(text) from public, anon, authenticated;
revoke execute on function private.cash_sync_payment(uuid) from public, anon, authenticated;
revoke execute on function private.cash_sync_txn(uuid) from public, anon, authenticated;
revoke execute on function private.cash_sync_order(uuid) from public, anon, authenticated;
revoke execute on function private.cash_on_payment() from public, anon, authenticated;
revoke execute on function private.cash_on_txn() from public, anon, authenticated;
revoke execute on function private.cash_on_order() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. View (cột mới ở CUỐI ⇒ create or replace view; security_invoker = true)
-- -----------------------------------------------------------------------------

-- Tồn theo model (A9). in_stock KHÔNG gồm chiếc đã giữ; on_hand = đã về kho & chưa bán (gồm đã giữ);
-- sellable = Trong kho + Đang về chưa giữ; is_low_stock = sellable ≤ ngưỡng.
-- stock_value_vnd = Σ giá nhập hiệu lực của chiếc ĐÃ VỀ KHO và chưa bán (Trong kho + Đã giữ đã về).
-- CR-005 (cột CUỐI): incoming_value_vnd = Σ giá nhập chiếc CHƯA VỀ (Kho TQ / Kho VN, gồm chiếc đã giữ cho đơn đặt trước);
--   total_capital_vnd = stock_value_vnd + incoming_value_vnd (vốn đang nằm ở hàng).
create or replace view public.v_model_stock with (security_invoker = true) as
select m.id                    as model_id,
       m.user_id,
       m.name                  as model_name,
       m.brand,
       m.code_prefix,
       m.is_active,
       m.sort_order,
       m.default_list_price_vnd,
       m.low_stock_threshold,
       count(vu.unit_id) filter (where vu.status = 'in_stock')::int                     as in_stock_count,
       count(vu.unit_id) filter (where vu.status = 'incoming')::int                     as incoming_count,
       count(vu.unit_id) filter (where vu.status = 'reserved')::int                     as reserved_count,
       count(vu.unit_id) filter (where vu.status = 'reserved' and vu.is_received)::int  as reserved_received_count,
       count(vu.unit_id) filter (where vu.is_received and vu.status in ('in_stock','reserved'))::int as on_hand_count,
       count(vu.unit_id) filter (where vu.status = 'sold')::int                         as sold_count,
       count(vu.unit_id) filter (where vu.status in ('in_stock','incoming'))::int       as sellable_count,
       coalesce(sum(vu.cost_vnd) filter (where vu.is_received and vu.status in ('in_stock','reserved')), 0)::bigint
                                                                                        as stock_value_vnd,
       count(vu.unit_id) filter (where vu.status in ('in_stock','incoming')) <= m.low_stock_threshold
                                                                                        as is_low_stock,
       coalesce(sum(vu.cost_vnd) filter (where not vu.is_received and vu.status in ('incoming','reserved')), 0)::bigint
                                                                                        as incoming_value_vnd,
       coalesce(sum(vu.cost_vnd) filter (where vu.status in ('in_stock','incoming','reserved')), 0)::bigint
                                                                                        as total_capital_vnd
from public.models m
left join public.v_units vu on vu.model_id = m.id
group by m.id;

-- Lô: số chiếc, tiền hàng, phải trả (BR-12, A4), đếm theo trạng thái chiếc, tóm tắt theo model.
-- CR-003 (cột thêm ở CUỐI để 002 dùng được create or replace view): buying_fee_pct, buying_fee_vnd = round(Σ¥ × tỷ giá × %/100).
-- goods_vnd giữ nghĩa cũ (Σ¥ × tỷ giá, CHƯA gồm phí mua hộ).
-- CR-004 (cột CUỐI): is_lot_late = lô chưa nhận / chưa huỷ và hôm nay − ngày đặt > settings.lot_late_days (mặc định 21).
-- CR-005 (cột CUỐI): paid_vnd = Σ khoản Đã chuyển gắn lô; outstanding_vnd = payable_vnd − paid_vnd (âm = trả dư).
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
        and private.today_vn() - l.ordered_at > coalesce(st.lot_late_days, 21))    as is_lot_late,
       coalesce(pd.paid_vnd, 0)::bigint                                       as paid_vnd,
       (coalesce(t.amount_vnd, 0) - coalesce(pd.paid_vnd, 0))::bigint         as outstanding_vnd
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
left join public.intermediary_txns t on t.lot_id = l.id and t.kind = 'payable'
left join lateral (
  select sum(x.amount_vnd) as paid_vnd from public.intermediary_txns x where x.lot_id = l.id and x.kind = 'transfer'
) pd on true;

-- Sổ quỹ: số dư = Σ vào − Σ ra (một quỹ chung, bắt đầu từ 0). 1 dòng / người dùng (theo settings ⇒ có dòng cả khi chưa có bút toán).
create or replace view public.v_cash_balance with (security_invoker = true) as
select st.user_id,
       coalesce(c.total_in_vnd, 0)::bigint                               as total_in_vnd,
       coalesce(c.total_out_vnd, 0)::bigint                              as total_out_vnd,
       (coalesce(c.total_in_vnd, 0) - coalesce(c.total_out_vnd, 0))::bigint as balance_vnd,
       coalesce(c.entry_count, 0)::int                                   as entry_count
from public.settings st
left join lateral (
  select sum(e.amount_vnd) filter (where e.direction = 'in')  as total_in_vnd,
         sum(e.amount_vnd) filter (where e.direction = 'out') as total_out_vnd,
         count(*)                                             as entry_count
  from public.cash_entries e where e.user_id = st.user_id
) c on true;

-- Sổ quỹ theo tháng (month = ngày đầu tháng của entry_date): vào / ra / ròng + tách theo loại (ship = ship_shop + return_ship;
-- adjustment_net = Σ điều chỉnh có dấu: in +, out −).
create or replace view public.v_cash_monthly with (security_invoker = true) as
select e.user_id,
       date_trunc('month', e.entry_date)::date                                                    as month,
       coalesce(sum(e.amount_vnd) filter (where e.direction = 'in'), 0)::bigint                   as in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.direction = 'out'), 0)::bigint                  as out_vnd,
       sum(case when e.direction = 'in' then e.amount_vnd else -e.amount_vnd end)::bigint         as net_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'customer_payment'), 0)::bigint          as customer_in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'customer_refund'), 0)::bigint           as refund_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'intermediary'), 0)::bigint              as intermediary_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind in ('ship_shop','return_ship')), 0)::bigint as ship_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'expense'), 0)::bigint                   as expense_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_in'), 0)::bigint                as capital_in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_out'), 0)::bigint               as capital_out_vnd,
       coalesce(sum(case when e.direction = 'in' then e.amount_vnd else -e.amount_vnd end)
                filter (where e.kind = 'adjustment'), 0)::bigint                                  as adjustment_net_vnd
from public.cash_entries e
group by e.user_id, date_trunc('month', e.entry_date);

revoke all on public.v_cash_balance, public.v_cash_monthly from anon, authenticated;
grant select on public.v_model_stock, public.v_lot_summary, public.v_cash_balance, public.v_cash_monthly to authenticated;

-- -----------------------------------------------------------------------------
-- 7. RPC (create or replace giữ chữ ký; RPC mới: pay_lot, delete_order)
-- -----------------------------------------------------------------------------

-- save_lot(p_lot_id uuid|null, p_lot jsonb, p_groups jsonb, p_expected_version int|null) → jsonb
-- Tạo / sửa lô CHƯA NHẬN (A2, A10). p_lot_id null = tạo mới.
--   p_lot = { goofish_url, goofish_item_id, seller_id | new_seller: {nickname, region, profile_url},
--             screenshot_path, listing_title, ordered_at 'YYYY-MM-DD', exchange_rate (bắt buộc > 0),
--             ship_fee_vnd (null = chưa biết), status ('cn_warehouse'|'vn_warehouse'; mã cũ ordered / cn_shipping /
--             at_forwarder / vn_shipping được tự đổi — CR-005; thiếu ⇒ TẠO: cn_warehouse, SỬA: giữ nguyên), note,
--             buying_fee_pct (CR-003: phí mua hộ % 0..100; thiếu / null ⇒ TẠO: lấy settings.default_buying_fee_pct,
--                             SỬA: giữ nguyên; lô đã nhận ⇒ LOT_LOCKED như tỷ giá),
--             paid_now (CR-005, bool, chỉ khi TẠO: true ⇒ ghi khoản Đã chuyển gắn lô = phải trả lúc tạo, ngày = ngày đặt;
--                       khi SỬA bị bỏ qua) }
--     (thay thế toàn bộ trường lô như v1; goofish_item_id tự tách từ ?id= của link nếu trống)
--   p_groups = mảng (≤ 50) gồm 2 loại phần tử:
--     * nhóm mới  {model_id, qty 1..1000, price_cny > 0, list_price_vnd?}  → tạo qty chiếc, mỗi chiếc 1 mã;
--                 thiếu khoá list_price_vnd ⇒ lấy models.default_list_price_vnd
--     * chiếc cũ  {unit_id, price_cny?, list_price_vnd?}  (chỉ khi sửa) → giữ chiếc đó, sửa giá nếu có khoá
--   Khi sửa: chiếc của lô KHÔNG có trong p_groups (theo unit_id) bị bỏ — chiếc đang thuộc đơn chưa huỷ ⇒
--   UNIT_RESERVED; chiếc chỉ thuộc đơn ĐÃ HUỶ ⇒ xoá luôn dòng đơn huỷ đó (trả về detached_cancelled_order_ids).
--   Mã của chiếc bị bỏ không bao giờ cấp lại.
-- Trả về { lot_id, version, created_units: [{unit_id, code, model_id}], removed_units: [{unit_id, code}],
--          detached_cancelled_order_ids: [uuid], duplicate_lot_ids: [uuid], payable_vnd,
--          paid_txn_id (CR-005: khoản trả khi tạo, null nếu không), outstanding_vnd (CR-005: còn nợ của lô) }
create or replace function public.save_lot(p_lot_id uuid, p_lot jsonb, p_groups jsonb, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := private.require_uid();
  v_lot       public.lots%rowtype;
  v_id        uuid;
  v_seller    uuid;
  v_status    text;
  v_url       text;
  v_item      text;
  v_rate      numeric;
  v_ship      bigint;
  v_fee       numeric;
  v_dups      uuid[];
  e           jsonb;
  r           record;
  v_keep      uuid[] := '{}';
  v_model     public.models%rowtype;
  v_qty       int;
  v_list      bigint;
  v_code      text;
  v_unit_id   uuid;
  v_hold      uuid;
  v_new       jsonb := '[]'::jsonb;
  v_removed   jsonb := '[]'::jsonb;
  v_detached  uuid[] := '{}';
  v_n         int;
  v_paid_now  boolean;
  v_pay       bigint;
  v_paid_txn  uuid;
begin
  if p_lot is null or jsonb_typeof(p_lot) <> 'object' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_lot';
  end if;
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) = 0 then
    raise exception using errcode = 'P0001', message = 'LOT_HAS_NO_LINES';
  end if;
  if jsonb_array_length(p_groups) > 1050 then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_LINES';
  end if;
  if p_lot ? 'paid_now' and jsonb_typeof(p_lot->'paid_now') not in ('boolean','null') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'paid_now';           -- CR-005
  end if;

  v_seller   := nullif(p_lot->>'seller_id', '')::uuid;
  v_status   := private.normalize_lot_status(nullif(p_lot->>'status', ''));               -- CR-005: mã cũ ⇒ mã mới
  v_url      := nullif(btrim(p_lot->>'goofish_url'), '');
  v_rate     := nullif(p_lot->>'exchange_rate', '')::numeric;
  v_ship     := nullif(p_lot->>'ship_fee_vnd', '')::bigint;
  v_fee      := nullif(p_lot->>'buying_fee_pct', '')::numeric;                -- CR-003
  v_paid_now := coalesce((p_lot->>'paid_now')::boolean, false);               -- CR-005

  if v_status is not null and v_status not in ('cn_warehouse','vn_warehouse') then
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS_FOR_SAVE';
  end if;
  if v_rate is null or v_rate <= 0 then
    raise exception using errcode = 'P0001', message = 'EXCHANGE_RATE_REQUIRED';                  -- BR-03
  end if;
  if v_ship < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'ship_fee_vnd';
  end if;
  if v_fee < 0 or v_fee > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'buying_fee_pct';
  end if;

  -- Kiểm tra từng phần tử trước khi ghi
  for e in select value from jsonb_array_elements(p_groups) loop
    if jsonb_typeof(e) <> 'object' then
      raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_groups[]';
    end if;
    if e ? 'price_cny' and (nullif(e->>'price_cny', '') is null or (e->>'price_cny')::numeric <= 0) then
      raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'price_cny';
    end if;
    if (e->>'list_price_vnd')::bigint < 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'list_price_vnd';
    end if;
    if e ? 'unit_id' then
      v_keep := v_keep || (e->>'unit_id')::uuid;
    else
      if nullif(e->>'model_id', '') is null then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'model_id';
      end if;
      if not (e ? 'price_cny') then
        raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'price_cny';
      end if;
      v_qty := (e->>'qty')::int;
      if v_qty is null or v_qty < 1 or v_qty > 1000 then
        raise exception using errcode = 'P0001', message = 'INVALID_QTY';
      end if;
    end if;
  end loop;
  if cardinality(v_keep) <> (select count(distinct k) from unnest(v_keep) k) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_UNIT';
  end if;
  if p_lot_id is null and cardinality(v_keep) > 0 then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND', detail = v_keep[1]::text;
  end if;

  v_item := coalesce(nullif(p_lot->>'goofish_item_id', ''), substring(v_url from '[?&]id=([0-9]{6,24})'));

  if v_seller is not null then
    if not exists (select 1 from public.sellers where id = v_seller and user_id = v_uid) then
      raise exception using errcode = 'P0001', message = 'SELLER_NOT_FOUND';
    end if;
  elsif p_lot ? 'new_seller' and nullif(btrim(p_lot->'new_seller'->>'nickname'), '') is not null then
    -- Người bán mới (DO_003 "tự tạo khi lưu lô")
    insert into public.sellers (user_id, nickname, region, profile_url)
    values (v_uid, btrim(p_lot->'new_seller'->>'nickname'),
            nullif(btrim(p_lot->'new_seller'->>'region'), ''), nullif(btrim(p_lot->'new_seller'->>'profile_url'), ''))
    returning id into v_seller;
  end if;

  -- Khoá model sẽ cấp mã, theo thứ tự id (2 lô cấp mã cùng lúc không deadlock)
  perform 1 from public.models
   where user_id = v_uid
     and id in (select (x->>'model_id')::uuid from jsonb_array_elements(p_groups) x where not x ? 'unit_id')
   order by id for update;

  if p_lot_id is null then
    insert into public.lots (user_id, goofish_url, goofish_item_id, seller_id, screenshot_path, listing_title,
                             ordered_at, exchange_rate, ship_fee_vnd, status, note, buying_fee_pct)
    values (v_uid, v_url, v_item, v_seller, nullif(p_lot->>'screenshot_path', ''), nullif(p_lot->>'listing_title', ''),
            coalesce(nullif(p_lot->>'ordered_at', '')::date, private.today_vn()),
            v_rate, v_ship, coalesce(v_status, 'cn_warehouse'), nullif(p_lot->>'note', ''),
            coalesce(v_fee, (select st.default_buying_fee_pct from public.settings st where st.user_id = v_uid), 0))
    returning id into v_id;
  else
    select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND';
    end if;
    if v_lot.status in ('received','cancelled') then
      raise exception using errcode = 'P0001', message = 'LOT_LOCKED';                            -- A10, Q-014
    end if;
    perform private.check_version(p_expected_version, v_lot.version);
    v_id := p_lot_id;

    -- Chiếc giữ lại phải thuộc chính lô này
    select k into v_unit_id from unnest(v_keep) k
     where not exists (select 1 from public.units u where u.id = k and u.lot_id = v_id) limit 1;
    if v_unit_id is not null then
      raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND', detail = v_unit_id::text;
    end if;

    update public.lots set
      goofish_url = v_url, goofish_item_id = v_item, seller_id = v_seller,
      screenshot_path = nullif(p_lot->>'screenshot_path', ''), listing_title = nullif(p_lot->>'listing_title', ''),
      ordered_at = coalesce(nullif(p_lot->>'ordered_at', '')::date, v_lot.ordered_at),
      exchange_rate = v_rate, ship_fee_vnd = v_ship, status = coalesce(v_status, v_lot.status), note = nullif(p_lot->>'note', ''),
      buying_fee_pct = coalesce(v_fee, v_lot.buying_fee_pct)
    where id = v_id;

    -- Bỏ chiếc không còn trong danh sách
    for r in select u.id, u.code from public.units u
              where u.lot_id = v_id and u.id <> all (v_keep) order by u.id for update
    loop
      select ol.order_id into v_hold from public.order_lines ol where ol.unit_id = r.id and not ol.cancelled limit 1;
      if found then
        raise exception using errcode = 'P0001', message = 'UNIT_RESERVED',
          detail = jsonb_build_object('unit_id', r.id, 'code', r.code, 'order_id', v_hold)::text;
      end if;
      v_detached := v_detached || array(select ol.order_id from public.order_lines ol where ol.unit_id = r.id);
      delete from public.order_lines where unit_id = r.id and cancelled;
      insert into private.unit_code_retired (user_id, code) values (v_uid, r.code) on conflict do nothing;
      delete from public.units where id = r.id;
      v_removed := v_removed || jsonb_build_object('unit_id', r.id, 'code', r.code);
    end loop;

    -- Sửa giá chiếc giữ lại (chỉ khoá có mặt)
    for e in select value from jsonb_array_elements(p_groups) where value ? 'unit_id' loop
      update public.units u
         set price_cny      = coalesce((e->>'price_cny')::numeric, u.price_cny),
             list_price_vnd = case when e ? 'list_price_vnd' then (e->>'list_price_vnd')::bigint else u.list_price_vnd end
       where u.id = (e->>'unit_id')::uuid
         and (u.price_cny, u.list_price_vnd) is distinct from
             (coalesce((e->>'price_cny')::numeric, u.price_cny),
              case when e ? 'list_price_vnd' then (e->>'list_price_vnd')::bigint else u.list_price_vnd end);
    end loop;
  end if;

  -- Nhóm mới → tạo qty chiếc (D1 mã tự đặt; D3 giá bán dự kiến điền sẵn từ model)
  for e in select value from jsonb_array_elements(p_groups) where not value ? 'unit_id' loop
    select * into v_model from public.models where id = (e->>'model_id')::uuid and user_id = v_uid;
    if not found then
      raise exception using errcode = 'P0001', message = 'MODEL_NOT_FOUND', detail = e->>'model_id';
    end if;
    v_list := case when e ? 'list_price_vnd' then (e->>'list_price_vnd')::bigint else v_model.default_list_price_vnd end;
    for i in 1 .. (e->>'qty')::int loop
      v_code := private.next_unit_code(v_model.id, v_uid);
      insert into public.units (user_id, code, model_id, lot_id, price_cny, list_price_vnd)
      values (v_uid, v_code, v_model.id, v_id, (e->>'price_cny')::numeric, v_list)
      returning id into v_unit_id;
      v_new := v_new || jsonb_build_object('unit_id', v_unit_id, 'code', v_code, 'model_id', v_model.id);
    end loop;
  end loop;

  select count(*) into v_n from public.units where lot_id = v_id;
  if v_n > 1000 then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_UNITS';
  end if;

  perform private.recalc_lot(v_id);                                     -- D2, A3, A4/BR-12

  -- CR-005: "Đã thanh toán cho trung gian" khi tạo ⇒ khoản Đã chuyển gắn lô = phải trả lúc này (trigger ghi sổ quỹ)
  if p_lot_id is null and v_paid_now then
    select amount_vnd into v_pay from public.intermediary_txns where lot_id = v_id and kind = 'payable';
    if v_pay > 0 then
      insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note)
      values (v_uid, (select ordered_at from public.lots where id = v_id), 'transfer', v_pay, v_id, 'Trả khi tạo lô')
      returning id into v_paid_txn;
    end if;
  end if;

  -- Cảnh báo trùng tin Goofish (không chặn)
  if v_item is not null then
    select array_agg(id order by created_at) into v_dups from public.lots
     where user_id = v_uid and goofish_item_id = v_item and id <> v_id and status <> 'cancelled';
  end if;

  return jsonb_build_object(
    'lot_id', v_id,
    'version', (select version from public.lots where id = v_id),
    'created_units', v_new,
    'removed_units', v_removed,
    'detached_cancelled_order_ids', to_jsonb(v_detached),
    'duplicate_lot_ids', coalesce(to_jsonb(v_dups), '[]'::jsonb),
    'payable_vnd', (select amount_vnd from public.intermediary_txns where lot_id = v_id and kind = 'payable'),
    'paid_txn_id', v_paid_txn,
    'outstanding_vnd', (select outstanding_vnd from public.v_lot_summary where lot_id = v_id));
end $$;

-- set_lot_status(p_lot_id, p_status 'cn_warehouse'|'vn_warehouse' (mã cũ tự đổi), p_expected_version)
--   → { lot_id, status, version }
-- CR-005: chỉ đi TỚI (Kho TQ → Kho VN; giữ nguyên = không đổi gì). Lùi Kho VN → Kho TQ ⇒ INVALID_STATUS_TRANSITION.
-- Nhận vào Kho Lumi: receive_lot; huỷ: cancel_lot.
create or replace function public.set_lot_status(p_lot_id uuid, p_status text, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := private.require_uid();
  v_lot    public.lots%rowtype;
  v_status text := private.normalize_lot_status(p_status);
begin
  if v_status is null or v_status not in ('cn_warehouse','vn_warehouse') then
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS_FOR_SAVE';
  end if;
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status in ('received','cancelled') then
    raise exception using errcode = 'P0001', message = 'LOT_LOCKED';
  end if;
  perform private.check_version(p_expected_version, v_lot.version);
  if v_lot.status = 'vn_warehouse' and v_status = 'cn_warehouse' then
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS_TRANSITION',
      detail = v_lot.status || '→' || v_status;
  end if;
  update public.lots set status = v_status where id = p_lot_id and status is distinct from v_status;
  return jsonb_build_object('lot_id', p_lot_id, 'status', v_status,
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- pay_lot(p_lot_id, p_paid_at date|null (mặc định hôm nay), p_note text|null (≤ 1000))
--   → { lot_id, txn_id, amount_vnd, payable_vnd, paid_vnd, outstanding_vnd: 0 }
-- CR-005 "Đã thanh toán" một chạm: ghi 1 khoản Đã chuyển gắn lô = phần CÒN NỢ của lô (phải trả − Σ đã chuyển gắn lô) —
-- vd. lô tạo đã trả tiền hàng, nhập phí ship sau ⇒ còn nợ = ship ⇒ "Đã thanh toán ship". Trigger ghi sổ quỹ (tiền ra).
-- Lô huỷ ⇒ LOT_CANCELLED; còn nợ ≤ 0 ⇒ LOT_ALREADY_PAID (detail {payable_vnd, paid_vnd, outstanding_vnd}).
-- Khoá dòng lô ⇒ 2 máy bấm cùng lúc không trả 2 lần.
create or replace function public.pay_lot(p_lot_id uuid, p_paid_at date default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := private.require_uid();
  v_lot     public.lots%rowtype;
  v_note    text := nullif(btrim(p_note), '');
  v_payable bigint;
  v_paid    bigint;
  v_out     bigint;
  v_id      uuid;
begin
  if length(v_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'note';
  end if;
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;

  v_payable := coalesce((select amount_vnd from public.intermediary_txns where lot_id = p_lot_id and kind = 'payable'), 0);
  v_paid    := coalesce((select sum(amount_vnd) from public.intermediary_txns where lot_id = p_lot_id and kind = 'transfer'), 0);
  v_out     := v_payable - v_paid;
  if v_out <= 0 then
    raise exception using errcode = 'P0001', message = 'LOT_ALREADY_PAID',
      detail = jsonb_build_object('payable_vnd', v_payable, 'paid_vnd', v_paid, 'outstanding_vnd', v_out)::text;
  end if;

  insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note)
  values (v_uid, coalesce(p_paid_at, private.today_vn()), 'transfer', v_out, p_lot_id, v_note)
  returning id into v_id;

  return jsonb_build_object('lot_id', p_lot_id, 'txn_id', v_id, 'amount_vnd', v_out,
                            'payable_vnd', v_payable, 'paid_vnd', v_paid + v_out, 'outstanding_vnd', 0);
end $$;

-- delete_order(p_order_id, p_expected_version) → { order_id, status (trạng thái lúc xoá), released_unit_ids: [uuid],
--                                                   deleted_payment_ids: [uuid], deleted_cash_entry_count }
-- CR-005 ý 13: xoá HẲN đơn ở MỌI trạng thái (app hỏi xác nhận). Xoá theo FK cascade: dòng đơn (chiếc được nhả ⇒ về Kho /
-- Đang về, bán lại được), khoản thu (+ bút toán sổ quỹ của chúng), bút toán ship của đơn. Không hoàn tác được.
create or replace function public.delete_order(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := private.require_uid();
  v_order    public.orders%rowtype;
  v_released jsonb;
  v_pays     jsonb;
  v_cash     int;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  perform private.check_version(p_expected_version, v_order.version);

  select coalesce(jsonb_agg(unit_id order by line_no), '[]'::jsonb) into v_released
    from public.order_lines where order_id = p_order_id and not cancelled;
  select coalesce(jsonb_agg(id order by paid_at, created_at), '[]'::jsonb) into v_pays
    from public.payments where order_id = p_order_id;
  select count(*) into v_cash from public.cash_entries
   where order_id = p_order_id or payment_id in (select id from public.payments where order_id = p_order_id);

  delete from public.orders where id = p_order_id;          -- cascade: order_lines, payments → cash_entries

  return jsonb_build_object('order_id', p_order_id, 'status', v_order.status, 'released_unit_ids', v_released,
                            'deleted_payment_ids', v_pays, 'deleted_cash_entry_count', v_cash);
end $$;

revoke execute on function public.save_lot(uuid, jsonb, jsonb, int) from public, anon;
revoke execute on function public.set_lot_status(uuid, text, int) from public, anon;
revoke execute on function public.pay_lot(uuid, date, text) from public, anon;
revoke execute on function public.delete_order(uuid, int) from public, anon;
grant execute on function
  public.save_lot(uuid, jsonb, jsonb, int),
  public.set_lot_status(uuid, text, int),
  public.pay_lot(uuid, date, text),
  public.delete_order(uuid, int)
to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Backfill sổ quỹ cho dữ liệu cũ (chạy lại không đổi gì: upsert chỉ ghi khi khác)
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select id from public.payments order by paid_at, created_at loop
    perform private.cash_sync_payment(r.id);
  end loop;
  for r in select id from public.intermediary_txns where kind = 'transfer' order by txn_date, created_at loop
    perform private.cash_sync_txn(r.id);
  end loop;
  for r in select id from public.orders order by created_at loop
    perform private.cash_sync_order(r.id);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 9. Realtime: thêm sổ quỹ (chỉ khi chưa có)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_entries') then
    alter publication supabase_realtime add table public.cash_entries;
  end if;
end $$;

commit;

-- PostgREST (API Supabase) nạp lại cấu trúc để app thấy cột / bảng / RPC mới ngay
notify pgrst, 'reload schema';
