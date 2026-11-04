-- =============================================================================
-- Kho Cối — 011_cn_ship_flag.sql: CR-013 — đánh dấu khoản Đã chuyển là tất toán ship TQ → VN.
-- Migration CỘNG THÊM, chạy lại được, 1 transaction.
--   * intermediary_txns.is_cn_ship  true = khoản do settle_cn_ship ghi (báo cáo Sổ quỹ tách riêng khỏi tiền cối).
--                                   Client không ghi được cột này (không grant) — chỉ RPC.
--   * Backfill: khoản Đã chuyển ghi chú mặc định "Ship TQ→VN" của settle_cn_ship cũ ⇒ true.
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-013.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.set_order_fee(uuid, bigint, int)') is null then
    raise exception 'Chưa chạy 010_order_fee.sql — chạy theo deploy-order.txt trước rồi mới chạy 011.';
  end if;
end $$;

alter table public.intermediary_txns add column if not exists is_cn_ship boolean not null default false;
update public.intermediary_txns set is_cn_ship = true
 where kind = 'transfer' and not is_cn_ship and note = 'Ship TQ→VN' and lot_id is not null;

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
      insert into public.intermediary_txns (user_id, txn_date, kind, amount_vnd, lot_id, note, is_cn_ship)
      values (v_uid, coalesce(p_paid_at, private.today_vn()), 'transfer', v_share, r.id, v_note, true);
    end if;
    v_out := v_out || jsonb_build_object('lot_id', r.id, 'share_vnd', v_share);
  end loop;

  return jsonb_build_object('total_vnd', p_total_vnd, 'count', v_n, 'lots', v_out);
end $$;

commit;
notify pgrst, 'reload schema';
