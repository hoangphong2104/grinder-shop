-- =============================================================================
-- Kho Cối — 009_revert.sql: CR-010 — lùi trạng thái khi chuyển nhầm (mọi bước).
-- Migration CỘNG THÊM (chỉ thêm 2 hàm), chạy lại được, 1 transaction. Không đổi dữ liệu.
--   * revert_lot    Kho VN → Kho TQ · Kho Lumi → Kho VN · Huỷ → Kho TQ
--   * revert_order  Vận chuyển tới khách → Đã chốt · Đã giao → Vận chuyển · Hoàn hàng → Vận chuyển · Huỷ → Đặt trước / Đã chốt
-- Mã lỗi mới: NOTHING_TO_REVERT, LOT_HAS_SOLD_UNITS (detail mã cối đang giao / đã giao).
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-010.
-- =============================================================================
begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lots' and column_name = 'local_ship_vnd') then
    raise exception 'Chưa chạy 008_local_ship.sql — chạy theo deploy-order.txt trước rồi mới chạy 009.';
  end if;
end $$;

-- CR-010 revert_lot(p_lot_id, p_expected_version) → { lot_id, from, status, reverted_order_ids, version }
-- Lùi 1 bước khi chuyển nhầm: Kho VN → Kho TQ; Kho Lumi → Kho VN (bỏ ngày nhận; đơn Đã chốt giữ cối của lô ⇒ về Đặt trước;
-- cối đã giao / đang giao khách ⇒ LOT_HAS_SOLD_UNITS, detail mã cối — lùi đơn trước); Huỷ → Kho TQ (khôi phục, phải trả tính lại).
-- Kho TQ ⇒ NOTHING_TO_REVERT. Giá nhập, ship, tình trạng, seri giữ nguyên; bút toán ship VN → Lumi theo trigger (ngày đặt).
create or replace function public.revert_lot(p_lot_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_lot   public.lots%rowtype;
  v_to    text;
  v_sold  jsonb;
  v_back  jsonb := '[]'::jsonb;
  r       record;
begin
  select * into v_lot from public.lots where id = p_lot_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'LOT_NOT_FOUND'; end if;
  perform private.check_version(p_expected_version, v_lot.version);
  v_to := case v_lot.status when 'vn_warehouse' then 'cn_warehouse' when 'received' then 'vn_warehouse'
                            when 'cancelled' then 'cn_warehouse' end;
  if v_to is null then raise exception using errcode = 'P0001', message = 'NOTHING_TO_REVERT', detail = v_lot.status; end if;

  if v_lot.status = 'received' then
    select jsonb_agg(u.code order by u.code) into v_sold
      from public.units u join public.order_lines ol on ol.unit_id = u.id and not ol.cancelled
      join public.orders o on o.id = ol.order_id
     where u.lot_id = p_lot_id and o.status in ('shipped','completed');
    if v_sold is not null then
      raise exception using errcode = 'P0001', message = 'LOT_HAS_SOLD_UNITS', detail = v_sold::text;
    end if;
    for r in select o.id from public.orders o
              where o.user_id = v_uid and o.status = 'confirmed'
                and exists (select 1 from public.order_lines ol join public.units u on u.id = ol.unit_id
                             where ol.order_id = o.id and not ol.cancelled and u.lot_id = p_lot_id)
              order by o.id for update loop
      update public.orders set status = 'preorder' where id = r.id;
      v_back := v_back || to_jsonb(r.id);
    end loop;
    update public.lots set status = v_to, received_at = null where id = p_lot_id;
  elsif v_lot.status = 'cancelled' then
    update public.lots set status = v_to, cancelled_at = null where id = p_lot_id;
    perform private.recalc_lot(p_lot_id);                                     -- phải trả tính lại
  else
    update public.lots set status = v_to where id = p_lot_id;
  end if;

  return jsonb_build_object('lot_id', p_lot_id, 'from', v_lot.status, 'status', v_to, 'reverted_order_ids', v_back,
                            'version', (select version from public.lots where id = p_lot_id));
end $$;

-- CR-010 revert_order(p_order_id, p_expected_version) → { order_id, from, status, version }
-- Lùi 1 bước khi chuyển nhầm: Vận chuyển tới khách → Đã chốt (bỏ ngày gửi; bút toán ship shop chịu tự xoá);
-- Đã giao → Vận chuyển tới khách; Hoàn hàng → Vận chuyển tới khách (giữ lại chiếc, bỏ thông tin hoàn + ship chiều về);
-- Huỷ → Đặt trước / Đã chốt (theo hàng đã về đủ chưa, giữ lại chiếc). Chiếc đã giữ / bán cho đơn khác hoặc cối đã huỷ
-- ⇒ UNIT_NOT_AVAILABLE (detail mã chiếc). Đặt trước / Đã chốt ⇒ NOTHING_TO_REVERT. Khoản thu / hoàn tiền giữ nguyên.
create or replace function public.revert_order(p_order_id uuid, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_o     public.orders%rowtype;
  v_to    text;
  v_busy  jsonb;
begin
  select * into v_o from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  perform private.check_version(p_expected_version, v_o.version);
  if v_o.status not in ('shipped','completed','returned','cancelled') then
    raise exception using errcode = 'P0001', message = 'NOTHING_TO_REVERT', detail = v_o.status;
  end if;

  if v_o.status in ('returned','cancelled') then
    -- Giữ lại chiếc: khoá chiếc theo id, chiếc phải còn trống (không dòng mở nào khác) và cối chưa huỷ
    perform 1 from public.units where id in (select unit_id from public.order_lines where order_id = p_order_id) order by id for update;
    select jsonb_agg(distinct u.code) into v_busy
      from public.order_lines ol join public.units u on u.id = ol.unit_id join public.lots l on l.id = u.lot_id
     where ol.order_id = p_order_id and ol.cancelled
       and (l.status = 'cancelled'
            or exists (select 1 from public.order_lines x where x.unit_id = ol.unit_id and not x.cancelled and x.order_id <> p_order_id));
    if v_busy is not null then
      raise exception using errcode = 'P0001', message = 'UNIT_NOT_AVAILABLE', detail = v_busy::text;
    end if;
    update public.order_lines set cancelled = false where order_id = p_order_id and cancelled;
  end if;

  if v_o.status = 'shipped' then
    v_to := 'confirmed';
    update public.orders set status = v_to, shipped_at = null where id = p_order_id;
  elsif v_o.status = 'completed' then
    v_to := 'shipped';
    update public.orders set status = v_to, completed_at = null, completion_forced = false where id = p_order_id;
  elsif v_o.status = 'returned' then
    v_to := 'shipped';
    update public.orders set status = v_to, returned_at = null, return_ship_fee_vnd = 0, keep_deposit = false, return_note = null
     where id = p_order_id;
  else
    v_to := case when jsonb_array_length(private.order_unreceived_codes(p_order_id)) = 0 then 'confirmed' else 'preorder' end;
    update public.orders set status = v_to, cancelled_at = null where id = p_order_id;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'from', v_o.status, 'status', v_to,
                            'version', (select version from public.orders where id = p_order_id));
end $$;

revoke execute on function public.revert_lot(uuid, int) from public, anon;
revoke execute on function public.revert_order(uuid, int) from public, anon;
grant execute on function public.revert_lot(uuid, int), public.revert_order(uuid, int) to authenticated;
commit;
notify pgrst, 'reload schema';
