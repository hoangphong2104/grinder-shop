-- =============================================================================
-- Kho Cối — 010_order_fee.sql: CR-011 — phí COD / phí khác của đơn (shop chịu).
-- Migration CỘNG THÊM, chạy lại được, 1 transaction. Đơn cũ fee_vnd = 0 ⇒ lãi / sổ quỹ không đổi.
--   * orders.fee_vnd             phí COD / phí khác shop chịu: trừ lãi đơn (v_order_summary.profit_vnd, cột fee_vnd cuối),
--                                bút toán sổ quỹ tự sinh 'order_fee' (tiền ra, ngày gửi) khi đơn đã gửi.
--   * settings.default_cod_fee_vnd  phí COD mặc định (5.500): ship_order có COD mà đơn chưa có phí ⇒ tự điền.
--   * set_order_fee              sửa phí của đơn (mọi trạng thái trừ Huỷ).
--   * v_cash_monthly.expense_out_vnd gồm cả 'order_fee'.
-- Cài mới: KHÔNG cần file này — 001_schema_v2.sql / setup-v2.sql đã gồm CR-011.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.revert_order(uuid, int)') is null then
    raise exception 'Chưa chạy 009_revert.sql — chạy theo deploy-order.txt trước rồi mới chạy 010.';
  end if;
end $$;

alter table public.orders add column if not exists fee_vnd bigint not null default 0 check (fee_vnd >= 0);
alter table public.settings add column if not exists default_cod_fee_vnd bigint not null default 5500 check (default_cod_fee_vnd >= 0);

alter table public.cash_entries drop constraint if exists cash_entries_kind_check;
alter table public.cash_entries add constraint cash_entries_kind_check check (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship',
                                                  'expense','capital_in','capital_out','adjustment','local_ship','order_fee'));
alter table public.cash_entries drop constraint if exists cash_kind_direction;
alter table public.cash_entries add constraint cash_kind_direction check (
    (kind in ('customer_payment','capital_in') and direction = 'in')
    or (kind in ('customer_refund','intermediary','ship_shop','return_ship','expense','capital_out','local_ship','order_fee') and direction = 'out')
    or kind = 'adjustment');
alter table public.cash_entries drop constraint if exists cash_auto_kind;
alter table public.cash_entries add constraint cash_auto_kind check (is_auto = (kind in ('customer_payment','customer_refund','intermediary','ship_shop','return_ship','local_ship','order_fee')));
alter table public.cash_entries drop constraint if exists cash_auto_source;
alter table public.cash_entries add constraint cash_auto_source check (
    (kind not in ('customer_payment','customer_refund') or payment_id is not null)
    and (kind <> 'intermediary' or txn_id is not null)
    and (kind not in ('ship_shop','return_ship','order_fee') or order_id is not null)
    and (kind <> 'local_ship' or lot_id is not null));
create unique index if not exists cash_entries_order_fee_uq on public.cash_entries (order_id) where kind = 'order_fee';

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
            then agg.goods_vnd - agg.cost_vnd - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end - o.fee_vnd
            when o.status = 'returned'
            then coalesce(p.paid_vnd, 0) - mo.refund_due_vnd
                 - case when o.ship_fee_payer = 'shop' then o.ship_fee_vnd else 0 end - o.return_ship_fee_vnd - o.fee_vnd
       end as profit_vnd,                                               -- CR-011: trừ phí COD / phí khác
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
            when o.status = 'returned' then o.returned_at end as profit_date,
       o.fee_vnd                                                        -- CR-011
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
       coalesce(sum(e.amount_vnd) filter (where e.kind in ('expense','order_fee')), 0)::bigint    as expense_out_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_in'), 0)::bigint                as capital_in_vnd,
       coalesce(sum(e.amount_vnd) filter (where e.kind = 'capital_out'), 0)::bigint               as capital_out_vnd,
       coalesce(sum(case when e.direction = 'in' then e.amount_vnd else -e.amount_vnd end)
                filter (where e.kind = 'adjustment'), 0)::bigint                                  as adjustment_net_vnd
from public.cash_entries e
group by e.user_id, date_trunc('month', e.entry_date);

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
  -- CR-011 phí COD / phí khác shop chịu: khi đơn đã gửi, ngày gửi
  if o.status in ('shipped','completed','returned') and o.fee_vnd > 0 then
    insert into public.cash_entries as c (user_id, entry_date, direction, amount_vnd, kind, order_id, is_auto)
    values (o.user_id, o.shipped_at, 'out', o.fee_vnd, 'order_fee', o.id, true)
    on conflict (order_id) where kind = 'order_fee' do update
       set user_id = excluded.user_id, entry_date = excluded.entry_date, amount_vnd = excluded.amount_vnd
     where (c.user_id, c.entry_date, c.amount_vnd) is distinct from (excluded.user_id, excluded.entry_date, excluded.amount_vnd);
  else
    delete from public.cash_entries where order_id = p_order_id and kind = 'order_fee';
  end if;
end $$;

drop trigger if exists orders_cash on public.orders;
create trigger orders_cash
  after insert or update of status, ship_fee_vnd, ship_fee_payer, shipped_at, returned_at, return_ship_fee_vnd, fee_vnd on public.orders
  for each row execute function private.cash_on_order();

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
  -- CR-011: đơn có COD mà chưa có phí ⇒ phí COD mặc định trong Cài đặt
  update public.orders o
     set fee_vnd = (select st.default_cod_fee_vnd from public.settings st where st.user_id = v_uid)
   where o.id = p_order_id and o.cod_amount_vnd > 0 and o.fee_vnd = 0
     and coalesce((select st.default_cod_fee_vnd from public.settings st where st.user_id = v_uid), 0) > 0;

  return jsonb_build_object('order_id', p_order_id, 'status', 'shipped',
                            'shipped_at', (select shipped_at from public.orders where id = p_order_id),
                            'cod_amount_vnd', (select cod_amount_vnd from public.orders where id = p_order_id),
                            'fee_vnd', (select fee_vnd from public.orders where id = p_order_id),
                            'version', (select version from public.orders where id = p_order_id));
end $$;

create or replace function public.set_order_fee(p_order_id uuid, p_fee_vnd bigint, p_expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := private.require_uid();
  v_order public.orders%rowtype;
begin
  if p_fee_vnd is null or p_fee_vnd < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'fee_vnd';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'cancelled' then raise exception using errcode = 'P0001', message = 'ORDER_LOCKED'; end if;
  perform private.check_version(p_expected_version, v_order.version);
  update public.orders set fee_vnd = p_fee_vnd where id = p_order_id and fee_vnd is distinct from p_fee_vnd;
  return jsonb_build_object('order_id', p_order_id, 'fee_vnd', p_fee_vnd,
                            'version', (select version from public.orders where id = p_order_id));
end $$;

revoke execute on function public.set_order_fee(uuid, bigint, int) from public, anon;
grant execute on function public.set_order_fee(uuid, bigint, int) to authenticated;
commit;
notify pgrst, 'reload schema';
