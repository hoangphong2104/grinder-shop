-- =============================================================================
-- Kho Cối — schema v2: 001_schema_v2.sql (Supabase / PostgreSQL 15+)
-- Thay đổi: CR-001 "Quản lý từng chiếc" (1.5-change-control/draft/CR_001_quan-ly-tung-chiec.md, D1–D4, A1–A11)
-- Giữ nguyên từ v1 (migrations/001_init.sql): BR-02, BR-03, BR-10..BR-14, Q-006, Q-007, Q-009..Q-012,
--   Q-014, Q-015, Q-017..Q-019; RLS theo user_id + quyền theo cột; RPC SECURITY DEFINER search_path = '';
--   khoá lạc quan version + p_expected_version; mã lỗi qua RAISE ... MESSAGE '<CODE>' (SQLSTATE P0001).
-- Gộp thêm CR-002 (CR file §6): bảng public.notes (tab Ghi chú) — client ghi trực tiếp, RLS theo user, có realtime.
-- Gộp thêm CR-003 (CR file §7, v0.3): phí mua hộ % — settings.default_buying_fee_pct, lots.buying_fee_pct (cột cuối
--   bảng, để cài mới = v2 + 002_buying_fee.sql). DB đang chạy v2 có dữ liệu: chạy 002_buying_fee.sql (cộng thêm).
-- Cài trên project đang có v1: chạy 000_reset_v1.sql trước (hoặc dán 1 lần setup-v2.sql).
--
-- Nguyên tắc:
--   * Tiền VND = bigint (đồng). Giá ¥ = numeric(10,2). Tỷ giá = numeric(10,2).
--   * Làm tròn: mỗi công thức round() 1 lần tới đồng, nửa xa 0 (Q-006).
--   * Mỗi chiếc cối = 1 dòng public.units, mã tự đặt <tiền tố model>-<số thứ tự 3 chữ số> (D1),
--     cấp từ models.next_seq trong transaction (khoá dòng model) — KHÔNG tái dùng (mã của chiếc bị bỏ
--     ghi vào private.unit_code_retired; bộ cấp mã bỏ qua mã đã có / đã bỏ).
--   * Giá nhập ₫ tự tính (cost_vnd_auto) = round(giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship lô ÷ số chiếc lô)
--     (D2 + CR-003),
--     DB tính lại cho MỌI chiếc của lô (kể cả đã bán — A3) mỗi khi đổi giá ¥ / tỷ giá / phí ship / số chiếc.
--     Giá hiệu lực = coalesce(cost_vnd_override, cost_vnd_auto). Ship chưa nhập ⇒ tạm tính với 0.
--   * Phải trả trung gian / lô = round(Σ giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship) — không phụ thuộc
--     giá sửa tay (A4, BR-12, CR-003). Phí mua hộ của lô khoá sau khi nhận như tỷ giá (Q-014/A10).
--   * Trạng thái chiếc TÍNH RA (A5) trong v_units: incoming | in_stock | reserved | sold | cancelled.
--   * 1 chiếc thuộc tối đa 1 đơn chưa huỷ: order_lines.cancelled + unique index một phần (unit_id) where not cancelled.
--
-- Thứ tự khoá (tránh deadlock giữa 2 thiết bị):  models → lots → orders → units
--   save_lot: models (FOR UPDATE, theo id) → lot → units của lô
--   save_order: lots của các chiếc (FOR SHARE, theo id) → order → units (FOR UPDATE, theo id)
--   receive_lot / cancel_lot / update_lot_ship_fee: lot → (orders Đặt trước khi tự chốt)
--   update_unit: unit;  confirm/ship/cancel/complete_order: order
--
-- ----------------------------------------------------------------------------
-- MÃ LỖI (message của exception, SQLSTATE P0001; detail = JSON/text bổ sung khi có)
--   NOT_AUTHENTICATED        chưa đăng nhập (auth.uid() null)
--   VERSION_CONFLICT         p_expected_version khác version hiện tại (máy khác vừa sửa)
--   INVALID_INPUT            JSON sai dạng / khoá không hợp lệ (detail cho biết khoá)
--   INVALID_AMOUNT           số tiền / giá ¥ / phí mua hộ không hợp lệ (giá ¥ ≤ 0, tiền < 0, phí % ngoài 0..100)
--   INVALID_QTY              số lượng nhóm ngoài 1..1000
--   EXCHANGE_RATE_REQUIRED   thiếu tỷ giá hoặc ≤ 0 (BR-03)
--   SHIP_FEE_REQUIRED        nhận lô / sửa phí ship mà không có phí ship (BR-02)
--   INVALID_STATUS_FOR_SAVE  trạng thái lô không mở (Đã nhận / Huỷ chỉ qua receive_lot / cancel_lot)
--   LOT_HAS_NO_LINES         lô không có chiếc nào (p_groups rỗng)
--   TOO_MANY_LINES           > 1050 phần tử p_groups (≤ 1000 chiếc giữ lại + nhóm mới) · > 50 phần tử p_lines
--   TOO_MANY_UNITS           lô > 1000 chiếc
--   LOT_NOT_FOUND            không có lô (hoặc của người khác)
--   LOT_LOCKED               lô Đã nhận / Huỷ — không sửa qua save_lot / set_lot_status (A10, Q-014; gồm phí mua hộ CR-003)
--   LOT_ALREADY_RECEIVED     nhận / huỷ lô đã nhận
--   LOT_CANCELLED            nhận / huỷ lô đã huỷ
--   LOT_NOT_RECEIVED         update_lot_ship_fee trên lô chưa nhận (dùng save_lot)
--   LOT_HAS_RESERVED_UNITS   huỷ lô khi còn chiếc thuộc đơn chưa huỷ; detail {order_ids, unit_codes}
--   SELLER_NOT_FOUND         seller_id không thuộc người dùng
--   MODEL_NOT_FOUND          model_id không thuộc người dùng
--   UNIT_NOT_FOUND           chiếc không có / của người khác / không thuộc lô đang sửa; detail unit_id
--   DUPLICATE_UNIT           1 chiếc xuất hiện 2 lần trong p_groups / p_lines
--   UNIT_RESERVED            bỏ chiếc khỏi lô khi chiếc đang thuộc đơn chưa huỷ; detail {unit_id, code, order_id}
--   UNIT_NOT_AVAILABLE       chọn chiếc đã bán / đã giữ cho đơn khác / thuộc lô huỷ;
--                            detail {unit_id, code, reason: sold|reserved|lot_cancelled, order_id}
--   UNIT_NOT_RECEIVED        chốt / gửi đơn khi còn chiếc chưa về kho (A7, A8); detail [codes]
--   UNIT_PRICE_REQUIRED      dòng đơn không có giá và chiếc không có giá bán dự kiến
--   ORDER_HAS_NO_LINES       đơn không có chiếc nào
--   ORDER_NOT_FOUND          không có đơn (hoặc của người khác)
--   ORDER_LOCKED             sửa / huỷ đơn đã gửi / hoàn tất / huỷ
--   ORDER_NOT_PREORDER       confirm_preorder trên đơn không phải Đặt trước
--   ORDER_NOT_CONFIRMED      gửi hàng khi đơn chưa Đã chốt (Q-007)
--   ORDER_NOT_SHIPPED        hoàn tất khi đơn chưa Đã gửi
--   RECEIVABLE_NOT_ZERO      hoàn tất khi còn phải thu ≠ 0 mà không p_force (BR-10, Q-010); detail {receivable_vnd}
--   CUSTOMER_REQUIRED        đơn không có customer_id và không có new_customer.fb_name
--   CUSTOMER_NOT_FOUND       customer_id không thuộc người dùng
--   DEPOSIT_ONLY_ON_CREATE   deposit_vnd > 0 khi SỬA đơn (cọc thêm: ghi bảng payments)
--   SCAN_DISABLED / SCAN_CAP_REACHED / SCAN_NOT_FOUND   quét AI (như v1, Q-012)
--   Bỏ so với v1: VARIANT_NOT_FOUND, INSUFFICIENT_STOCK, INSUFFICIENT_ON_HAND, LEDGER_MISMATCH.
--   Lỗi Postgres khác có thể gặp: 23503 (xoá model / khách / người bán đã dùng — BR-14), 23505, 22P02 (ép kiểu).
-- =============================================================================

begin;

create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- 0. Helper chung
-- -----------------------------------------------------------------------------

-- Ngày hiện tại theo giờ Việt Nam (DB Supabase chạy UTC).
create or replace function private.today_vn() returns date
language sql stable set search_path = '' as $$
  select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date
$$;

create or replace function private.require_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHENTICATED';
  end if;
  return v;
end $$;

create or replace function private.check_version(p_expected int, p_actual int) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is not null and p_expected <> p_actual then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = pg_catalog.format('expected=%s actual=%s', p_expected, p_actual);
  end if;
end $$;

-- updated_at + version (khoá lạc quan) cho mọi bảng sửa được.
create or replace function private.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := pg_catalog.now();
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

-- Model: chuẩn hoá tiền tố (HOA, bỏ khoảng trắng); chỉ bộ đếm next_seq đổi (do cấp mã) thì KHÔNG tăng version
-- (tránh báo xung đột giả khi máy kia đang sửa model); next_seq không bao giờ giảm.
create or replace function private.touch_model() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.code_prefix := pg_catalog.upper(pg_catalog.btrim(new.code_prefix));
  if tg_op = 'UPDATE' then
    if new.next_seq < old.next_seq then
      new.next_seq := old.next_seq;
    end if;
    if (pg_catalog.to_jsonb(new) - array['next_seq','updated_at','version'])
       = (pg_catalog.to_jsonb(old) - array['next_seq','updated_at','version']) then
      new.updated_at := old.updated_at;
      new.version := old.version;
    else
      new.updated_at := pg_catalog.now();
      new.version := old.version + 1;
    end if;
  else
    new.updated_at := pg_catalog.now();
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Bảng
-- -----------------------------------------------------------------------------

-- DO_001 Model (A1: bỏ biến thể màu; thêm tiền tố mã, giá bán mặc định, ngưỡng sắp hết, bộ đếm mã)
create table public.models (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                    text not null check (length(btrim(name)) between 1 and 80),
  brand                   text not null default '1Zpresso' check (length(brand) <= 60),
  image_path              text check (length(image_path) <= 300),       -- Storage: private-images/{uid}/models/...
  aliases                 text[] not null default '{}',                  -- tên gọi khác cho AI khớp (ZP6, KU, K-Ultra…)
  code_prefix             text not null check (code_prefix ~ '^[A-Z0-9]{1,10}$'),   -- D1: ZP6 / KU / JU
  default_list_price_vnd  bigint check (default_list_price_vnd >= 0),   -- A1: điền sẵn giá bán cho chiếc mới
  low_stock_threshold     int not null default 1 check (low_stock_threshold >= 0),  -- A9
  next_seq                int not null default 1 check (next_seq >= 1),  -- bộ đếm mã; chỉ RPC tăng
  is_active               boolean not null default true,                 -- BR-14: ẩn thay vì xoá
  sort_order              int not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  version                 int not null default 1,
  unique (id, user_id)
);
create unique index models_user_name_uq   on public.models (user_id, lower(name));
create unique index models_user_prefix_uq on public.models (user_id, code_prefix);

-- DO_003 Người bán Goofish
create table public.sellers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nickname         text not null check (length(btrim(nickname)) between 1 and 100),
  region           text check (length(region) <= 100),
  profile_url      text check (length(profile_url) <= 500),
  reputation_note  text check (length(reputation_note) <= 2000),
  is_avoided       boolean not null default false,
  is_hidden        boolean not null default false,               -- BR-14
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  unique (id, user_id)
);
create index sellers_user_nick_idx on public.sellers (user_id, lower(nickname));

-- DO_004 Lô nhập (như v1)
create table public.lots (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  goofish_url      text check (length(goofish_url) <= 500),
  goofish_item_id  text check (goofish_item_id ~ '^[0-9]{6,24}$'),
  seller_id        uuid,
  screenshot_path  text check (length(screenshot_path) <= 300),  -- Storage: private-images/{uid}/goofish/...
  listing_title    text check (length(listing_title) <= 300),
  ordered_at       date not null default private.today_vn(),
  exchange_rate    numeric(10,2) not null check (exchange_rate > 0),           -- BR-03
  ship_fee_vnd     bigint check (ship_fee_vnd >= 0),                            -- BR-02: null tới khi nhận
  status           text not null default 'ordered'
                   check (status in ('ordered','cn_shipping','at_forwarder','vn_shipping','received','cancelled')),
  received_at      date,
  cancelled_at     timestamptz,
  note             text check (length(note) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  buying_fee_pct   numeric(5,2) not null default 0 check (buying_fee_pct between 0 and 100),  -- CR-003: phí mua hộ %
  unique (id, user_id),
  foreign key (seller_id, user_id) references public.sellers (id, user_id) on delete restrict,
  constraint lots_received_requires_ship check (status <> 'received' or (ship_fee_vnd is not null and received_at is not null)),
  constraint lots_cancelled_has_time check (status <> 'cancelled' or cancelled_at is not null)
);
create index lots_user_status_idx on public.lots (user_id, status);
create index lots_user_item_idx   on public.lots (user_id, goofish_item_id);
create index lots_seller_idx      on public.lots (seller_id);

-- Chiếc cối (mới — thay lot_lines + variants; CR-001 §3)
create table public.units (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  code               text not null check (code ~ '^[A-Z0-9]{1,10}-[0-9]{3,}$'),   -- D1: ZP6-001
  model_id           uuid not null,
  lot_id             uuid not null,
  price_cny          numeric(10,2) not null check (price_cny > 0),
  cost_vnd_auto      bigint not null default 0 check (cost_vnd_auto >= 0),        -- D2: DB tính (recalc_lot)
  cost_vnd_override  bigint check (cost_vnd_override >= 0),                        -- D2: null = dùng tự tính
  list_price_vnd     bigint check (list_price_vnd >= 0),                           -- D3: giá bán dự kiến
  serial_no          text check (length(serial_no) <= 100),
  note               text check (length(note) <= 2000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            int not null default 1,
  unique (id, user_id),
  foreign key (lot_id, user_id)   references public.lots (id, user_id) on delete cascade,
  foreign key (model_id, user_id) references public.models (id, user_id) on delete restrict   -- BR-14
);
create unique index units_user_code_uq on public.units (user_id, code);
create index units_lot_idx   on public.units (lot_id);
create index units_model_idx on public.units (model_id);

-- Mã chiếc đã bỏ (chiếc bị xoá khỏi lô chưa nhận) — để không bao giờ cấp lại (D1). Chỉ RPC ghi.
create table private.unit_code_retired (
  user_id     uuid not null references auth.users(id) on delete cascade,
  code        text not null,
  retired_at  timestamptz not null default now(),
  primary key (user_id, code)
);

-- DO_006 Giao dịch trung gian (như v1)
create table public.intermediary_txns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  txn_date    date not null default private.today_vn(),
  kind        text not null check (kind in ('payable','transfer','adjustment')),
  amount_vnd  bigint not null,
  lot_id      uuid,
  note        text check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1,
  foreign key (lot_id, user_id) references public.lots (id, user_id) on delete cascade,
  constraint itx_payable_has_lot check ((kind = 'payable') = (lot_id is not null)),
  constraint itx_sign check (kind = 'adjustment' or amount_vnd >= 0)
);
create unique index itx_one_payable_per_lot on public.intermediary_txns (lot_id) where kind = 'payable';
create index itx_user_date_idx on public.intermediary_txns (user_id, txn_date);

-- DO_007 Khách
create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fb_name     text not null check (length(btrim(fb_name)) between 1 and 120),
  fb_url      text check (length(fb_url) <= 500),
  phone       text check (length(phone) <= 30),
  address     text check (length(address) <= 500),
  note        text check (length(note) <= 2000),
  is_hidden   boolean not null default false,                   -- BR-14
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1,
  unique (id, user_id)
);
create index customers_user_name_idx on public.customers (user_id, lower(fb_name));

-- DO_008 Đơn bán (như v1)
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  customer_id        uuid not null,
  order_date         date not null default private.today_vn(),
  status             text not null default 'confirmed'
                     check (status in ('preorder','confirmed','shipped','completed','cancelled')),
  tracking_no        text check (length(tracking_no) <= 100),
  ship_fee_vnd       bigint not null default 0 check (ship_fee_vnd >= 0),
  ship_fee_payer     text not null default 'customer' check (ship_fee_payer in ('customer','shop')),  -- Q-002, Q-015
  shipped_at         date,
  completed_at       timestamptz,
  completion_forced  boolean not null default false,            -- BR-10 "người dùng xác nhận bỏ qua"
  cancelled_at       timestamptz,
  note               text check (length(note) <= 2000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            int not null default 1,
  unique (id, user_id),
  foreign key (customer_id, user_id) references public.customers (id, user_id) on delete restrict,  -- BR-14
  constraint orders_shipped_has_date check (status not in ('shipped','completed') or shipped_at is not null)
);
create index orders_user_status_idx on public.orders (user_id, status);
create index orders_customer_idx    on public.orders (customer_id);

-- DO_009 Dòng đơn = 1 chiếc cụ thể (A6). cancelled = bản sao "đơn đã huỷ" để index một phần
-- bảo đảm 1 chiếc chỉ thuộc tối đa 1 đơn chưa huỷ (chỉ RPC ghi, cancel_order đặt true).
create table public.order_lines (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  order_id        uuid not null,
  line_no         smallint not null default 1,
  unit_id         uuid not null,
  unit_price_vnd  bigint not null check (unit_price_vnd >= 0),   -- D3: giá chốt
  cancelled       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         int not null default 1,
  unique (id, user_id),
  foreign key (order_id, user_id) references public.orders (id, user_id) on delete cascade,
  foreign key (unit_id, user_id)  references public.units (id, user_id) on delete restrict
);
create unique index order_lines_unit_open_uq on public.order_lines (unit_id) where not cancelled;
create index order_lines_order_idx on public.order_lines (order_id);
create index order_lines_unit_idx  on public.order_lines (unit_id);

-- DO_010 Thu tiền khách
create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id    uuid not null,
  paid_at     date not null default private.today_vn(),
  kind        text not null check (kind in ('deposit','payment','refund')),
  amount_vnd  bigint not null check (amount_vnd > 0),           -- luôn dương; refund trừ khi tính
  note        text check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1,
  foreign key (order_id, user_id) references public.orders (id, user_id) on delete cascade
);
create index payments_order_idx on public.payments (order_id);

-- DO_011 Cài đặt
create table public.settings (
  user_id                  uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  ai_scan_enabled          boolean not null default true,
  ai_scan_monthly_cap      int not null default 100 check (ai_scan_monthly_cap between 0 and 1000),
  ai_confidence_threshold  numeric(3,2) not null default 0.70 check (ai_confidence_threshold between 0 and 1),
  default_ship_fee_payer   text not null default 'customer' check (default_ship_fee_payer in ('customer','shop')),
  updated_at               timestamptz not null default now(),
  version                  int not null default 1,
  default_buying_fee_pct   numeric(5,2) not null default 0 check (default_buying_fee_pct between 0 and 100)  -- CR-003
);

-- Nhật ký quét AI (Q-012)
create table public.ai_scan_log (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  input_kind     text not null check (input_kind in ('image','text')),
  status         text not null default 'pending' check (status in ('pending','ok','error')),
  model          text,
  input_tokens   int check (input_tokens >= 0),
  output_tokens  int check (output_tokens >= 0),
  cost_usd       numeric(10,5) check (cost_usd >= 0),
  error_code     text,
  finished_at    timestamptz
);
create index ai_scan_log_user_time_idx on public.ai_scan_log (user_id, created_at);

-- CR-002 Ghi chú (tab Ghi chú): client ghi trực tiếp, RLS theo user
create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (length(body) between 1 and 10000),
  is_pinned   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1
);
create index notes_user_order_idx on public.notes (user_id, is_pinned desc, updated_at desc);

-- Trigger updated_at/version
create trigger models_touch before insert or update on public.models
  for each row execute function private.touch_model();
do $$
declare t text;
begin
  foreach t in array array['sellers','lots','units','intermediary_txns','customers','orders',
                           'order_lines','payments','settings','notes']
  loop
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function private.touch_row()', t || '_touch', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Quyền + RLS
-- -----------------------------------------------------------------------------

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on private.unit_code_retired from public;

-- Model: CRUD trực tiếp, trừ next_seq (chỉ RPC). Xoá bị FK restrict chặn nếu đã có chiếc (BR-14).
grant select, delete on public.models to authenticated;
grant insert (name, brand, image_path, aliases, code_prefix, default_list_price_vnd, low_stock_threshold,
              is_active, sort_order) on public.models to authenticated;
grant update (name, brand, image_path, aliases, code_prefix, default_list_price_vnd, low_stock_threshold,
              is_active, sort_order) on public.models to authenticated;

grant select, insert, update, delete on public.sellers   to authenticated;
grant select, insert, update, delete on public.customers to authenticated;

-- Giao dịch: chỉ đọc (+ ghi chú lô / đơn); mọi thay đổi khác qua RPC
grant select on public.lots, public.units, public.orders, public.order_lines to authenticated;
grant update (note) on public.lots to authenticated;
grant update (note, tracking_no) on public.orders to authenticated;

grant select, delete on public.intermediary_txns to authenticated;
grant insert (txn_date, kind, amount_vnd, note) on public.intermediary_txns to authenticated;
grant update (txn_date, amount_vnd, note)       on public.intermediary_txns to authenticated;

grant select, insert, update, delete on public.payments to authenticated;
grant select, insert, update on public.settings to authenticated;
grant select on public.ai_scan_log to authenticated;
grant select, delete on public.notes to authenticated;                 -- CR-002
grant insert (body, is_pinned) on public.notes to authenticated;
grant update (body, is_pinned) on public.notes to authenticated;

do $$
declare t text;
begin
  foreach t in array array['models','sellers','lots','units','intermediary_txns','customers',
                           'orders','order_lines','payments','settings','ai_scan_log','notes']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['models','sellers','lots','units','customers',
                           'orders','order_lines','payments','settings','ai_scan_log','notes']
  loop
    execute format('create policy %I on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
                   t || '_owner', t);
  end loop;
end $$;

-- Trung gian: đọc mọi loại; ghi/sửa/xoá tay chỉ Đã chuyển / Điều chỉnh (Phải trả do RPC sinh — BR-12)
create policy itx_select on public.intermediary_txns for select to authenticated
  using (user_id = (select auth.uid()));
create policy itx_insert on public.intermediary_txns for insert to authenticated
  with check (user_id = (select auth.uid()) and kind in ('transfer','adjustment'));
create policy itx_update on public.intermediary_txns for update to authenticated
  using (user_id = (select auth.uid()) and kind in ('transfer','adjustment'))
  with check (user_id = (select auth.uid()) and kind in ('transfer','adjustment'));
create policy itx_delete on public.intermediary_txns for delete to authenticated
  using (user_id = (select auth.uid()) and kind in ('transfer','adjustment'));

-- -----------------------------------------------------------------------------
-- 3. View (security_invoker ⇒ RLS của bảng gốc áp dụng)
-- -----------------------------------------------------------------------------

-- Từng chiếc + trạng thái A5 + giá nhập hiệu lực + đơn đang giữ + lãi dự kiến / thực tế + số ngày tồn
create view public.v_units with (security_invoker = true) as
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
       u.version
from public.units u
join public.models m on m.id = u.model_id
join public.lots l   on l.id = u.lot_id
left join lateral (
  select ol.id as order_line_id, ol.order_id, ol.unit_price_vnd, o.status as order_status,
         o.shipped_at, o.customer_id, c.fb_name as customer_name
  from public.order_lines ol
  join public.orders o    on o.id = ol.order_id
  join public.customers c on c.id = o.customer_id
  where ol.unit_id = u.id and not ol.cancelled
  limit 1
) h on true;

-- Tồn theo model (A9). in_stock KHÔNG gồm chiếc đã giữ; on_hand = đã về kho & chưa bán (gồm đã giữ);
-- sellable = Trong kho + Đang về chưa giữ; is_low_stock = sellable ≤ ngưỡng.
-- stock_value_vnd = Σ giá nhập hiệu lực của chiếc ĐÃ VỀ KHO và chưa bán (Trong kho + Đã giữ đã về).
create view public.v_model_stock with (security_invoker = true) as
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
                                                                                        as is_low_stock
from public.models m
left join public.v_units vu on vu.model_id = m.id
group by m.id;

-- Lô: số chiếc, tiền hàng, phải trả (BR-12, A4), đếm theo trạng thái chiếc, tóm tắt theo model.
-- CR-003 (cột thêm ở CUỐI để 002 dùng được create or replace view): buying_fee_pct, buying_fee_vnd = round(Σ¥ × tỷ giá × %/100).
-- goods_vnd giữ nghĩa cũ (Σ¥ × tỷ giá, CHƯA gồm phí mua hộ).
create view public.v_lot_summary with (security_invoker = true) as
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
       round(agg.total_cny * l.exchange_rate * (l.buying_fee_pct / 100))::bigint   as buying_fee_vnd
from public.lots l
left join public.sellers s on s.id = l.seller_id
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
create view public.v_order_summary with (security_invoker = true) as
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
       case when o.status = 'cancelled' then 0
            else agg.goods_vnd + case when o.ship_fee_payer = 'customer' then o.ship_fee_vnd else 0 end
                 - coalesce(p.paid_vnd, 0)
       end as receivable_vnd,                                           -- âm = khách trả dư (Q-010)
       case when o.status = 'cancelled' then greatest(coalesce(p.paid_vnd, 0), 0) else 0 end as refund_due_vnd,
       case when o.status in ('shipped','completed')
            then agg.goods_vnd - agg.cost_vnd - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end
       end as profit_vnd
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
  select sum(case when kind = 'refund' then -amount_vnd else amount_vnd end)::bigint as paid_vnd
  from public.payments where order_id = o.id
) p on true;

-- Công nợ trung gian (BR-12)
create view public.v_intermediary_balance with (security_invoker = true) as
select user_id,
       coalesce(sum(amount_vnd) filter (where kind = 'payable'), 0)::bigint    as total_payable_vnd,
       coalesce(sum(amount_vnd) filter (where kind = 'transfer'), 0)::bigint   as total_transferred_vnd,
       coalesce(sum(amount_vnd) filter (where kind = 'adjustment'), 0)::bigint as total_adjustment_vnd,
       (coalesce(sum(amount_vnd) filter (where kind = 'payable'), 0)
        - coalesce(sum(amount_vnd) filter (where kind = 'transfer'), 0)
        + coalesce(sum(amount_vnd) filter (where kind = 'adjustment'), 0))::bigint as balance_vnd
from public.intermediary_txns
group by user_id;

-- Gợi ý: tỷ giá lô gần nhất (BR-03), phí ship/chiếc của lô gần nhất có phí (BR-02), phí mua hộ % lô gần nhất (CR-003;
-- lô mới vẫn lấy mặc định từ settings.default_buying_fee_pct — cột này chỉ để tham khảo)
create view public.v_suggestions with (security_invoker = true) as
select st.user_id,
       (select l.exchange_rate from public.lots l
         where l.user_id = st.user_id and l.status <> 'cancelled'
         order by l.created_at desc limit 1) as last_exchange_rate,
       (select round(l.ship_fee_vnd::numeric / nullif((select count(*) from public.units u where u.lot_id = l.id), 0))::bigint
          from public.lots l
         where l.user_id = st.user_id and l.ship_fee_vnd is not null and l.status <> 'cancelled'
         order by coalesce(l.received_at, l.ordered_at) desc, l.created_at desc limit 1) as last_ship_fee_per_unit_vnd,
       (select l.buying_fee_pct from public.lots l
         where l.user_id = st.user_id and l.status <> 'cancelled'
         order by l.created_at desc limit 1) as last_buying_fee_pct
from public.settings st;

grant select on public.v_units, public.v_model_stock, public.v_lot_summary, public.v_order_summary,
                public.v_intermediary_balance, public.v_suggestions to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Hàm nội bộ (schema private — PostgREST không lộ ra)
-- -----------------------------------------------------------------------------

-- D2 + A3 + A4/BR-12 + CR-003: tính lại giá nhập ₫ tự tính của MỌI chiếc trong lô (kể cả đã bán; giá sửa tay
-- nằm ở cột khác nên được giữ) và khoản Phải trả của lô (không dùng giá sửa tay; Huỷ ⇒ 0).
--   giá tự tính / chiếc = round(giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship ÷ số chiếc)
--   phải trả lô         = round(Σ giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship)
-- (1 + %/100) tính bằng numeric chính xác; phí 0% ⇒ đúng bằng công thức v2 cũ (lô cũ không đổi số).
create or replace function private.recalc_lot(p_lot_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_lot  public.lots%rowtype;
  v_n    int;
  v_cny  numeric;
  v_pay  bigint;
  v_mul  numeric;
begin
  select * into v_lot from public.lots where id = p_lot_id;
  select count(*), coalesce(sum(price_cny), 0) into v_n, v_cny from public.units where lot_id = p_lot_id;
  if v_n = 0 then
    raise exception using errcode = 'P0001', message = 'LOT_HAS_NO_LINES';
  end if;
  v_mul := 1 + coalesce(v_lot.buying_fee_pct, 0) / 100;                 -- CR-003

  update public.units u
     set cost_vnd_auto = c.cost
    from (select id, round(price_cny * v_lot.exchange_rate * v_mul
                           + coalesce(v_lot.ship_fee_vnd, 0)::numeric / v_n)::bigint as cost
            from public.units where lot_id = p_lot_id) c
   where u.id = c.id and u.cost_vnd_auto is distinct from c.cost;   -- không đổi thì không tăng version

  v_pay := case when v_lot.status = 'cancelled' then 0
                else round(v_cny * v_lot.exchange_rate * v_mul + coalesce(v_lot.ship_fee_vnd, 0))::bigint end;

  insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note)
  values (v_lot.user_id, v_lot.ordered_at, 'payable', v_pay, p_lot_id, 'Tự sinh từ lô')
  on conflict (lot_id) where kind = 'payable'
  do update set amount_vnd = excluded.amount_vnd, txn_date = excluded.txn_date
  where (public.intermediary_txns.amount_vnd, public.intermediary_txns.txn_date)
        is distinct from (excluded.amount_vnd, excluded.txn_date);
end $$;

-- D1: cấp 1 mã chiếc cho model. UPDATE dòng model ⇒ khoá tới hết transaction ⇒ 2 thiết bị không cấp trùng.
-- Bỏ qua mã đang có hoặc đã bỏ (đổi tiền tố / xoá model rồi tạo lại) ⇒ không bao giờ tái dùng.
create or replace function private.next_unit_code(p_model_id uuid, p_uid uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_prefix text;
  v_seq    int;
  v_code   text;
begin
  loop
    update public.models set next_seq = next_seq + 1
     where id = p_model_id and user_id = p_uid
    returning code_prefix, next_seq - 1 into v_prefix, v_seq;
    if not found then
      raise exception using errcode = 'P0001', message = 'MODEL_NOT_FOUND', detail = p_model_id::text;
    end if;
    v_code := v_prefix || '-' || case when v_seq < 1000 then pg_catalog.lpad(v_seq::text, 3, '0') else v_seq::text end;
    exit when not exists (select 1 from public.units where user_id = p_uid and code = v_code)
          and not exists (select 1 from private.unit_code_retired where user_id = p_uid and code = v_code);
  end loop;
  return v_code;
end $$;

-- Mã các chiếc của đơn còn chưa về kho (lô chưa Đã nhận).
create or replace function private.order_unreceived_codes(p_order_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(u.code order by u.code), '[]'::jsonb)
  from public.order_lines ol
  join public.units u on u.id = ol.unit_id
  join public.lots l  on l.id = u.lot_id
  where ol.order_id = p_order_id and not ol.cancelled and l.status <> 'received'
$$;

-- -----------------------------------------------------------------------------
-- 5. RPC (public, SECURITY DEFINER, search_path rỗng, luôn lọc user_id = auth.uid())
-- -----------------------------------------------------------------------------

-- bootstrap_user() → void
-- Khởi tạo người dùng: dòng settings + 3 model mặc định (idempotent). Không còn biến thể (A1).
create or replace function public.bootstrap_user() returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  insert into public.settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  if not exists (select 1 from public.models where user_id = v_uid) then
    insert into public.models (user_id, name, brand, aliases, code_prefix, sort_order) values
      (v_uid, 'ZP6 Special', '1Zpresso', array['ZP6','ZP6S','ZP6 Special','ZP-6','zp6special'], 'ZP6', 1),
      (v_uid, 'K Ultra',     '1Zpresso', array['KU','K-Ultra','K ultra','Kultra','K-U'],        'KU',  2),
      (v_uid, 'J Ultra',     '1Zpresso', array['JU','J-Ultra','J ultra','Jultra','J-U'],        'JU',  3);
  end if;
end $$;

-- save_lot(p_lot_id uuid|null, p_lot jsonb, p_groups jsonb, p_expected_version int|null) → jsonb
-- Tạo / sửa lô CHƯA NHẬN (A2, A10). p_lot_id null = tạo mới.
--   p_lot = { goofish_url, goofish_item_id, seller_id | new_seller: {nickname, region, profile_url},
--             screenshot_path, listing_title, ordered_at 'YYYY-MM-DD', exchange_rate (bắt buộc > 0),
--             ship_fee_vnd (null = chưa biết), status ('ordered'|'cn_shipping'|'at_forwarder'|'vn_shipping'), note,
--             buying_fee_pct (CR-003: phí mua hộ % 0..100; thiếu / null ⇒ TẠO: lấy settings.default_buying_fee_pct,
--                             SỬA: giữ nguyên; lô đã nhận ⇒ LOT_LOCKED như tỷ giá) }
--     (thay thế toàn bộ trường lô như v1; goofish_item_id tự tách từ ?id= của link nếu trống)
--   p_groups = mảng (≤ 50) gồm 2 loại phần tử:
--     * nhóm mới  {model_id, qty 1..1000, price_cny > 0, list_price_vnd?}  → tạo qty chiếc, mỗi chiếc 1 mã;
--                 thiếu khoá list_price_vnd ⇒ lấy models.default_list_price_vnd
--     * chiếc cũ  {unit_id, price_cny?, list_price_vnd?}  (chỉ khi sửa) → giữ chiếc đó, sửa giá nếu có khoá
--   Khi sửa: chiếc của lô KHÔNG có trong p_groups (theo unit_id) bị bỏ — chiếc đang thuộc đơn chưa huỷ ⇒
--   UNIT_RESERVED; chiếc chỉ thuộc đơn ĐÃ HUỶ ⇒ xoá luôn dòng đơn huỷ đó (trả về detached_cancelled_order_ids).
--   Mã của chiếc bị bỏ không bao giờ cấp lại.
-- Trả về { lot_id, version, created_units: [{unit_id, code, model_id}], removed_units: [{unit_id, code}],
--          detached_cancelled_order_ids: [uuid], duplicate_lot_ids: [uuid], payable_vnd }
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

  v_seller := nullif(p_lot->>'seller_id', '')::uuid;
  v_status := coalesce(nullif(p_lot->>'status', ''), 'ordered');
  v_url    := nullif(btrim(p_lot->>'goofish_url'), '');
  v_rate   := nullif(p_lot->>'exchange_rate', '')::numeric;
  v_ship   := nullif(p_lot->>'ship_fee_vnd', '')::bigint;
  v_fee    := nullif(p_lot->>'buying_fee_pct', '')::numeric;                -- CR-003

  if v_status not in ('ordered','cn_shipping','at_forwarder','vn_shipping') then
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
            v_rate, v_ship, v_status, nullif(p_lot->>'note', ''),
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
      exchange_rate = v_rate, ship_fee_vnd = v_ship, status = v_status, note = nullif(p_lot->>'note', ''),
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
    'payable_vnd', (select amount_vnd from public.intermediary_txns where lot_id = v_id and kind = 'payable'));
end $$;

-- set_lot_status(p_lot_id, p_status 'ordered'|'cn_shipping'|'at_forwarder'|'vn_shipping', p_expected_version)
--   → { lot_id, status, version }
create or replace function public.set_lot_status(p_lot_id uuid, p_status text, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_lot public.lots%rowtype;
begin
  if p_status is null or p_status not in ('ordered','cn_shipping','at_forwarder','vn_shipping') then
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS_FOR_SAVE';
  end if;
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status in ('received','cancelled') then
    raise exception using errcode = 'P0001', message = 'LOT_LOCKED';
  end if;
  perform private.check_version(p_expected_version, v_lot.version);
  update public.lots set status = p_status where id = p_lot_id;
  return jsonb_build_object('lot_id', p_lot_id, 'status', p_status,
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- receive_lot(p_lot_id, p_ship_fee_vnd bigint|null, p_received_at date|null, p_expected_version) → jsonb
-- Nhận lô từ BẤT KỲ trạng thái mở nào (Q-011); bắt buộc phí ship (BR-02: tham số hoặc đã nhập trên lô).
-- Tính lại giá nhập tự tính + Phải trả; rồi TỰ CHỐT các đơn Đặt trước có chiếc trong lô này mà mọi chiếc
-- đều đã về kho (A7).
-- Trả về { lot_id, ship_fee_vnd, received_at, payable_vnd,
--          units: [{unit_id, code, cost_vnd}], auto_confirmed_order_ids: [uuid], version }
create or replace function public.receive_lot(p_lot_id uuid, p_ship_fee_vnd bigint default null,
                                              p_received_at date default null, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_lot   public.lots%rowtype;
  v_ship  bigint;
  r       record;
  v_conf  jsonb := '[]'::jsonb;
begin
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

  update public.lots
     set ship_fee_vnd = v_ship, status = 'received',
         received_at = coalesce(p_received_at, private.today_vn())
   where id = p_lot_id;

  perform private.recalc_lot(p_lot_id);

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
                                        'cost_vnd', coalesce(cost_vnd_override, cost_vnd_auto)) order by code), '[]'::jsonb)
                from public.units where lot_id = p_lot_id),
    'auto_confirmed_order_ids', v_conf,
    'version', (select version from public.lots where id = p_lot_id));
end $$;

-- update_lot_ship_fee(p_lot_id, p_ship_fee_vnd bigint, p_expected_version) → jsonb
-- Sửa phí ship lô ĐÃ NHẬN (A10). Tính lại cost_vnd_auto cho MỌI chiếc của lô kể cả đã bán (A3) — chiếc sửa
-- tay giữ giá sửa tay; Phải trả cập nhật (A4). Lô chưa nhận: dùng save_lot.
-- Trả về { lot_id, ship_fee_vnd, payable_vnd, units: [{unit_id, code, cost_vnd_auto, cost_vnd}], version }
create or replace function public.update_lot_ship_fee(p_lot_id uuid, p_ship_fee_vnd bigint, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_uid();
  v_lot  public.lots%rowtype;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status <> 'received' then
    raise exception using errcode = 'P0001', message = 'LOT_NOT_RECEIVED';
  end if;
  if p_ship_fee_vnd is null then
    raise exception using errcode = 'P0001', message = 'SHIP_FEE_REQUIRED';
  end if;
  if p_ship_fee_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'ship_fee_vnd';
  end if;
  perform private.check_version(p_expected_version, v_lot.version);

  update public.lots set ship_fee_vnd = p_ship_fee_vnd where id = p_lot_id;
  perform private.recalc_lot(p_lot_id);

  return jsonb_build_object(
    'lot_id', p_lot_id,
    'ship_fee_vnd', p_ship_fee_vnd,
    'payable_vnd', (select amount_vnd from public.intermediary_txns where lot_id = p_lot_id and kind = 'payable'),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('unit_id', id, 'code', code, 'cost_vnd_auto', cost_vnd_auto,
                                        'cost_vnd', coalesce(cost_vnd_override, cost_vnd_auto)) order by code), '[]'::jsonb)
                from public.units where lot_id = p_lot_id),
    'version', (select version from public.lots where id = p_lot_id));
end $$;

-- cancel_lot(p_lot_id, p_expected_version) → { lot_id, status: 'cancelled', payable_vnd: 0, version }
-- Huỷ lô trước Đã nhận. QUYẾT ĐỊNH: TỪ CHỐI nếu còn chiếc thuộc đơn chưa huỷ (LOT_HAS_RESERVED_UNITS,
-- detail {order_ids, unit_codes}) — người dùng đổi chiếc trong đơn (save_order) hoặc huỷ đơn trước.
-- Không tự gỡ chiếc khỏi đơn để không âm thầm làm hỏng đơn của khách. Phải trả về 0 (BR-12).
create or replace function public.cancel_lot(p_lot_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := private.require_uid();
  v_lot    public.lots%rowtype;
  v_orders jsonb;
  v_codes  jsonb;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'received'  then raise exception using errcode = 'P0001', message = 'LOT_ALREADY_RECEIVED'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;
  perform private.check_version(p_expected_version, v_lot.version);

  select jsonb_agg(distinct ol.order_id), jsonb_agg(distinct u.code)
    into v_orders, v_codes
    from public.units u join public.order_lines ol on ol.unit_id = u.id and not ol.cancelled
   where u.lot_id = p_lot_id;
  if v_orders is not null then
    raise exception using errcode = 'P0001', message = 'LOT_HAS_RESERVED_UNITS',
      detail = jsonb_build_object('order_ids', v_orders, 'unit_codes', v_codes)::text;
  end if;

  update public.lots set status = 'cancelled', cancelled_at = now() where id = p_lot_id;
  perform private.recalc_lot(p_lot_id);                                      -- Phải trả = 0

  return jsonb_build_object('lot_id', p_lot_id, 'status', 'cancelled', 'payable_vnd', 0,
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- update_unit(p_unit_id, p_patch jsonb, p_expected_version) → jsonb
-- p_patch chỉ gồm các khoá muốn đổi (khoá khác ⇒ INVALID_INPUT):
--   { cost_vnd_override: bigint ≥ 0 | null (null = về giá tự tính), list_price_vnd: bigint ≥ 0 | null,
--     serial_no: text | null, note: text | null }
-- Được sửa mọi lúc (cả khi lô đã nhận / chiếc đã bán — A10). Giá ¥ sửa qua save_lot (lô chưa nhận).
-- Trả về { unit_id, code, cost_vnd_auto, cost_vnd_override, cost_vnd, list_price_vnd, serial_no, note, version }
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
   where v_k not in ('cost_vnd_override','list_price_vnd','serial_no','note') limit 1;
  if v_key is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = v_key;
  end if;
  if (p_patch->>'cost_vnd_override')::bigint < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'cost_vnd_override';
  end if;
  if (p_patch->>'list_price_vnd')::bigint < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'list_price_vnd';
  end if;

  select * into v_unit from public.units where id = p_unit_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND'; end if;
  perform private.check_version(p_expected_version, v_unit.version);

  update public.units set
    cost_vnd_override = case when p_patch ? 'cost_vnd_override' then (p_patch->>'cost_vnd_override')::bigint else cost_vnd_override end,
    list_price_vnd    = case when p_patch ? 'list_price_vnd'    then (p_patch->>'list_price_vnd')::bigint    else list_price_vnd end,
    serial_no         = case when p_patch ? 'serial_no' then nullif(btrim(p_patch->>'serial_no'), '') else serial_no end,
    note              = case when p_patch ? 'note'      then nullif(btrim(p_patch->>'note'), '')      else note end
  where id = p_unit_id
  returning * into v_unit;

  return jsonb_build_object('unit_id', v_unit.id, 'code', v_unit.code,
                            'cost_vnd_auto', v_unit.cost_vnd_auto, 'cost_vnd_override', v_unit.cost_vnd_override,
                            'cost_vnd', coalesce(v_unit.cost_vnd_override, v_unit.cost_vnd_auto),
                            'list_price_vnd', v_unit.list_price_vnd, 'serial_no', v_unit.serial_no,
                            'note', v_unit.note, 'version', v_unit.version);
end $$;

-- save_order(p_order_id uuid|null, p_order jsonb, p_lines jsonb, p_expected_version) → jsonb
-- Tạo / sửa đơn (chỉ khi Đặt trước / Đã chốt). Trạng thái tự quyết (A6): có chiếc Đang về ⇒ 'preorder',
-- mọi chiếc Trong kho ⇒ 'confirmed'. Chiếc phải: thuộc người dùng, lô không huỷ, không thuộc đơn chưa huỷ khác.
--   p_order = { customer_id | new_customer: {fb_name, fb_url, phone, address, note},
--               order_date, ship_fee_vnd (mặc định 0), ship_fee_payer 'customer'|'shop' (mặc định theo settings),
--               tracking_no, note,
--               deposit_vnd (chỉ khi TẠO: > 0 ⇒ ghi 1 khoản 'deposit'), deposit_paid_at (mặc định = order_date) }
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

  v_ship    := coalesce(nullif(p_order->>'ship_fee_vnd', '')::bigint, 0);
  v_deposit := coalesce(nullif(p_order->>'deposit_vnd', '')::bigint, 0);
  v_payer   := coalesce(nullif(p_order->>'ship_fee_payer', ''),
                        (select default_ship_fee_payer from public.settings where user_id = v_uid), 'customer');
  if v_ship < 0 or v_deposit < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if v_payer not in ('customer','shop') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'ship_fee_payer';
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
    insert into public.payments (user_id, order_id, paid_at, kind, amount_vnd, note)
    values (v_uid, v_id, coalesce(nullif(p_order->>'deposit_paid_at', '')::date, v_date), 'deposit', v_deposit, 'Cọc khi tạo đơn')
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

-- confirm_preorder(p_order_id, p_expected_version) → { order_id, status: 'confirmed', version }
-- Chốt tay đơn Đặt trước khi mọi chiếc đã về kho (bình thường receive_lot đã tự chốt — A7).
create or replace function public.confirm_preorder(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
  v_not   jsonb;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'preorder' then raise exception using errcode = 'P0001', message = 'ORDER_NOT_PREORDER'; end if;
  perform private.check_version(p_expected_version, v_order.version);
  v_not := private.order_unreceived_codes(p_order_id);
  if jsonb_array_length(v_not) > 0 then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_RECEIVED', detail = v_not::text;
  end if;
  update public.orders set status = 'confirmed' where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'confirmed',
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- ship_order(p_order_id, p_tracking_no text|null, p_shipped_at date|null, p_expected_version)
--   → { order_id, status: 'shipped', shipped_at, version }
-- Chỉ từ Đã chốt (Q-007); mọi chiếc phải đã về kho (A8). Không chụp giá vốn (A8: lãi theo giá nhập hiện tại).
create or replace function public.ship_order(p_order_id uuid, p_tracking_no text default null,
                                             p_shipped_at date default null, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
  v_not   jsonb;
begin
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
         tracking_no = coalesce(nullif(btrim(p_tracking_no), ''), tracking_no)
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', 'shipped',
                            'shipped_at', (select shipped_at from public.orders where id = p_order_id),
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- cancel_order(p_order_id, p_expected_version)
--   → { order_id, status: 'cancelled', refund_due_vnd, released_unit_ids: [uuid], version }
-- Huỷ đơn trước Đã gửi; các chiếc được trả về Trong kho / Đang về (A5). Tiền đã thu không tự hoàn (Q-009).
create or replace function public.cancel_order(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := private.require_uid();
  v_order    public.orders%rowtype;
  v_released jsonb;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('preorder','confirmed') then
    raise exception using errcode = 'P0001', message = 'ORDER_LOCKED';
  end if;
  perform private.check_version(p_expected_version, v_order.version);

  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id;
  with upd as (
    update public.order_lines set cancelled = true where order_id = p_order_id and not cancelled returning unit_id
  ) select coalesce(jsonb_agg(unit_id), '[]'::jsonb) into v_released from upd;

  return jsonb_build_object('order_id', p_order_id, 'status', 'cancelled',
    'refund_due_vnd', greatest((select coalesce(sum(case when kind = 'refund' then -amount_vnd else amount_vnd end), 0)
                                  from public.payments where order_id = p_order_id), 0),
    'released_unit_ids', v_released,
    'version', (select version from public.orders where id = p_order_id));
end $$;

-- complete_order(p_order_id, p_force boolean, p_expected_version)
--   → { order_id, status: 'completed', receivable_vnd, version }
-- BR-10 / Q-010: chỉ khi còn phải thu = 0, hoặc p_force = true (người dùng xác nhận bỏ qua thiếu / dư).
create or replace function public.complete_order(p_order_id uuid, p_force boolean default false,
                                                 p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := private.require_uid();
  v_order      public.orders%rowtype;
  v_receivable bigint;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'shipped' then raise exception using errcode = 'P0001', message = 'ORDER_NOT_SHIPPED'; end if;
  perform private.check_version(p_expected_version, v_order.version);

  v_receivable :=
      (select coalesce(sum(unit_price_vnd), 0) from public.order_lines where order_id = p_order_id)
    + case when v_order.ship_fee_payer = 'customer' then v_order.ship_fee_vnd else 0 end
    - (select coalesce(sum(case when kind = 'refund' then -amount_vnd else amount_vnd end), 0)
         from public.payments where order_id = p_order_id);

  if v_receivable <> 0 and not coalesce(p_force, false) then
    raise exception using errcode = 'P0001', message = 'RECEIVABLE_NOT_ZERO',
      detail = jsonb_build_object('receivable_vnd', v_receivable)::text;
  end if;

  update public.orders set status = 'completed', completed_at = now(), completion_forced = (v_receivable <> 0)
   where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'completed', 'receivable_vnd', v_receivable,
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- ai_scan_reserve(p_input_kind 'image'|'text') → uuid (id lượt quét). Như v1 (Q-012).
create or replace function public.ai_scan_reserve(p_input_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_set   public.settings%rowtype;
  v_used  int;
  v_id    uuid;
begin
  if p_input_kind is null or p_input_kind not in ('image','text') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  perform pg_advisory_xact_lock(hashtext('ai_scan:' || v_uid::text));   -- 2 thiết bị bấm cùng lúc
  select * into v_set from public.settings where user_id = v_uid;
  if not found then
    insert into public.settings (user_id) values (v_uid) returning * into v_set;
  end if;
  if not v_set.ai_scan_enabled then
    raise exception using errcode = 'P0001', message = 'SCAN_DISABLED';
  end if;
  select count(*) into v_used from public.ai_scan_log
   where user_id = v_uid
     and created_at >= (date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')
     and not (status = 'error' and coalesce(input_tokens, 0) = 0);       -- lỗi trước khi gọi AI không tính
  if v_used >= v_set.ai_scan_monthly_cap then
    raise exception using errcode = 'P0001', message = 'SCAN_CAP_REACHED',
      detail = jsonb_build_object('used', v_used, 'cap', v_set.ai_scan_monthly_cap)::text;
  end if;
  insert into public.ai_scan_log (user_id, input_kind) values (v_uid, p_input_kind) returning id into v_id;
  return v_id;
end $$;

-- ai_scan_finish(p_scan_id, p_status 'ok'|'error', p_model, p_input_tokens, p_output_tokens, p_cost_usd, p_error_code) → void
create or replace function public.ai_scan_finish(p_scan_id uuid, p_status text, p_model text,
                                                 p_input_tokens int, p_output_tokens int,
                                                 p_cost_usd numeric, p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if p_status is null or p_status not in ('ok','error') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  update public.ai_scan_log
     set status = p_status, model = p_model, input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         cost_usd = p_cost_usd, error_code = p_error_code, finished_at = now()
   where id = p_scan_id and user_id = v_uid and status = 'pending';
  if not found then
    raise exception using errcode = 'P0001', message = 'SCAN_NOT_FOUND';
  end if;
end $$;

-- Quyền thực thi: chỉ authenticated; anon và public không gọi được.
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  public.bootstrap_user(),
  public.save_lot(uuid, jsonb, jsonb, int),
  public.set_lot_status(uuid, text, int),
  public.receive_lot(uuid, bigint, date, int),
  public.update_lot_ship_fee(uuid, bigint, int),
  public.cancel_lot(uuid, int),
  public.update_unit(uuid, jsonb, int),
  public.save_order(uuid, jsonb, jsonb, int),
  public.confirm_preorder(uuid, int),
  public.ship_order(uuid, text, date, int),
  public.cancel_order(uuid, int),
  public.complete_order(uuid, boolean, int),
  public.ai_scan_reserve(text),
  public.ai_scan_finish(uuid, text, text, int, int, numeric, text)
to authenticated;
-- Default value / view (security_invoker) gọi private.today_vn() với quyền người gọi ⇒ cần usage + execute:
grant usage on schema private to authenticated;
grant execute on function private.today_vn() to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Storage: bucket riêng tư cho ảnh chụp Goofish + ảnh model. Đường dẫn: {uid}/goofish/<uuid>.jpg, {uid}/models/...
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-images', 'private-images', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists private_images_select on storage.objects;
drop policy if exists private_images_insert on storage.objects;
drop policy if exists private_images_update on storage.objects;
drop policy if exists private_images_delete on storage.objects;
create policy private_images_select on storage.objects for select to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_update on storage.objects for update to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- -----------------------------------------------------------------------------
-- 7. Realtime (Q-017): postgres_changes tôn trọng RLS ⇒ mỗi người chỉ nhận thay đổi của mình.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.models, public.sellers, public.lots, public.units,
      public.intermediary_txns, public.customers, public.orders, public.order_lines,
      public.payments, public.settings, public.notes;
  end if;
end $$;

commit;
