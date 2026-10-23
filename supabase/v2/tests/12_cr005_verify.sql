-- Sau khi chạy 005_cash_status_qr.sql (2 lần) trên DB mô phỏng DB thật: trạng thái lô đổi đúng mã, dữ liệu khác KHÔNG đổi,
-- sổ quỹ backfill khớp lịch sử (tính độc lập ở 11_cr005_snapshot.sql), cột mới ở cuối view.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;
create function snap5.diff(a text, b text) returns int language plpgsql as $$
declare n int;
begin
  execute format('select (select count(*) from (%1$s except %2$s) x) + (select count(*) from (%2$s except %1$s) y)', a, b) into n;
  return n;
end $$;
create function snap5.map(s text) returns text language sql immutable as $$
  select case when s in ('ordered','cn_shipping','at_forwarder') then 'cn_warehouse' when s = 'vn_shipping' then 'vn_warehouse' else s end
$$;

-- 1. Trạng thái lô
select t.eq((select count(*) from public.lots where status not in ('cn_warehouse','vn_warehouse','received','cancelled'))::int, 0,
            'nâng cấp 005: không còn lô mang mã trạng thái cũ');
select t.eq((select count(*) from snap5.lots s join public.lots l on l.id = s.id where l.status <> snap5.map(s.status))::int, 0,
            'nâng cấp 005: ordered / cn_shipping / at_forwarder → cn_warehouse; vn_shipping → vn_warehouse; received / cancelled giữ');
select t.eq((select string_agg(distinct s.status || '→' || l.status, ',' order by s.status || '→' || l.status)
               from snap5.lots s join public.lots l on l.id = s.id),
            'at_forwarder→cn_warehouse,cancelled→cancelled,cn_shipping→cn_warehouse,ordered→cn_warehouse,received→received,vn_shipping→vn_warehouse',
            'nâng cấp 005: bảng đổi mã đủ 6 trường hợp');
select t.eq((select count(*) from snap5.lots s join public.lots l on l.id = s.id
              where l.version <> s.version + case when s.status in ('ordered','cn_shipping','at_forwarder','vn_shipping') then 1 else 0 end)::int, 0,
            'nâng cấp 005: lô đổi mã version + 1 đúng 1 lần (chạy 2 lần không tăng thêm); lô Đã nhận / Huỷ giữ version');
select t.eq(snap5.diff('select id, ship_fee_vnd, buying_fee_pct, received_at from snap5.lots',
                       'select id, ship_fee_vnd, buying_fee_pct, received_at from public.lots'), 0,
            'nâng cấp 005: lots (phí ship, phí mua hộ, ngày nhận) giữ nguyên');
select t.eq((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'lots' and column_name = 'status'),
            '''cn_warehouse''::text', 'nâng cấp 005: lô mới mặc định cn_warehouse');

-- 2. Bảng khác không đổi
select t.eq(snap5.diff('select * from snap5.units', 'select id, version, updated_at, cost_vnd_auto, cost_vnd_override from public.units'), 0,
            'nâng cấp 005: units (giá nhập, version) giữ nguyên');
select t.eq(snap5.diff('select * from snap5.orders', 'select id, version, updated_at, status, shipped_at from public.orders'), 0,
            'nâng cấp 005: orders (mã trạng thái đơn giữ nguyên, version) giữ nguyên');
select t.eq(snap5.diff('select * from snap5.lines', 'select id, version, updated_at, cancelled from public.order_lines'), 0, 'nâng cấp 005: order_lines giữ nguyên');
select t.eq(snap5.diff('select * from snap5.payments', 'select id, version, updated_at, kind, amount_vnd from public.payments'), 0, 'nâng cấp 005: payments giữ nguyên');
select t.eq(snap5.diff('select * from snap5.txns', 'select id, version, updated_at, kind, amount_vnd, lot_id from public.intermediary_txns'), 0,
            'nâng cấp 005: intermediary_txns giữ nguyên (khoản cũ không gắn lô)');
select t.eq(snap5.diff('select * from snap5.settings', 'select user_id, version, updated_at from public.settings'), 0, 'nâng cấp 005: settings version giữ nguyên');
select t.eq((select count(*) from public.settings where bank_bin is not null or bank_account_no is not null or bank_account_name is not null)::int, 0,
            'nâng cấp 005: cột VietQR cài đặt cũ = null');

-- 3. View: cột cũ giữ nguyên (trừ mã trạng thái lô đổi theo bảng trên)
select t.eq((select count(*) from snap5.v_units s full join public.v_units v on v.unit_id = s.unit_id
              where (s.j - 'lot_status') is distinct from (to_jsonb(v) - 'lot_status')
                 or snap5.map(s.j->>'lot_status') is distinct from v.lot_status)::int, 0,
            'nâng cấp 005: v_units giữ nguyên từng chiếc (trạng thái chiếc, giá nhập, lãi, tuổi tồn); lot_status theo mã mới');
select t.eq((select count(*) from snap5.v_lot s full join public.v_lot_summary v on v.lot_id = s.lot_id
              where (s.j - 'status' - 'version') is distinct from (to_jsonb(v) - 'status' - 'version' - 'paid_vnd' - 'outstanding_vnd')
                 or snap5.map(s.j->>'status') is distinct from v.status)::int, 0,
            'nâng cấp 005: v_lot_summary cột cũ giữ nguyên (phải trả, giá nhập, is_lot_late)');
select t.eq((select count(*) from public.v_lot_summary where paid_vnd <> 0 or outstanding_vnd <> payable_vnd)::int, 0,
            'nâng cấp 005: lô cũ: đã trả theo lô 0, còn nợ = phải trả (khoản Đã chuyển cũ không gắn lô)');
select t.eq((select count(*) from snap5.v_order s full join public.v_order_summary v on v.order_id = s.order_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 005: v_order_summary giữ nguyên (còn thu, cần hoàn, lãi, COD)');
select t.eq((select count(*) from snap5.v_stock s full join public.v_model_stock v on v.model_id = s.model_id
              where s.j is distinct from (to_jsonb(v) - 'incoming_value_vnd' - 'total_capital_vnd'))::int, 0, 'nâng cấp 005: v_model_stock cột cũ giữ nguyên');
select t.eq((select count(*) from public.v_model_stock v
              where v.incoming_value_vnd <> coalesce((select sum(cost_vnd) from public.v_units u where u.model_id = v.model_id
                                                        and not u.is_received and u.status in ('incoming','reserved')), 0)
                 or v.total_capital_vnd <> v.stock_value_vnd + v.incoming_value_vnd)::int, 0,
            'nâng cấp 005: incoming_value_vnd = Σ giá nhập chiếc chưa về; total_capital_vnd = trong kho + đang về');
select t.eq((select count(*) from snap5.v_balance s full join public.v_intermediary_balance v on v.user_id = s.user_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 005: v_intermediary_balance (còn nợ trung gian) giữ nguyên');
select t.eq((select count(*) from snap5.v_sugg s full join public.v_suggestions v on v.user_id = s.user_id
              where s.j is distinct from to_jsonb(v))::int, 0, 'nâng cấp 005: v_suggestions giữ nguyên');

-- 4. Backfill sổ quỹ
select t.eq((select count(*) from public.cash_entries)::int, (select sum(n) from snap5.cash_expect)::int,
            'nâng cấp 005: số bút toán backfill = khoản thu + Đã chuyển > 0 + ship shop chịu + ship chiều về (chạy 2 lần không nhân đôi)');
select t.eq((select count(*) from public.cash_entries where not is_auto)::int, 0, 'nâng cấp 005: backfill chỉ tạo bút toán tự sinh');
select t.eq((select count(*) from snap5.cash_expect x left join public.v_cash_balance b on b.user_id = x.user_id
              where b.total_in_vnd is distinct from x.cust_in
                 or b.total_out_vnd is distinct from x.refund_out + x.itx_out + x.ship_out + x.ret_out
                 or b.balance_vnd is distinct from x.cust_in - x.refund_out - x.itx_out - x.ship_out - x.ret_out)::int, 0,
            'nâng cấp 005: số dư quỹ từng người dùng = Σ thu khách − hoàn tiền − Đã chuyển − ship shop − ship về (bắt đầu từ 0)');
select t.eq((select count(*) from public.payments p
              left join public.cash_entries c on c.payment_id = p.id
             where c.id is null or c.amount_vnd <> p.amount_vnd or c.entry_date <> p.paid_at or c.order_id <> p.order_id
                or c.kind <> case when p.kind = 'refund' then 'customer_refund' else 'customer_payment' end
                or c.direction <> case when p.kind = 'refund' then 'out' else 'in' end)::int, 0,
            'nâng cấp 005: mỗi khoản thu cũ có đúng 1 bút toán (ngày, số tiền, chiều, đơn)');
select t.eq((select count(*) from public.intermediary_txns x left join public.cash_entries c on c.txn_id = x.id
              where x.kind = 'transfer' and ((x.amount_vnd > 0) <> (c.id is not null)
                    or (c.id is not null and (c.amount_vnd <> x.amount_vnd or c.entry_date <> x.txn_date or c.kind <> 'intermediary'))))::int, 0,
            'nâng cấp 005: mỗi khoản Đã chuyển > 0 có 1 bút toán tiền ra; khoản 0 ₫ không có');
select t.eq((select count(*) from public.cash_entries c join public.orders o on o.id = c.order_id
              where (c.kind = 'ship_shop' and (c.entry_date <> o.shipped_at or c.amount_vnd <> o.ship_fee_vnd))
                 or (c.kind = 'return_ship' and (c.entry_date <> o.returned_at or c.amount_vnd <> o.return_ship_fee_vnd)))::int, 0,
            'nâng cấp 005: bút toán ship shop chịu theo ngày gửi, ship chiều về theo ngày hoàn');
select t.eq((select sum(net_vnd) from public.v_cash_monthly)::bigint, (select sum(balance_vnd) from public.v_cash_balance)::bigint,
            'nâng cấp 005: Σ v_cash_monthly.net = Σ số dư quỹ');

-- 5. Cấu trúc
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_lot_summary' and ordinal_position > 29),
            'is_lot_late,paid_vnd,outstanding_vnd', 'nâng cấp 005: cột mới v_lot_summary nằm cuối');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'v_model_stock' and ordinal_position > 17),
            'is_low_stock,incoming_value_vnd,total_capital_vnd', 'nâng cấp 005: cột mới v_model_stock nằm cuối');
select t.eq((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
              where table_schema = 'public' and table_name = 'settings' and ordinal_position > 11),
            'bank_info,bank_bin,bank_account_no,bank_account_name', 'nâng cấp 005: cột VietQR nằm cuối settings');
select t.eq((select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
            'cash_entries,customers,intermediary_txns,lots,models,notes,order_lines,orders,payments,sellers,settings,units',
            'nâng cấp 005: realtime thêm cash_entries (12 bảng, chạy 2 lần không lỗi)');
select t.eq((select count(*) from pg_proc where proname in ('save_lot','set_lot_status','pay_lot','delete_order','receive_lot'))::int, 5,
            'nâng cấp 005: save_lot / set_lot_status / pay_lot / delete_order / receive_lot mỗi hàm 1 chữ ký');
select t.ok(not exists (select 1 from pg_constraint where conname = 'itx_payable_has_lot')
            and exists (select 1 from pg_constraint where conname = 'itx_lot_by_kind'), 'nâng cấp 005: ràng buộc itx_payable_has_lot → itx_lot_by_kind');
drop schema snap5 cascade;
