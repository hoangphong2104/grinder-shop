-- =============================================================================
-- Kho Cối — 008_local_ship.sql: CR-009 — mỗi cối độc lập, ship Kho VN → Lumi trả ngay, ship TQ → VN tất toán gộp sau.
-- Migration CỘNG THÊM, chạy lại được, 1 transaction. Không đổi số liệu có sẵn (lô cũ local_ship_vnd = null ⇒ giá nhập như cũ).
--   * lots.local_ship_vnd     ship Kho VN → Lumi (shop trả ngay): cộng vào giá nhập (recalc_lot), KHÔNG vào phải trả
--                             trung gian; trigger lots_cash ghi bút toán sổ quỹ tự sinh kind 'local_ship' (tiền ra,
--                             ngày nhận — chưa nhận ⇒ ngày đặt). v_cash_monthly.ship_out_vnd gồm cả 'local_ship'.
--   * lots_received_requires_ship  nới: nhận cối KHÔNG cần ship TQ→VN (chưa có ⇒ giá nhập tạm tính).
--   * receive_lot              + p_local_ship_vnd (cuối); không còn SHIP_FEE_REQUIRED.
--   * save_lot                 + p_lot.local_ship_vnd; sửa lô THIẾU khoá ship_fee_vnd / local_ship_vnd ⇒ giữ nguyên.
--   * set_lot_local_ship       sửa ship VN → Lumi 1 cối (mọi trạng thái trừ Huỷ).
--   * settle_cn_ship           tất toán ship TQ → VN gộp nhiều cối: chia đều, cộng vào ship từng cối + ghi Đã chuyển.
--   * v_units.expected_profit_vnd  chiếc đã giữ (Đặt trước / Đã chốt) ⇒ giá chốt trên đơn − giá nhập (trước: giá dự kiến).
-- Mã lỗi mới: DUPLICATE_LOT (settle_cn_ship có cối trùng).
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-009.
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.cash_entries') is null or to_regclass('public.warehouses') is null then
    raise exception 'Chưa chạy 005_cash_status_qr.sql / 007_warehouses.sql — chạy theo deploy-order.txt trước rồi mới chạy 008.';
  end if;
end $$;

alter table public.lots add column if not exists local_ship_vnd bigint check (local_ship_vnd >= 0);
alter table public.lots drop constraint if exists lots_received_requires_ship;
alter table public.lots add constraint lots_received_requires_ship check (status <> 'received' or received_at is not null);

alter table public.cash_entries drop constraint if exists cash_entries_kind_check;
alter table public.cash_entries add constraint cash_entries_kind_check check (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship',
                                                  'expense','capital_in','capital_out','adjustment','local_ship'));
alter table public.cash_entries drop constraint if exists cash_kind_direction;
alter table public.cash_entries add constraint cash_kind_direction check (
    (kind in ('customer_payment','capital_in') and direction = 'in')
    or (kind in ('customer_refund','intermediary','ship_shop','return_ship','expense','capital_out','local_ship') and direction = 'out')
    or kind = 'adjustment');
alter table public.cash_entries drop constraint if exists cash_auto_kind;
alter table public.cash_entries add constraint cash_auto_kind check (is_auto = (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship','local_ship')));
alter table public.cash_entries drop constraint if exists cash_auto_source;
alter table public.cash_entries add constraint cash_auto_source check (
    (kind not in ('customer_payment','customer_refund') or payment_id is not null)
    and (kind <> 'intermediary' or txn_id is not null)
    and (kind not in ('ship_shop','return_ship') or order_id is not null)
    and (kind <> 'local_ship' or lot_id is not null));
create unique index if not exists cash_entries_local_ship_uq on public.cash_entries (lot_id) where kind = 'local_ship';

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
       coalesce(case when h.order_status in ('preorder','confirmed') then h.unit_price_vnd end, u.list_price_vnd)
         - coalesce(u.cost_vnd_override, u.cost_vnd_auto)                            as expected_profit_vnd,   -- CR-009: đã giữ ⇒ giá chốt
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

create or replace view public.v_cash_monthly with (security_invoker = true) as
select e.user_id,
       date_trunc('month', e.entry_date)::date                                                    as month,
       coalesce(sum(e.amount_vnd) filter (where e.direction = 'in'), 0)::bigint                   as in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.direction = 'out'), 0)::bigint                  as out_vnd,
       sum(case when e.direction = 'in' then e.amount_vnd else -e.amount_vnd end)::bigint         as net_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'customer_payment'), 0)::bigint          as customer_in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'customer_refund'), 0)::bigint           as refund_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'intermediary'), 0)::bigint              as intermediary_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind in ('ship_shop','return_ship','local_ship')), 0)::bigint as ship_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'expense'), 0)::bigint                   as expense_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_in'), 0)::bigint                as capital_in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_out'), 0)::bigint               as capital_out_vnd,
       coalesce(sum(case when e.direction = 'in' then e.amount_vnd else -e.amount_vnd end)
                filter (where e.kind = 'adjustment'), 0)::bigint                                  as adjustment_net_vnd
from public.cash_entries e
group by e.user_id, date_trunc('month', e.entry_date);

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
                           + (coalesce(v_lot.ship_fee_vnd, 0) + coalesce(v_lot.local_ship_vnd, 0))::numeric / v_n)::bigint as cost
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

create or replace function private.cash_sync_lot(p_lot_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.lots%rowtype;
begin
  select * into l from public.lots where id = p_lot_id;
  if not found or l.status = 'cancelled' or coalesce(l.local_ship_vnd, 0) <= 0 then
    delete from public.cash_entries where lot_id = p_lot_id and kind = 'local_ship';
    return;
  end if;
  insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, lot_id, is_auto)
  values (l.user_id, coalesce(l.received_at, l.ordered_at), 'out', l.local_ship_vnd, 'local_ship', l.id, true)
  on conflict (lot_id) where kind = 'local_ship' do update
     set user_id = excluded.user_id, entry_date = excluded.entry_date, amount_vnd = excluded.amount_vnd
   where (c.user_id, c.entry_date, c.amount_vnd) is distinct from (excluded.user_id, excluded.entry_date, excluded.amount_vnd);
end $$;

create or replace function private.cash_on_lot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.cash_sync_lot(new.id);
  return null;
end $$;

drop trigger if exists lots_cash on public.lots;
create trigger lots_cash
  after insert or update of status, local_ship_vnd, received_at, ordered_at on public.lots
  for each row execute function private.cash_on_lot();

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
  v_local     bigint;
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
  v_local    := nullif(p_lot->>'local_ship_vnd', '')::bigint;                -- CR-009
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
  if v_local < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'local_ship_vnd';
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
                             ordered_at, exchange_rate, ship_fee_vnd, status, note, buying_fee_pct, local_ship_vnd)
    values (v_uid, v_url, v_item, v_seller, nullif(p_lot->>'screenshot_path', ''), nullif(p_lot->>'listing_title', ''),
            coalesce(nullif(p_lot->>'ordered_at', '')::date, private.today_vn()),
            v_rate, v_ship, coalesce(v_status, 'cn_warehouse'), nullif(p_lot->>'note', ''),
            coalesce(v_fee, (select st.default_buying_fee_pct from public.settings st where st.user_id = v_uid), 0), v_local)
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
      exchange_rate = v_rate, status = coalesce(v_status, v_lot.status), note = nullif(p_lot->>'note', ''),
      -- CR-009: thiếu khoá ship ⇒ giữ nguyên (ship TQ→VN do settle_cn_ship ghi; app mới không gửi)
      ship_fee_vnd = case when p_lot ? 'ship_fee_vnd' then v_ship else v_lot.ship_fee_vnd end,
      local_ship_vnd = case when p_lot ? 'local_ship_vnd' then v_local else v_lot.local_ship_vnd end,
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

drop function if exists public.receive_lot(uuid, bigint, date, int, jsonb);
create or replace function public.receive_lot(p_lot_id uuid, p_ship_fee_vnd bigint default null,
                                              p_received_at date default null, p_expected_version int default null,
                                              p_units jsonb default null, p_local_ship_vnd bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_lot   public.lots%rowtype;
  v_ship  bigint;
  v_local bigint;
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

  v_ship  := coalesce(p_ship_fee_vnd, v_lot.ship_fee_vnd);
  v_local := coalesce(p_local_ship_vnd, v_lot.local_ship_vnd);
  if v_ship < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'ship_fee_vnd';
  end if;
  if v_local < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'local_ship_vnd';
  end if;

  select x into v_bad from unnest(v_ids) x
   where not exists (select 1 from public.units u where u.id = x and u.lot_id = p_lot_id) limit 1;
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND', detail = v_bad::text;
  end if;

  update public.lots
     set ship_fee_vnd = v_ship, local_ship_vnd = v_local, status = 'received',
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
    'local_ship_vnd', v_local,
    'received_at', (select received_at from public.lots where id = p_lot_id),
    'payable_vnd', (select amount_vnd from public.intermediary_txns where lot_id = p_lot_id and kind = 'payable'),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('unit_id', id, 'code', code,
                                        'cost_vnd', coalesce(cost_vnd_override, cost_vnd_auto),
                                        'condition', condition, 'serial_no', serial_no) order by code), '[]'::jsonb)
                from public.units where lot_id = p_lot_id),
    'auto_confirmed_order_ids', v_conf,
    'version', (select version from public.lots where id = p_lot_id));
end $$;

create or replace function public.set_lot_local_ship(p_lot_id uuid, p_local_ship_vnd bigint, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := private.require_uid();
  v_lot  public.lots%rowtype;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  if v_lot.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED'; end if;
  if p_local_ship_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'local_ship_vnd';
  end if;
  perform private.check_version(p_expected_version, v_lot.version);

  update public.lots set local_ship_vnd = nullif(p_local_ship_vnd, 0)
   where id = p_lot_id and local_ship_vnd is distinct from nullif(p_local_ship_vnd, 0);
  perform private.recalc_lot(p_lot_id);

  return jsonb_build_object('lot_id', p_lot_id, 'local_ship_vnd', nullif(p_local_ship_vnd, 0),
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

create or replace function public.settle_cn_ship(p_lot_ids uuid[], p_total_vnd bigint, p_paid_at date default null,
                                                 p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_note  text := coalesce(nullif(btrim(p_note), ''), 'Ship TQ→VN');
  v_n     int := coalesce(cardinality(p_lot_ids), 0);
  v_bad   uuid;
  v_base  bigint;
  v_rem   bigint;
  v_share bigint;
  v_i     int := 0;
  v_out   jsonb := '[]'::jsonb;
  r       record;
begin
  if v_n = 0 then raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'p_lot_ids'; end if;
  if v_n > 500 then raise exception using errcode = 'P0001', message = 'TOO_MANY_LINES'; end if;
  if p_total_vnd is null or p_total_vnd <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'total_vnd';
  end if;
  if length(v_note) > 1000 then raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'note'; end if;
  if v_n <> (select count(distinct x) from unnest(p_lot_ids) x) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_LOT';
  end if;
  perform 1 from public.lots where id = any(p_lot_ids) and user_id = v_uid order by id for update;
  select x into v_bad from unnest(p_lot_ids) x
   where not exists (select 1 from public.lots l where l.id = x and l.user_id = v_uid) limit 1;
  if v_bad is not null then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND', detail = v_bad::text; end if;
  select id into v_bad from public.lots where id = any(p_lot_ids) and status = 'cancelled' order by id limit 1;
  if v_bad is not null then raise exception using errcode = 'P0001', message = 'LOT_CANCELLED', detail = v_bad::text; end if;

  v_base := p_total_vnd / v_n;
  v_rem  := p_total_vnd % v_n;
  for r in select id from public.lots where id = any(p_lot_ids) order by ordered_at, id loop
    v_i := v_i + 1;
    v_share := v_base + case when v_i <= v_rem then 1 else 0 end;
    if v_share > 0 then
      update public.lots set ship_fee_vnd = coalesce(ship_fee_vnd, 0) + v_share where id = r.id;
      perform private.recalc_lot(r.id);
      insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note)
      values (v_uid, coalesce(p_paid_at, private.today_vn()), 'transfer', v_share, r.id, v_note);
    end if;
    v_out := v_out || jsonb_build_object('lot_id', r.id, 'share_vnd', v_share);
  end loop;

  return jsonb_build_object('total_vnd', p_total_vnd, 'count', v_n, 'lots', v_out);
end $$;

revoke execute on function private.cash_sync_lot(uuid) from public, anon, authenticated;
revoke execute on function private.cash_on_lot() from public, anon, authenticated;
revoke execute on function public.receive_lot(uuid, bigint, date, int, jsonb, bigint) from public, anon;
revoke execute on function public.set_lot_local_ship(uuid, bigint, int) from public, anon;
revoke execute on function public.settle_cn_ship(uuid[], bigint, date, text) from public, anon;
grant execute on function
  public.receive_lot(uuid, bigint, date, int, jsonb, bigint),
  public.set_lot_local_ship(uuid, bigint, int),
  public.settle_cn_ship(uuid[], bigint, date, text)
to authenticated;
commit;
notify pgrst, 'reload schema';
