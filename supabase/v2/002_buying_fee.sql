-- =============================================================================
-- Kho Cối — 002_buying_fee.sql: CR-003 "Phí mua hộ" (1.5-change-control/draft/CR_001_quan-ly-tung-chiec.md §7, v0.3)
-- Migration CỘNG THÊM cho database ĐANG CHẠY schema v2 (setup-v2.sql) có DỮ LIỆU THẬT. KHÔNG xoá / sửa dữ liệu.
--   * settings.default_buying_fee_pct numeric(5,2) not null default 0 (0..100) — phí mua hộ mặc định cho lô mới
--   * lots.buying_fee_pct             numeric(5,2) not null default 0 (0..100) — lô cũ = 0% ⇒ giá nhập / phải trả
--                                     của lô cũ GIỮ NGUYÊN (không cần tính lại)
--   * private.recalc_lot: giá tự tính / chiếc = round(¥ × tỷ giá × (1 + %/100) + ship ÷ số chiếc);
--                         phải trả lô = round(Σ¥ × tỷ giá × (1 + %/100) + ship). Giá sửa tay không đổi.
--   * public.save_lot: nhận p_lot.buying_fee_pct (tạo: thiếu ⇒ mặc định settings; sửa: thiếu ⇒ giữ nguyên;
--                      lô đã nhận / huỷ ⇒ LOT_LOCKED như tỷ giá — Q-014/A10; ngoài 0..100 ⇒ INVALID_AMOUNT)
--   * v_lot_summary: + buying_fee_pct, buying_fee_vnd (thêm ở CUỐI ⇒ create or replace view, không drop)
--   * v_suggestions: + last_buying_fee_pct (thêm ở cuối)
-- Chạy được nhiều lần (idempotent), 1 transaction: lỗi giữa chừng ⇒ không đổi gì.
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-003 (cài mới = v2 + 002, test so schema).
-- Cách chạy: Supabase Dashboard → SQL Editor → New query → dán TOÀN BỘ file này → Run.
-- =============================================================================

begin;

-- 0. Chặn chạy nhầm trên DB chưa có schema v2
do $$
begin
  if to_regclass('public.units') is null or to_regclass('public.lots') is null or to_regclass('public.settings') is null then
    raise exception 'Chưa có schema v2 (public.units / lots / settings) — cài setup-v2.sql trước, đừng chạy 002 trên DB v1.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Cột mới (if not exists ⇒ chạy lại không lỗi). Dòng cũ nhận default 0.
--    Check đặt tên tự động lots_buying_fee_pct_check / settings_default_buying_fee_pct_check (giống cài mới).
-- -----------------------------------------------------------------------------
alter table public.settings
  add column if not exists default_buying_fee_pct numeric(5,2) not null default 0
      check (default_buying_fee_pct between 0 and 100);
alter table public.lots
  add column if not exists buying_fee_pct numeric(5,2) not null default 0
      check (buying_fee_pct between 0 and 100);

-- Quyền: settings được grant select/insert/update CẢ BẢNG (không theo cột) ⇒ cột mới tự có quyền, client sửa
-- trực tiếp default_buying_fee_pct được. lots: select cả bảng, update chỉ cột note ⇒ client KHÔNG sửa trực tiếp
-- buying_fee_pct (chỉ qua save_lot). Grant lại cho chắc (không đổi gì nếu đã có).
grant select, insert, update on public.settings to authenticated;
grant select on public.lots to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Hàm (create or replace giữ nguyên chữ ký + quyền thực thi)
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

-- Quyền thực thi như 001 (create or replace đã giữ; chạy lại cho chắc)
revoke execute on function private.recalc_lot(uuid) from public, anon, authenticated;
revoke execute on function public.save_lot(uuid, jsonb, jsonb, int) from public, anon;
grant execute on function public.save_lot(uuid, jsonb, jsonb, int) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. View (cột mới ở CUỐI ⇒ create or replace view được; security_invoker giữ = true; grant lại)
-- -----------------------------------------------------------------------------

-- Lô: số chiếc, tiền hàng, phải trả (BR-12, A4), đếm theo trạng thái chiếc, tóm tắt theo model.
-- CR-003 (cột thêm ở CUỐI để 002 dùng được create or replace view): buying_fee_pct, buying_fee_vnd = round(Σ¥ × tỷ giá × %/100).
-- goods_vnd giữ nghĩa cũ (Σ¥ × tỷ giá, CHƯA gồm phí mua hộ).
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

-- Gợi ý: tỷ giá lô gần nhất (BR-03), phí ship/chiếc của lô gần nhất có phí (BR-02), phí mua hộ % lô gần nhất (CR-003;
-- lô mới vẫn lấy mặc định từ settings.default_buying_fee_pct — cột này chỉ để tham khảo)
create or replace view public.v_suggestions with (security_invoker = true) as
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

grant select on public.v_lot_summary, public.v_suggestions to authenticated;

-- 4. Không tính lại dữ liệu cũ: mọi lô cũ có buying_fee_pct = 0 ⇒ recalc_lot cho đúng số cũ.
--    Lô sửa phí sau này được save_lot tính lại.

commit;

-- PostgREST (API Supabase) nạp lại cấu trúc để app thấy cột mới ngay
notify pgrst, 'reload schema';
