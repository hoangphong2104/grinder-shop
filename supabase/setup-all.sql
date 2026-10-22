-- =============================================================================
-- Kho Cối — migration 001_init.sql (Supabase / PostgreSQL 15+)
-- Thiết kế: 2.0-design/draft/system-design-lite-v1.md §4
-- Nguồn quy tắc: 1.0-requirements/approved/data-and-rules-v1.md (DO_001..DO_012, BR-01..BR-14, addendum Q-006..Q-011)
--   Làm tròn: mỗi công thức round() 1 lần tới đồng, nửa xa 0 (Q-006).
--
-- Nguyên tắc:
--   * Tiền VND = bigint (đồng, số nguyên). Giá ¥ = numeric(10,2). Tỷ giá = numeric(10,2).
--   * Mọi bảng có user_id + RLS "user_id = auth.uid()".
--   * Bảng giao dịch (lots, lot_lines, orders, order_lines, stock_movements, khoản Phải trả)
--     CHỈ ghi qua hàm RPC (SECURITY DEFINER, chạy trong 1 transaction, khoá hàng FOR UPDATE).
--   * Mã lỗi nghiệp vụ trả về qua RAISE ... MESSAGE '<CODE>' (SQLSTATE P0001); frontend dịch sang tiếng Việt.
--   * Khoá lạc quan: cột version tăng mỗi lần UPDATE; RPC nhận p_expected_version.
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

-- auth.uid() bắt buộc có (chặn gọi RPC khi chưa đăng nhập).
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

-- -----------------------------------------------------------------------------
-- 1. Bảng
-- -----------------------------------------------------------------------------

-- DO_001 Model
create table public.models (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80),
  brand       text not null default '1Zpresso' check (length(brand) <= 60),
  image_path  text check (length(image_path) <= 300),           -- Storage: private-images/{uid}/models/...
  aliases     text[] not null default '{}',                      -- tên gọi khác cho AI khớp (ZP6, KU, K-Ultra…)
  is_active   boolean not null default true,                     -- BR-14: ẩn thay vì xoá
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int not null default 1,
  unique (id, user_id)
);
create unique index models_user_name_uq on public.models (user_id, lower(name));

-- DO_002 Biến thể (+ trạng thái kho đã tính: on_hand_qty, avg_cost_vnd — chỉ RPC được ghi)
create table public.variants (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  model_id            uuid not null,
  name                text not null check (length(btrim(name)) between 1 and 80),
  list_price_vnd      bigint check (list_price_vnd >= 0),
  low_stock_threshold int not null default 1 check (low_stock_threshold >= 0),
  is_active           boolean not null default true,
  on_hand_qty         int not null default 0 check (on_hand_qty >= 0),      -- BR-06 Có sẵn (snapshot)
  avg_cost_vnd        bigint not null default 0 check (avg_cost_vnd >= 0), -- BR-04 giá vốn BQ
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             int not null default 1,
  unique (id, user_id),
  foreign key (model_id, user_id) references public.models (id, user_id) on delete restrict
);
create unique index variants_model_name_uq on public.variants (model_id, lower(name));
create index variants_user_idx on public.variants (user_id);

-- DO_003 Người bán Goofish
create table public.sellers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nickname         text not null check (length(btrim(nickname)) between 1 and 100),
  region           text check (length(region) <= 100),
  profile_url      text check (length(profile_url) <= 500),
  reputation_note  text check (length(reputation_note) <= 2000),
  is_avoided       boolean not null default false,               -- đánh dấu "tránh"
  is_hidden        boolean not null default false,               -- BR-14
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  unique (id, user_id)
);
create index sellers_user_nick_idx on public.sellers (user_id, lower(nickname));

-- DO_004 Lô nhập
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
  unique (id, user_id),
  foreign key (seller_id, user_id) references public.sellers (id, user_id) on delete restrict,
  -- BR-02: đã nhận ⇒ phải có phí ship + ngày nhận
  constraint lots_received_requires_ship check (status <> 'received' or (ship_fee_vnd is not null and received_at is not null)),
  constraint lots_cancelled_has_time check (status <> 'cancelled' or cancelled_at is not null)
);
create index lots_user_status_idx on public.lots (user_id, status);
create index lots_user_item_idx   on public.lots (user_id, goofish_item_id);
create index lots_seller_idx      on public.lots (seller_id);

-- DO_005 Dòng lô
create table public.lot_lines (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lot_id         uuid not null,
  line_no        smallint not null default 1,
  variant_id     uuid not null,
  qty            int not null check (qty between 1 and 1000),
  price_cny      numeric(10,2) not null check (price_cny > 0),
  unit_cost_vnd  bigint not null default 0 check (unit_cost_vnd >= 0),   -- BR-01 (tạm tính khi ship_fee null)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        int not null default 1,
  unique (id, user_id),
  foreign key (lot_id, user_id)     references public.lots (id, user_id) on delete cascade,
  foreign key (variant_id, user_id) references public.variants (id, user_id) on delete restrict  -- BR-14
);
create index lot_lines_lot_idx     on public.lot_lines (lot_id);
create index lot_lines_variant_idx on public.lot_lines (variant_id);

-- DO_006 Giao dịch trung gian
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
  constraint itx_sign check (kind = 'adjustment' or amount_vnd >= 0)   -- Điều chỉnh có dấu ±
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

-- DO_008 Đơn bán
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  customer_id        uuid not null,
  order_date         date not null default private.today_vn(),
  status             text not null default 'confirmed'
                     check (status in ('preorder','confirmed','shipped','completed','cancelled')),
  tracking_no        text check (length(tracking_no) <= 100),
  ship_fee_vnd       bigint not null default 0 check (ship_fee_vnd >= 0),
  ship_fee_payer     text not null default 'customer' check (ship_fee_payer in ('customer','shop')),  -- Q-002
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

-- DO_009 Dòng đơn
create table public.order_lines (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id        uuid not null,
  line_no         smallint not null default 1,
  variant_id      uuid not null,
  qty             int not null check (qty between 1 and 1000),
  unit_price_vnd  bigint not null check (unit_price_vnd >= 0),
  unit_cost_vnd   bigint check (unit_cost_vnd >= 0),            -- BR-05: chụp lúc gửi; null trước đó
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         int not null default 1,
  unique (id, user_id),
  foreign key (order_id, user_id)   references public.orders (id, user_id) on delete cascade,
  foreign key (variant_id, user_id) references public.variants (id, user_id) on delete restrict  -- BR-14
);
create index order_lines_order_idx   on public.order_lines (order_id);
create index order_lines_variant_idx on public.order_lines (variant_id);

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

-- DO_011 Cài đặt (gợi ý tỷ giá / phí ship lấy từ view v_suggestions — không lưu trùng)
create table public.settings (
  user_id                  uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  ai_scan_enabled          boolean not null default true,
  ai_scan_monthly_cap      int not null default 100 check (ai_scan_monthly_cap between 0 and 1000),
  ai_confidence_threshold  numeric(3,2) not null default 0.70 check (ai_confidence_threshold between 0 and 1),
  default_ship_fee_payer   text not null default 'customer' check (default_ship_fee_payer in ('customer','shop')),
  updated_at               timestamptz not null default now(),
  version                  int not null default 1
);

-- Kỹ thuật: sổ cái nhập/xuất kho (kiểm toán + dựng lại BQ). Chỉ RPC ghi.
create table public.stock_movements (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  variant_id          uuid not null,
  kind                text not null check (kind in ('receive','ship')),
  qty_delta           int not null check (qty_delta <> 0),
  unit_cost_vnd       bigint not null check (unit_cost_vnd >= 0),
  on_hand_after       int not null check (on_hand_after >= 0),
  avg_cost_after_vnd  bigint not null check (avg_cost_after_vnd >= 0),
  lot_line_id         uuid references public.lot_lines(id) on delete restrict,
  order_line_id       uuid references public.order_lines(id) on delete restrict,
  created_at          timestamptz not null default now(),
  foreign key (variant_id, user_id) references public.variants (id, user_id) on delete restrict,
  constraint mv_ref check ((kind = 'receive' and lot_line_id is not null and qty_delta > 0)
                        or (kind = 'ship' and order_line_id is not null and qty_delta < 0))
);
create index stock_movements_variant_idx on public.stock_movements (variant_id, created_at);

-- Kỹ thuật: nhật ký quét AI (giới hạn lượt / tháng, theo dõi chi phí).
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

-- Trigger updated_at/version
do $$
declare t text;
begin
  foreach t in array array['models','variants','sellers','lots','lot_lines','intermediary_txns',
                           'customers','orders','order_lines','payments','settings']
  loop
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function private.touch_row()', t || '_touch', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Quyền + RLS
-- -----------------------------------------------------------------------------

-- Supabase cấp sẵn quyền rộng cho anon/authenticated → thu hồi rồi cấp lại tối thiểu.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Danh mục: CRUD trực tiếp (xoá bị FK restrict chặn nếu đã có lô / đơn — BR-14)
grant select, insert, delete on public.models    to authenticated;
grant update (name, brand, image_path, aliases, is_active, sort_order) on public.models to authenticated;

grant select, delete on public.variants to authenticated;
grant insert (model_id, name, list_price_vnd, low_stock_threshold, is_active) on public.variants to authenticated;
grant update (name, list_price_vnd, low_stock_threshold, is_active)          on public.variants to authenticated;
-- on_hand_qty / avg_cost_vnd: KHÔNG cấp — chỉ RPC (receive_lot, ship_order) ghi.

grant select, insert, update, delete on public.sellers   to authenticated;
grant select, insert, update, delete on public.customers to authenticated;

-- Giao dịch: chỉ đọc + sửa ghi chú; mọi thay đổi khác qua RPC
grant select on public.lots, public.lot_lines, public.orders, public.order_lines, public.stock_movements to authenticated;
grant update (note) on public.lots to authenticated;
grant update (note, tracking_no) on public.orders to authenticated;

grant select, delete on public.intermediary_txns to authenticated;
grant insert (txn_date, kind, amount_vnd, note) on public.intermediary_txns to authenticated;
grant update (txn_date, amount_vnd, note)       on public.intermediary_txns to authenticated;

grant select, insert, update, delete on public.payments to authenticated;
grant select, insert, update on public.settings to authenticated;
grant select on public.ai_scan_log to authenticated;

-- RLS
do $$
declare t text;
begin
  foreach t in array array['models','variants','sellers','lots','lot_lines','intermediary_txns','customers',
                           'orders','order_lines','payments','settings','stock_movements','ai_scan_log']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- Bảng sở hữu trọn: 1 policy cho mọi lệnh
  foreach t in array array['models','variants','sellers','lots','lot_lines','customers',
                           'orders','order_lines','payments','settings','stock_movements','ai_scan_log']
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
-- 3. View (DO_012 + tổng hợp). security_invoker ⇒ RLS của bảng gốc áp dụng.
-- -----------------------------------------------------------------------------

-- DO_012 Tồn biến thể — BR-06
create view public.v_variant_stock with (security_invoker = true) as
select v.id                    as variant_id,
       v.user_id,
       v.model_id,
       m.name                  as model_name,
       v.name                  as variant_name,
       (v.is_active and m.is_active) as is_active,
       v.on_hand_qty           as on_hand,                                    -- Có sẵn
       coalesce(inc.qty, 0)    as incoming,                                   -- Đang về
       coalesce(res.qty, 0)    as reserved,                                   -- Đã giữ
       v.on_hand_qty + coalesce(inc.qty, 0) - coalesce(res.qty, 0) as sellable,  -- Có thể bán
       v.on_hand_qty - coalesce(res.qty, 0) as free_on_hand,                  -- Có sẵn − Đã giữ (BR-07)
       v.avg_cost_vnd,
       v.on_hand_qty::bigint * v.avg_cost_vnd as stock_value_vnd,
       v.list_price_vnd,
       v.low_stock_threshold,
       (v.on_hand_qty + coalesce(inc.qty, 0) - coalesce(res.qty, 0)) <= v.low_stock_threshold as is_low_stock
from public.variants v
join public.models m on m.id = v.model_id
left join lateral (
  select sum(ll.qty)::int as qty
  from public.lot_lines ll join public.lots l on l.id = ll.lot_id
  where ll.variant_id = v.id and l.status not in ('received','cancelled')
) inc on true
left join lateral (
  select sum(ol.qty)::int as qty
  from public.order_lines ol join public.orders o on o.id = ol.order_id
  where ol.variant_id = v.id and o.status in ('preorder','confirmed')
) res on true;

-- Lô: tổng SL, tiền hàng, phải trả (BR-01, BR-12)
create view public.v_lot_summary with (security_invoker = true) as
select l.id as lot_id, l.user_id, l.status, l.ordered_at, l.received_at, l.exchange_rate, l.ship_fee_vnd,
       l.seller_id, s.nickname as seller_nickname, l.goofish_item_id, l.listing_title,
       agg.total_qty,
       agg.total_cny,
       round(agg.total_cny * l.exchange_rate)::bigint as goods_vnd,
       coalesce(t.amount_vnd, 0)                       as payable_vnd,
       (l.ship_fee_vnd is null)                        as cost_is_provisional
from public.lots l
left join public.sellers s on s.id = l.seller_id
left join lateral (
  select coalesce(sum(qty), 0)::int as total_qty, coalesce(sum(qty * price_cny), 0)::numeric(14,2) as total_cny
  from public.lot_lines where lot_id = l.id
) agg on true
left join public.intermediary_txns t on t.lot_id = l.id and t.kind = 'payable';

-- Đơn: còn phải thu (BR-10), lãi (BR-11)
create view public.v_order_summary with (security_invoker = true) as
select o.id as order_id, o.user_id, o.customer_id, c.fb_name as customer_name, o.status,
       o.order_date, o.shipped_at, o.completed_at, o.ship_fee_vnd, o.ship_fee_payer,
       agg.goods_vnd,
       case when o.ship_fee_payer = 'customer' then o.ship_fee_vnd else 0 end as ship_charged_vnd,
       coalesce(p.paid_vnd, 0) as paid_vnd,
       -- Q-009: đơn Huỷ không tính vào "khách còn nợ"; tiền đã thu hiện ở refund_due_vnd ("Cần hoàn")
       case when o.status = 'cancelled' then 0
            else agg.goods_vnd + case when o.ship_fee_payer = 'customer' then o.ship_fee_vnd else 0 end
                 - coalesce(p.paid_vnd, 0)
       end as receivable_vnd,                                           -- âm = khách trả dư (Q-010)
       case when o.status = 'cancelled' then greatest(coalesce(p.paid_vnd, 0), 0) else 0 end as refund_due_vnd,
       case when o.status in ('shipped','completed')
            then agg.margin_vnd - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end
       end as profit_vnd
from public.orders o
join public.customers c on c.id = o.customer_id
left join lateral (
  select coalesce(sum(qty::bigint * unit_price_vnd), 0)::bigint as goods_vnd,
         coalesce(sum(qty::bigint * (unit_price_vnd - coalesce(unit_cost_vnd, 0))), 0)::bigint as margin_vnd
  from public.order_lines where order_id = o.id
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

-- DO_011 gợi ý: tỷ giá lô gần nhất (BR-03), phí ship/chiếc lô gần nhất có phí (BR-02)
create view public.v_suggestions with (security_invoker = true) as
select u.user_id,
       (select l.exchange_rate from public.lots l
         where l.user_id = u.user_id and l.status <> 'cancelled'
         order by l.created_at desc limit 1) as last_exchange_rate,
       (select round(l.ship_fee_vnd::numeric / nullif(s.total_qty, 0))::bigint
          from public.lots l
          join public.v_lot_summary s on s.lot_id = l.id
         where l.user_id = u.user_id and l.ship_fee_vnd is not null and l.status <> 'cancelled'
         order by coalesce(l.received_at, l.ordered_at) desc, l.created_at desc limit 1) as last_ship_fee_per_unit_vnd
from (select user_id from public.settings) u;

grant select on public.v_variant_stock, public.v_lot_summary, public.v_order_summary,
                public.v_intermediary_balance, public.v_suggestions to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Hàm nội bộ (schema private — PostgREST không lộ ra)
-- -----------------------------------------------------------------------------

-- BR-01 + BR-12: tính lại giá vốn/chiếc của dòng lô và khoản Phải trả của lô.
create or replace function private.recalc_lot(p_lot_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_lot       public.lots%rowtype;
  v_total_qty int;
  v_total_cny numeric;
  v_payable   bigint;
begin
  select * into v_lot from public.lots where id = p_lot_id;
  select coalesce(sum(qty), 0), coalesce(sum(qty * price_cny), 0)
    into v_total_qty, v_total_cny
    from public.lot_lines where lot_id = p_lot_id;

  if v_total_qty = 0 then
    raise exception using errcode = 'P0001', message = 'LOT_HAS_NO_LINES';
  end if;

  -- BR-01: giá ¥ × tỷ giá + phí ship lô ÷ tổng SL lô; làm tròn tới đồng.
  -- ship null ⇒ tạm tính với 0 (lots.ship_fee_vnd null ⇒ cost_is_provisional).
  update public.lot_lines
     set unit_cost_vnd = round(price_cny * v_lot.exchange_rate
                               + coalesce(v_lot.ship_fee_vnd, 0)::numeric / v_total_qty)::bigint
   where lot_id = p_lot_id;

  -- BR-12: Phải trả = Σ(SL × giá ¥) × tỷ giá + phí ship (khi có); Huỷ ⇒ 0.
  v_payable := case when v_lot.status = 'cancelled' then 0
                    else round(v_total_cny * v_lot.exchange_rate + coalesce(v_lot.ship_fee_vnd, 0))::bigint end;

  insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note)
  values (v_lot.user_id, v_lot.ordered_at, 'payable', v_payable, p_lot_id, 'Tự sinh từ lô')
  on conflict (lot_id) where kind = 'payable'
  do update set amount_vnd = excluded.amount_vnd, txn_date = excluded.txn_date;
end $$;

-- Q-008: dựng lại BQ của 1 biến thể theo sổ cái (thứ tự id) với giá vốn dòng lô HIỆN TẠI.
-- Dòng xuất giữ nguyên unit_cost_vnd đã chụp (giá vốn đơn đã gửi đóng băng); chỉ BQ của hàng còn trong kho đổi.
create or replace function private.replay_variant_avg(p_variant_id uuid) returns bigint
language plpgsql set search_path = '' as $$
declare
  r      record;
  v_on   int := 0;
  v_avg  bigint := 0;
  v_cost bigint;
begin
  for r in select id, kind, qty_delta, lot_line_id, unit_cost_vnd from public.stock_movements
            where variant_id = p_variant_id order by id
  loop
    if r.kind = 'receive' then
      select unit_cost_vnd into v_cost from public.lot_lines where id = r.lot_line_id;
      v_avg := round((v_on::numeric * v_avg + r.qty_delta::numeric * v_cost) / (v_on + r.qty_delta))::bigint;
      v_on  := v_on + r.qty_delta;
      update public.stock_movements set unit_cost_vnd = v_cost, on_hand_after = v_on, avg_cost_after_vnd = v_avg
       where id = r.id;
    else
      -- Xuất: giá vốn dòng đơn đã chụp lúc gửi (r.unit_cost_vnd) giữ nguyên (BR-05, Q-008).
      -- Q-008b (Chủ dự án 2026-10-22: "chiếc còn lại gánh hết chênh lệch"): nếu giá vốn lô đã sửa sau khi gửi,
      -- hàng còn lại gánh phần chênh để giá trị tồn = giá trị nhận (theo giá lô hiện tại) − giá vốn đã xuất.
      -- BQ sau = a + q × (a − c) ÷ (Q − q); hết hàng thì giữ a. Không để âm. Khớp src/domain averageAfterShipment.
      if v_on + r.qty_delta > 0 then
        v_avg := greatest(0, round(v_avg + (-r.qty_delta)::numeric * (v_avg - r.unit_cost_vnd) / (v_on + r.qty_delta)))::bigint;
      end if;
      v_on := v_on + r.qty_delta;
      update public.stock_movements set on_hand_after = v_on, avg_cost_after_vnd = v_avg where id = r.id;
    end if;
  end loop;
  if v_on <> (select on_hand_qty from public.variants where id = p_variant_id) then
    raise exception using errcode = 'P0001', message = 'LEDGER_MISMATCH';
  end if;
  update public.variants set avg_cost_vnd = v_avg where id = p_variant_id;
  return v_avg;
end $$;

-- Khoá các biến thể theo thứ tự id (tránh deadlock giữa 2 thiết bị).
create or replace function private.lock_variants(p_ids uuid[]) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.variants where id = any(p_ids) order by id for update;
end $$;

create or replace function private.variant_incoming(p_variant_id uuid) returns int
language sql stable set search_path = '' as $$
  select coalesce(sum(ll.qty), 0)::int
  from public.lot_lines ll join public.lots l on l.id = ll.lot_id
  where ll.variant_id = p_variant_id and l.status not in ('received','cancelled')
$$;

-- SL đang giữ theo các trạng thái cho trước, trừ 1 đơn (khi sửa đơn đó).
create or replace function private.variant_reserved(p_variant_id uuid, p_statuses text[], p_exclude_order uuid)
returns int language sql stable set search_path = '' as $$
  select coalesce(sum(ol.qty), 0)::int
  from public.order_lines ol join public.orders o on o.id = ol.order_id
  where ol.variant_id = p_variant_id and o.status = any(p_statuses)
    and (p_exclude_order is null or o.id <> p_exclude_order)
$$;

-- BR-08: đơn Đặt trước có thể chuyển Đã chốt? (mọi dòng ≤ Có sẵn − SL các đơn Đã chốt khác)
create or replace function private.order_fillable(p_order_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(bool_and(req.qty <= v.on_hand_qty
                  - private.variant_reserved(v.id, array['confirmed'], p_order_id)), false)
  from (select variant_id, sum(qty) as qty from public.order_lines where order_id = p_order_id group by variant_id) req
  join public.variants v on v.id = req.variant_id
$$;

-- -----------------------------------------------------------------------------
-- 5. RPC (public, SECURITY DEFINER, search_path rỗng, luôn lọc user_id = auth.uid())
-- -----------------------------------------------------------------------------

-- Khởi tạo người dùng: dòng settings + 3 model mặc định (idempotent).
create or replace function public.bootstrap_user() returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  insert into public.settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  if not exists (select 1 from public.models where user_id = v_uid) then
    insert into public.models (user_id, name, brand, aliases, sort_order) values
      (v_uid, 'ZP6 Special', '1Zpresso', array['ZP6','ZP6S','ZP6 Special','ZP-6','zp6special'], 1),
      (v_uid, 'K Ultra',     '1Zpresso', array['KU','K-Ultra','K ultra','Kultra','K-U'], 2),
      (v_uid, 'J Ultra',     '1Zpresso', array['JU','J-Ultra','J ultra','Jultra','J-U'], 3);
  end if;
end $$;

-- Tạo / sửa lô chưa nhận (+ dòng lô). p_lot = toàn bộ trường sửa được (thay thế hết).
-- p_lines = [{variant_id, qty, price_cny}, ...]. p_lot.new_seller = {nickname, region, profile_url} để tạo người bán mới.
create or replace function public.save_lot(p_lot_id uuid, p_lot jsonb, p_lines jsonb, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := private.require_uid();
  v_lot     public.lots%rowtype;
  v_id      uuid;
  v_seller  uuid := nullif(p_lot->>'seller_id', '')::uuid;
  v_status  text := coalesce(p_lot->>'status', 'ordered');
  v_url     text := nullif(btrim(p_lot->>'goofish_url'), '');
  v_item    text;
  v_dups    uuid[];
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'LOT_HAS_NO_LINES';
  end if;
  if jsonb_array_length(p_lines) > 20 then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_LINES';
  end if;
  if v_status not in ('ordered','cn_shipping','at_forwarder','vn_shipping') then
    -- Đã nhận / Huỷ chỉ qua receive_lot / cancel_lot
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS_FOR_SAVE';
  end if;
  if (p_lot->>'exchange_rate') is null or (p_lot->>'exchange_rate')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EXCHANGE_RATE_REQUIRED';
  end if;

  v_item := coalesce(nullif(p_lot->>'goofish_item_id', ''), substring(v_url from '[?&]id=([0-9]{6,24})'));

  -- Người bán mới (DO_003 "tự tạo khi lưu lô")
  if v_seller is null and p_lot ? 'new_seller' and nullif(btrim(p_lot->'new_seller'->>'nickname'), '') is not null then
    insert into public.sellers (user_id, nickname, region, profile_url)
    values (v_uid, btrim(p_lot->'new_seller'->>'nickname'),
            nullif(btrim(p_lot->'new_seller'->>'region'), ''), nullif(btrim(p_lot->'new_seller'->>'profile_url'), ''))
    returning id into v_seller;
  end if;

  if p_lot_id is null then
    insert into public.lots (user_id, goofish_url, goofish_item_id, seller_id, screenshot_path, listing_title,
                             ordered_at, exchange_rate, ship_fee_vnd, status, note)
    values (v_uid, v_url, v_item, v_seller, nullif(p_lot->>'screenshot_path', ''), nullif(p_lot->>'listing_title', ''),
            coalesce((p_lot->>'ordered_at')::date, private.today_vn()),
            (p_lot->>'exchange_rate')::numeric, (p_lot->>'ship_fee_vnd')::bigint, v_status, nullif(p_lot->>'note', ''))
    returning id into v_id;
  else
    select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND';
    end if;
    if v_lot.status in ('received','cancelled') then
      raise exception using errcode = 'P0001', message = 'LOT_LOCKED';
    end if;
    perform private.check_version(p_expected_version, v_lot.version);
    update public.lots set
      goofish_url = v_url, goofish_item_id = v_item, seller_id = v_seller,
      screenshot_path = nullif(p_lot->>'screenshot_path', ''), listing_title = nullif(p_lot->>'listing_title', ''),
      ordered_at = coalesce((p_lot->>'ordered_at')::date, v_lot.ordered_at),
      exchange_rate = (p_lot->>'exchange_rate')::numeric, ship_fee_vnd = (p_lot->>'ship_fee_vnd')::bigint,
      status = v_status, note = nullif(p_lot->>'note', '')
    where id = p_lot_id;
    v_id := p_lot_id;
    -- Lô chưa nhận ⇒ chưa có stock_movements ⇒ thay toàn bộ dòng an toàn.
    delete from public.lot_lines where lot_id = v_id;
  end if;

  insert into public.lot_lines (user_id, lot_id, line_no, variant_id, qty, price_cny)
  select v_uid, v_id, x.ord::smallint, (x.e->>'variant_id')::uuid, (x.e->>'qty')::int, (x.e->>'price_cny')::numeric
  from jsonb_array_elements(p_lines) with ordinality as x(e, ord);

  perform private.recalc_lot(v_id);   -- BR-01, BR-12

  -- Cảnh báo trùng tin Goofish (không chặn)
  if v_item is not null then
    select array_agg(id) into v_dups from public.lots
     where user_id = v_uid and goofish_item_id = v_item and id <> v_id and status <> 'cancelled';
  end if;

  return jsonb_build_object('lot_id', v_id,
                            'version', (select version from public.lots where id = v_id),
                            'duplicate_lot_ids', coalesce(to_jsonb(v_dups), '[]'::jsonb));
end $$;

-- Đổi trạng thái trung gian của lô (Đã đặt → Ship nội địa TQ → Tới trung gian → Đang về VN).
create or replace function public.set_lot_status(p_lot_id uuid, p_status text, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_lot public.lots%rowtype;
begin
  if p_status not in ('ordered','cn_shipping','at_forwarder','vn_shipping') then
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

-- Nhận lô vào kho (từ BẤT KỲ trạng thái mở nào — Q-011) — BR-02 (bắt buộc phí ship), BR-01 (chốt giá vốn), BR-04 (BQ), BR-12 (cập nhật Phải trả),
-- BR-08 (trả về các đơn Đặt trước giờ đủ hàng).
create or replace function public.receive_lot(p_lot_id uuid, p_ship_fee_vnd bigint default null,
                                              p_received_at date default null, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := private.require_uid();
  v_lot      public.lots%rowtype;
  v_ship     bigint;
  r          record;
  v_var      public.variants%rowtype;
  v_new_avg  bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_fill     jsonb;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'received'  then raise exception using errcode = 'P0001', message = 'LOT_ALREADY_RECEIVED'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;
  perform private.check_version(p_expected_version, v_lot.version);

  v_ship := coalesce(p_ship_fee_vnd, v_lot.ship_fee_vnd);
  if v_ship is null then
    raise exception using errcode = 'P0001', message = 'SHIP_FEE_REQUIRED';          -- BR-02
  end if;
  if v_ship < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;

  update public.lots
     set ship_fee_vnd = v_ship, status = 'received',
         received_at = coalesce(p_received_at, private.today_vn())
   where id = p_lot_id;

  perform private.recalc_lot(p_lot_id);                                              -- BR-01, BR-12

  perform private.lock_variants(array(select distinct variant_id from public.lot_lines where lot_id = p_lot_id));

  for r in select id, variant_id, qty, unit_cost_vnd from public.lot_lines
            where lot_id = p_lot_id order by variant_id, line_no
  loop
    select * into v_var from public.variants where id = r.variant_id;
    -- BR-04: BQ mới = (có sẵn × BQ cũ + SL nhận × giá vốn lô) ÷ (có sẵn + SL nhận)
    v_new_avg := round((v_var.on_hand_qty::numeric * v_var.avg_cost_vnd + r.qty::numeric * r.unit_cost_vnd)
                       / (v_var.on_hand_qty + r.qty))::bigint;
    update public.variants
       set on_hand_qty = on_hand_qty + r.qty, avg_cost_vnd = v_new_avg
     where id = r.variant_id;
    insert into public.stock_movements (user_id, variant_id, kind, qty_delta, unit_cost_vnd, on_hand_after,
                                        avg_cost_after_vnd, lot_line_id)
    values (v_uid, r.variant_id, 'receive', r.qty, r.unit_cost_vnd, v_var.on_hand_qty + r.qty, v_new_avg, r.id);
    v_lines := v_lines || jsonb_build_object('variant_id', r.variant_id, 'qty', r.qty,
                                             'unit_cost_vnd', r.unit_cost_vnd, 'avg_cost_after_vnd', v_new_avg);
  end loop;

  -- BR-08: đơn Đặt trước có dòng thuộc các biến thể vừa nhận và giờ đủ hàng (người dùng tự bấm chốt)
  select coalesce(jsonb_agg(o.id order by o.order_date, o.created_at), '[]'::jsonb) into v_fill
    from public.orders o
   where o.user_id = v_uid and o.status = 'preorder'
     and exists (select 1 from public.order_lines ol
                  where ol.order_id = o.id
                    and ol.variant_id in (select variant_id from public.lot_lines where lot_id = p_lot_id))
     and private.order_fillable(o.id);

  return jsonb_build_object('lot_id', p_lot_id, 'ship_fee_vnd', v_ship, 'lines', v_lines,
                            'fillable_preorder_ids', v_fill,
                            'payable_vnd', (select amount_vnd from public.intermediary_txns
                                             where lot_id = p_lot_id and kind = 'payable'),
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- Q-008: sửa phí ship của lô ĐÃ NHẬN. Tính lại giá vốn dòng lô (BR-01) + Phải trả (BR-12) +
-- BQ hàng còn trong kho (replay sổ cái). Giá vốn đã chụp trên đơn đã gửi KHÔNG đổi (BR-05).
create or replace function public.update_lot_ship_fee(p_lot_id uuid, p_ship_fee_vnd bigint, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_uid();
  v_lot  public.lots%rowtype;
  v_vid  uuid;
  v_out  jsonb := '[]'::jsonb;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status <> 'received' then
    raise exception using errcode = 'P0001', message = 'LOT_NOT_RECEIVED';   -- lô chưa nhận: dùng save_lot
  end if;
  if p_ship_fee_vnd is null or p_ship_fee_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'SHIP_FEE_REQUIRED';
  end if;
  perform private.check_version(p_expected_version, v_lot.version);
  perform private.lock_variants(array(select distinct variant_id from public.lot_lines where lot_id = p_lot_id));

  update public.lots set ship_fee_vnd = p_ship_fee_vnd where id = p_lot_id;
  perform private.recalc_lot(p_lot_id);                                              -- BR-01, BR-12
  for v_vid in select distinct variant_id from public.lot_lines where lot_id = p_lot_id order by 1
  loop
    v_out := v_out || jsonb_build_object('variant_id', v_vid, 'avg_cost_vnd', private.replay_variant_avg(v_vid));
  end loop;
  return jsonb_build_object('lot_id', p_lot_id, 'ship_fee_vnd', p_ship_fee_vnd, 'variants', v_out,
                            'payable_vnd', (select amount_vnd from public.intermediary_txns
                                             where lot_id = p_lot_id and kind = 'payable'),
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- Huỷ lô (trước Đã nhận) — BR-12: Phải trả về 0. Trả về biến thể bị "bán quá" (Có thể bán < 0) để cảnh báo.
create or replace function public.cancel_lot(p_lot_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_uid();
  v_lot  public.lots%rowtype;
  v_over jsonb;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'received'  then raise exception using errcode = 'P0001', message = 'LOT_ALREADY_RECEIVED'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;
  perform private.check_version(p_expected_version, v_lot.version);

  perform private.lock_variants(array(select distinct variant_id from public.lot_lines where lot_id = p_lot_id));
  update public.lots set status = 'cancelled', cancelled_at = now() where id = p_lot_id;
  perform private.recalc_lot(p_lot_id);                                              -- Phải trả = 0

  select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.id, 'sellable',
            v.on_hand_qty + private.variant_incoming(v.id)
            - private.variant_reserved(v.id, array['preorder','confirmed'], null))), '[]'::jsonb)
    into v_over
    from public.variants v
   where v.id in (select variant_id from public.lot_lines where lot_id = p_lot_id)
     and v.on_hand_qty + private.variant_incoming(v.id)
         - private.variant_reserved(v.id, array['preorder','confirmed'], null) < 0;

  return jsonb_build_object('lot_id', p_lot_id, 'oversold_variants', v_over,
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- Tạo / sửa đơn (khi Đặt trước / Đã chốt) — BR-07 quyết định trạng thái, chặn khi vượt Có thể bán.
-- p_order = {customer_id, order_date, ship_fee_vnd, ship_fee_payer, tracking_no, note}
-- p_lines = [{variant_id, qty, unit_price_vnd}, ...]
create or replace function public.save_order(p_order_id uuid, p_order jsonb, p_lines jsonb, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := private.require_uid();
  v_order      public.orders%rowtype;
  v_id         uuid;
  r            record;
  v_on_hand    int;
  v_incoming   int;
  v_reserved   int;
  v_all_ready  boolean := true;
  v_status     text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'ORDER_HAS_NO_LINES';
  end if;
  if jsonb_array_length(p_lines) > 20 then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_LINES';
  end if;

  if p_order_id is not null then
    select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
    if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
    if v_order.status not in ('preorder','confirmed') then
      raise exception using errcode = 'P0001', message = 'ORDER_LOCKED';
    end if;
    perform private.check_version(p_expected_version, v_order.version);
  end if;

  perform private.lock_variants(array(select distinct (e->>'variant_id')::uuid from jsonb_array_elements(p_lines) e));

  -- BR-07 theo từng biến thể (gộp SL nếu 1 biến thể xuất hiện nhiều dòng)
  for r in select (e->>'variant_id')::uuid as variant_id, sum((e->>'qty')::int) as qty
             from jsonb_array_elements(p_lines) e group by 1
  loop
    select on_hand_qty into v_on_hand from public.variants where id = r.variant_id and user_id = v_uid;
    if not found then raise exception using errcode = 'P0001', message = 'VARIANT_NOT_FOUND'; end if;
    v_incoming := private.variant_incoming(r.variant_id);
    v_reserved := private.variant_reserved(r.variant_id, array['preorder','confirmed'], p_order_id);
    if r.qty > v_on_hand + v_incoming - v_reserved then
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_STOCK',
        detail = jsonb_build_object('variant_id', r.variant_id, 'requested', r.qty,
                                    'sellable', v_on_hand + v_incoming - v_reserved)::text;
    end if;
    if r.qty > v_on_hand - v_reserved then
      v_all_ready := false;
    end if;
  end loop;
  v_status := case when v_all_ready then 'confirmed' else 'preorder' end;

  if p_order_id is null then
    insert into public.orders (user_id, customer_id, order_date, status, tracking_no, ship_fee_vnd, ship_fee_payer, note)
    values (v_uid, (p_order->>'customer_id')::uuid, coalesce((p_order->>'order_date')::date, private.today_vn()),
            v_status, nullif(p_order->>'tracking_no', ''), coalesce((p_order->>'ship_fee_vnd')::bigint, 0),
            coalesce(p_order->>'ship_fee_payer', 'customer'), nullif(p_order->>'note', ''))
    returning id into v_id;
  else
    update public.orders set
      customer_id = (p_order->>'customer_id')::uuid,
      order_date = coalesce((p_order->>'order_date')::date, v_order.order_date),
      status = v_status, tracking_no = nullif(p_order->>'tracking_no', ''),
      ship_fee_vnd = coalesce((p_order->>'ship_fee_vnd')::bigint, 0),
      ship_fee_payer = coalesce(p_order->>'ship_fee_payer', 'customer'), note = nullif(p_order->>'note', '')
    where id = p_order_id;
    v_id := p_order_id;
    delete from public.order_lines where order_id = v_id;     -- chưa gửi ⇒ chưa có stock_movements
  end if;

  insert into public.order_lines (user_id, order_id, line_no, variant_id, qty, unit_price_vnd)
  select v_uid, v_id, x.ord::smallint, (x.e->>'variant_id')::uuid, (x.e->>'qty')::int, (x.e->>'unit_price_vnd')::bigint
  from jsonb_array_elements(p_lines) with ordinality as x(e, ord);

  return jsonb_build_object('order_id', v_id, 'status', v_status,
                            'warning', case when v_status = 'preorder' then 'WAITING_FOR_STOCK' end,
                            'version', (select version from public.orders where id = v_id));
end $$;

-- BR-08: chuyển Đặt trước → Đã chốt khi người dùng bấm (kiểm Có sẵn − SL các đơn Đã chốt khác).
create or replace function public.confirm_preorder(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'preorder' then raise exception using errcode = 'P0001', message = 'ORDER_NOT_PREORDER'; end if;
  perform private.check_version(p_expected_version, v_order.version);
  perform private.lock_variants(array(select distinct variant_id from public.order_lines where order_id = p_order_id));
  if not private.order_fillable(p_order_id) then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_ON_HAND';
  end if;
  update public.orders set status = 'confirmed' where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'confirmed',
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- Gửi hàng (chỉ từ Đã chốt — Q-007) — BR-09 (chặn khi Có sẵn < SL), BR-05 (trừ Có sẵn, chụp giá vốn = BQ hiện tại; BQ không đổi).
create or replace function public.ship_order(p_order_id uuid, p_tracking_no text default null,
                                             p_shipped_at date default null, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
  r       record;
  v_var   public.variants%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_CONFIRMED';
  end if;
  perform private.check_version(p_expected_version, v_order.version);
  perform private.lock_variants(array(select distinct variant_id from public.order_lines where order_id = p_order_id));

  -- BR-09: kiểm trước cho toàn đơn (gộp theo biến thể)
  for r in select variant_id, sum(qty)::int as qty from public.order_lines where order_id = p_order_id group by 1
  loop
    select * into v_var from public.variants where id = r.variant_id;
    if v_var.on_hand_qty < r.qty then
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_ON_HAND',
        detail = jsonb_build_object('variant_id', r.variant_id, 'requested', r.qty, 'on_hand', v_var.on_hand_qty)::text;
    end if;
  end loop;

  for r in select id, variant_id, qty from public.order_lines where order_id = p_order_id order by variant_id, line_no
  loop
    select * into v_var from public.variants where id = r.variant_id;
    update public.order_lines set unit_cost_vnd = v_var.avg_cost_vnd where id = r.id;       -- BR-05 snapshot
    update public.variants set on_hand_qty = on_hand_qty - r.qty where id = r.variant_id;   -- BQ giữ nguyên
    insert into public.stock_movements (user_id, variant_id, kind, qty_delta, unit_cost_vnd, on_hand_after,
                                        avg_cost_after_vnd, order_line_id)
    values (v_uid, r.variant_id, 'ship', -r.qty, v_var.avg_cost_vnd, v_var.on_hand_qty - r.qty, v_var.avg_cost_vnd, r.id);
  end loop;

  update public.orders
     set status = 'shipped', shipped_at = coalesce(p_shipped_at, private.today_vn()),
         tracking_no = coalesce(nullif(btrim(p_tracking_no), ''), tracking_no)
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', 'shipped',
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- Huỷ đơn (trước Đã gửi). Tiền đã thu không tự hoàn — trả về số cần hoàn để người dùng ghi khoản "refund".
create or replace function public.cancel_order(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('preorder','confirmed') then
    raise exception using errcode = 'P0001', message = 'ORDER_LOCKED';
  end if;
  perform private.check_version(p_expected_version, v_order.version);
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'cancelled',
    'refund_due_vnd', (select coalesce(sum(case when kind = 'refund' then -amount_vnd else amount_vnd end), 0)
                         from public.payments where order_id = p_order_id),
    'version', (select version from public.orders where id = p_order_id));
end $$;

-- Hoàn tất đơn — BR-10: chỉ khi còn phải thu = 0, hoặc p_force = true (người dùng xác nhận bỏ qua).
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
      (select coalesce(sum(qty::bigint * unit_price_vnd), 0) from public.order_lines where order_id = p_order_id)
    + case when v_order.ship_fee_payer = 'customer' then v_order.ship_fee_vnd else 0 end
    - (select coalesce(sum(case when kind = 'refund' then -amount_vnd else amount_vnd end), 0)
         from public.payments where order_id = p_order_id);

  if v_receivable <> 0 and not coalesce(p_force, false) then
    raise exception using errcode = 'P0001', message = 'RECEIVABLE_NOT_ZERO',
      detail = jsonb_build_object('receivable_vnd', v_receivable)::text;
  end if;

  update public.orders set status = 'completed', completed_at = now(),
                           completion_forced = (v_receivable <> 0)
   where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', 'completed', 'receivable_vnd', v_receivable,
                            'version', (select version from public.orders where id = p_order_id));
end $$;

-- Quét AI: giữ 1 lượt trong hạn mức tháng (giờ VN). Gọi từ Edge Function bằng JWT của người dùng.
create or replace function public.ai_scan_reserve(p_input_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_set   public.settings%rowtype;
  v_used  int;
  v_id    uuid;
begin
  if p_input_kind not in ('image','text') then
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

create or replace function public.ai_scan_finish(p_scan_id uuid, p_status text, p_model text,
                                                 p_input_tokens int, p_output_tokens int,
                                                 p_cost_usd numeric, p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if p_status not in ('ok','error') then
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
  public.save_order(uuid, jsonb, jsonb, int),
  public.confirm_preorder(uuid, int),
  public.ship_order(uuid, text, date, int),
  public.cancel_order(uuid, int),
  public.complete_order(uuid, boolean, int),
  public.ai_scan_reserve(text),
  public.ai_scan_finish(uuid, text, text, int, int, numeric, text)
to authenticated;
-- View security_invoker gọi private.* ⇒ không cần; RPC SECURITY DEFINER chạy với quyền owner.
-- Default value private.today_vn() trên bảng chạy với quyền người gọi ⇒ cần usage + execute:
grant usage on schema private to authenticated;
grant execute on function private.today_vn() to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Storage: bucket riêng tư cho ảnh chụp Goofish + ảnh model. Đường dẫn: {uid}/goofish/<uuid>.jpg, {uid}/models/...
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-images', 'private-images', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy private_images_select on storage.objects for select to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_update on storage.objects for update to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'private-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
-- Q-017 (Chủ dự án 2026-10-22: "lưu real time"): bật Supabase Realtime cho các bảng nghiệp vụ.
-- Realtime (postgres_changes) tôn trọng RLS + quyền SELECT của role authenticated → chỉ nhận thay đổi dữ liệu của chính mình.
-- App nhận sự kiện → tải lại dữ liệu (debounce) → máy kia cập nhật ngay.
alter publication supabase_realtime add table
  public.models, public.variants, public.sellers, public.lots, public.lot_lines,
  public.intermediary_txns, public.customers, public.orders, public.order_lines,
  public.payments, public.settings;
