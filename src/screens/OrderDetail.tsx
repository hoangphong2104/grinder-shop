// SC_08 Chi tiết đơn - CR-004 DON-M3: thân trang = bước → khối tiền → khách → lãi (gập); thanh dính đáy = bước kế tiếp
// (Chốt đơn / Gửi hàng / Đã giao) + Thu tiền (+ QR); việc khác (Sửa, Vận đơn, COD, QR, Sao chép tin, Hoàn hàng, Huỷ, Xoá) ở menu "⋯".
// CR-005: VietQR chuyển khoản (ý 12), xoá đơn mọi trạng thái (ý 13, RPC delete_order), nhãn Vận chuyển tới khách / Đã giao,
// lãi có dấu + "dự kiến", khoản thu tự vào Sổ quỹ (trigger DB).
// CR-001: mỗi dòng = 1 chiếc cụ thể; lãi = Σ(giá chốt − giá nhập ₫ hiện tại của chiếc) − ship shop chịu (A8, không chụp giá).
// CR-004: COD (ship_order p_cod_amount_vnd, set_order_cod, khoản thu method 'cod'), Hoàn hàng (return_order), hình thức thu.
import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { OrderStatusDb, PaymentKindDb, PaymentMethodDb, PaymentRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { Shell } from '../ui/Shell.tsx'
import { LOT_LABEL, ORDER_LABEL, OrderChip, PAY_METHOD_LABEL } from '../ui/status.tsx'
import { dmy, parseNum, todayVn, tr, vnd } from '../ui/format.ts'
import { codesText, isSentStatus, makeLookup, PAY_LABEL, payState, profitStr, useIsDesk, VERSION_CONFLICT_MSG } from './orders/common.ts'
import { BANK_LINE_PLACEHOLDER, buildConfirmText } from './orders/confirmText.ts'
import { MoreIcon } from './orders/OrderRow.tsx'
import { bankCfg, bankName, downloadPng, qrContent, qrMessageLines, QrImg, useVietQr, type BankCfg } from './orders/vietqr.tsx'
import '../styles/orders.css'

type SheetKind = 'menu' | 'ship' | 'done' | 'cancel' | 'pay' | 'info' | 'cod' | 'return' | 'qr' | 'del1' | 'del2' | { copy: string } | { delPay: PaymentRow }
const fmt = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '')
/** Ô tiền ₫: trống ⇒ 0; sai / âm / lẻ ⇒ null. */
const money0 = (v: string) => {
  if (!v.trim()) return 0
  const n = parseNum(v)
  return n != null && n >= 0 && Number.isInteger(n) ? n : null
}

// key theo id ⇒ chuyển sang đơn khác luôn đóng sheet / menu đang mở của đơn trước.
export default function OrderDetail() {
  const { id = '' } = useParams()
  return <OrderDetailView key={id} id={id} />
}

function OrderDetailView({ id }: { id: string }) {
  const d = useData()
  const { rpc, reload } = useStore()
  const toast = useToast()
  const nav = useNavigate()
  const desk = useIsDesk()
  const lk = useMemo(() => makeLookup(d), [d])
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setSheet(null), [])

  const o = lk.order(id)
  const s = lk.sum(id)
  if (!o || !s) {
    return <Shell section="don" title="Không tìm thấy" back="/don"><div className="empty"><b>Không tìm thấy đơn</b><br />Đơn có thể đã bị xoá trên máy khác.<br /><br /><Link className="btn btn-ghost" to="/don">Về danh sách đơn</Link></div></Shell>
  }
  const code = d.orderCode[o.id]
  const c = lk.cust(o.customer_id)
  const lines = lk.lines(o.id)
  const total = lk.total(s)
  const due = s.receivable_vnd
  const sent = isSentStatus(o.status)
  const returned = o.status === 'returned'
  const closedMoney = o.status === 'cancelled' || returned // chỉ còn việc hoàn tiền
  const profit = lk.profit(o.id)
  const payments = d.payments.filter((p) => p.order_id === o.id)

  // Từng chiếc của đơn + giá nhập ₫ hiệu lực hiện tại (v_units) + lãi theo chiếc.
  const rows = lines.map((x) => {
    const u = lk.unit(x.unit_id)
    return { x, u, profit: u ? x.unit_price_vnd - u.cost_vnd : null }
  })
  // Chiếc còn chưa về kho (lô chưa Đã nhận) - chặn chốt (A7) và gửi (A8).
  const notIn = rows.filter((r) => !r.u?.is_received)
  const notInText = notIn.map((r) => r.u ? `${r.u.code} (${d.lotCode[r.u.lot_id] ?? 'lô'} · ${LOT_LABEL[r.u.lot_status]})` : '?').join(', ')
  const provisional = rows.some((r) => r.u?.cost_is_provisional)
  const codesAll = codesText(s.unit_codes, 50)
  // CR-005 ý 12: QR chuyển khoản = số còn phải thu (trừ phần COD shipper đang thu hộ, tránh khách trả 2 lần).
  const cfg = bankCfg(d.settings)
  const qrAmount = closedMoney ? 0 : Math.max(due - s.cod_pending_vnd, 0)

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); setSheet(null); toast(ok) } catch (e) { toast(e instanceof Error ? e.message : errorMessage(e)) } finally { setBusy(false) }
  }
  const chot = () => run(() => rpc('confirm_preorder', { p_order_id: o.id, p_expected_version: o.version }), `Đã chốt ${code}`)
  const complete = (force: boolean) => run(() => rpc('complete_order', { p_order_id: o.id, p_force: force, p_expected_version: o.version }), `${code} · Đã giao`)
  const onDone = () => (due !== 0 ? setSheet('done') : complete(false))

  // DON-S2: sao chép ngay trong lúc bấm (giữ "user activation"); không được ⇒ sheet có ô chữ để tự chọn / sao chép.
  // CR-005: withQr = thay dòng STK bằng dòng chuyển khoản VietQR (ngân hàng · STK · số tiền · nội dung = mã đơn).
  const copyConfirm = (withQr = false) => {
    const qrLines = withQr && cfg && qrAmount > 0 ? qrMessageLines(cfg, qrAmount, code) : null
    const text = buildConfirmText({ code, o, s, c, lines: rows.map(({ x, u }) => ({ code: u?.code ?? '?', model: u?.model_name ?? '', price: x.unit_price_vnd })), bankLine: d.settings?.bank_info, qrLines })
    const ok = () => { setSheet(null); toast(text.includes(BANK_LINE_PLACEHOLDER) ? 'Đã sao chép - điền STK trước khi gửi khách' : qrLines ? 'Đã sao chép tin kèm dòng chuyển khoản - gửi khách cùng ảnh QR' : 'Đã sao chép tin xác nhận - dán vào Messenger / Zalo') }
    const fallback = () => setSheet({ copy: text })
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fallback)
      else fallback()
    } catch { fallback() }
  }

  // Bước trạng thái: Hoàn hàng thay bước cuối "Đã giao" (chip đỏ); Huỷ = cả dãy xám.
  const flow: OrderStatusDb[] = [o.status === 'preorder' ? 'preorder' : 'confirmed', 'shipped', returned ? 'returned' : 'completed']
  const idx = flow.indexOf(o.status)
  const stepper = (
    <div className={`stepper ${o.status === 'cancelled' ? 'cancel' : ''}`}>
      {flow.map((k, i) => <div key={k} className={`st ${i < idx ? 'done' : i === idx ? (k === 'returned' ? 'ret' : 'cur') : ''}`}><span className="dot" /><span className="lb">{ORDER_LABEL[k]}</span></div>)}
    </div>
  )

  // Thanh dính đáy: 1 nút chính (bước kế tiếp) + tối đa 1 nút phụ (thu tiền).
  let primary: { label: string; onClick: () => void } | null = null
  if (o.status === 'preorder' && s.all_units_received) primary = { label: 'Chốt đơn', onClick: chot }
  else if (o.status === 'confirmed') primary = { label: 'Gửi hàng', onClick: () => setSheet('ship') }
  else if (o.status === 'shipped') primary = { label: 'Đã giao', onClick: onDone }
  const canPay = !closedMoney || s.paid_vnd > 0
  let payBtn: string | null = null
  if (!closedMoney && o.status !== 'completed') payBtn = s.cod_pending_vnd > 0 ? 'Nhận COD' : 'Thu tiền'
  else if (o.status === 'completed' && due !== 0) payBtn = due > 0 ? 'Thu tiền' : 'Ghi hoàn tiền'
  else if (closedMoney && s.refund_due_vnd > 0) payBtn = 'Ghi hoàn tiền'
  const savebar = (primary || payBtn) ? (
    <>
      {qrAmount > 0 && payBtn && <button className="btn btn-ghost o-qr-btn" disabled={busy} onClick={() => setSheet('qr')} aria-label="QR chuyển khoản">QR</button>}
      {payBtn && <button className={`btn ${primary ? 'btn-ghost' : 'btn-primary'} btn-block`} disabled={busy} onClick={() => setSheet('pay')}>{payBtn}</button>}
      {primary && <button className="btn btn-primary btn-block" disabled={busy} onClick={primary.onClick}>{busy ? 'Đang lưu…' : primary.label}</button>}
    </>
  ) : undefined

  const pay = payState(s)
  const fbIsUrl = !!c?.fb_url && /^https?:\/\//i.test(c.fb_url)
  const profitLabel = returned ? 'Lãi đơn hoàn hàng' : sent ? 'Lãi đơn' : 'Lãi dự kiến'
  // Nhãn đã ghi "Lãi dự kiến" khi chưa chốt ⇒ số chỉ cần dấu +/−.
  const profitText = profitStr(profit.value)

  return (
    <Shell section="don" title={code} back="/don" savebar={savebar}
      actions={<button className="icon-btn" onClick={() => setSheet('menu')} aria-label="Thao tác khác"><MoreIcon /></button>}>
      <div className="o-sub">
        <span className="nm">{c ? <Link to={`/don?khach=${c.id}&f=all`}>{c.fb_name}</Link> : s.customer_name}</span>
        <span className="o-chips"><OrderChip s={o.status} />{pay && <span className={`pill ${pay.tone}`}>{pay.long}</span>}</span>
      </div>
      <div className="cols">
        <div>
          {stepper}
          {o.status === 'preorder' && (s.all_units_received
            ? <div className="note-box"><span>Mọi chiếc của đơn đã về kho - bấm “Chốt đơn”.</span></div>
            : <div className="note-box way"><span>Chờ hàng về - {notInText}. Khi lô được nhận vào kho, đơn tự chuyển Đã chốt.</span></div>)}
          {o.status === 'cancelled' && (
            <div className="warn-box"><span>Đơn đã huỷ.{s.refund_due_vnd > 0 && <> Cần hoàn khách {vnd(s.refund_due_vnd)} - ghi “Hoàn tiền” khi đã trả lại.</>}</span></div>
          )}
          {returned && (
            <div className="warn-box"><span>Hoàn hàng ngày {dmy(o.returned_at)} - {codesAll} đã về Kho Lumi. {o.keep_deposit ? 'Shop giữ cọc.' : 'Hoàn cọc cho khách.'}
              {s.refund_due_vnd > 0 && <> Cần hoàn khách {vnd(s.refund_due_vnd)}.</>}</span></div>
          )}
          {o.completion_forced && o.status === 'completed' && <div className="note-box"><span>Đơn chuyển Đã giao khi chưa thu khớp tiền (đã xác nhận bỏ qua).</span></div>}

          <div className="calc">
            {rows.map(({ x, u }) => (
              <div key={x.id} className="ln">
                <span>{u ? <Link to={`/kho/${u.unit_id}`}>{u.code}</Link> : '?'} · {u?.model_name ?? 'Không tìm thấy chiếc'}</span>
                <span>{vnd(x.unit_price_vnd)}</span>
              </div>
            ))}
            <div className="ln"><span>Ship VN · {o.ship_fee_payer === 'customer' ? 'khách trả (thu hộ)' : 'shop chịu'}</span><span>{vnd(o.ship_fee_vnd)}</span></div>
            <div className="ln total"><span>Khách phải trả</span><span>{vnd(total)}</span></div>
            {payments.map((p) => (
              <div key={p.id} className="ln sub-ln">
                <span><button className="link-btn" onClick={() => setSheet({ delPay: p })} aria-label={`Khoản ${PAY_LABEL[p.kind]} ngày ${dmy(p.paid_at)} - bấm để xoá nếu ghi nhầm`}>{dmy(p.paid_at)} · {PAY_LABEL[p.kind]}</button>
                  <span className="pm"> · {PAY_METHOD_LABEL[p.method ?? 'transfer']}{p.note ? ` · ${p.note}` : ''}</span></span>
                <span>{p.kind === 'refund' ? '−' : ''}{vnd(p.amount_vnd)}</span>
              </div>
            ))}
            <div className="ln"><span>Đã thu</span><span>{vnd(s.paid_vnd)}</span></div>
            {o.cod_amount_vnd > 0 && <>
              <div className="ln sub-ln"><span>COD shipper thu{o.status === 'shipped' && <> · <button className="link-btn" onClick={() => setSheet('cod')}>sửa</button></>}</span><span>{vnd(o.cod_amount_vnd)}</span></div>
              {s.cod_received_vnd > 0 && <div className="ln sub-ln"><span>COD đã về</span><span>{vnd(s.cod_received_vnd)}</span></div>}
              {s.cod_pending_vnd > 0 && <div className="ln cod"><span>COD chờ hãng chuyển</span><span>{vnd(s.cod_pending_vnd)}</span></div>}
            </>}
            {returned && s.kept_vnd != null && <div className="ln"><span>Shop giữ lại{o.keep_deposit ? ' (cọc)' : ''}</span><span>{vnd(s.kept_vnd)}</span></div>}
            {closedMoney
              ? <div className="ln total"><span>Cần hoàn khách</span><span className={s.refund_due_vnd > 0 ? 'req' : undefined}>{vnd(s.refund_due_vnd)}</span></div>
              : due < 0
                ? <div className="ln total"><span>Khách trả dư</span><span>{vnd(-due)}</span></div>
                : <div className="ln total"><span>Còn phải thu</span><span className={due > 0 ? 'req' : undefined}>{vnd(due)}</span></div>}
          </div>
        </div>
        <div>
          <dl className="kv">
            <dt>Khách</dt><dd>{c ? <Link to={`/don?khach=${c.id}&f=all`}>{c.fb_name}</Link> : s.customer_name}{c?.is_hidden ? <span className="muted small"> (đã ẩn)</span> : null}</dd>
            <dt>Facebook</dt><dd className="small">{fbIsUrl ? <a href={c!.fb_url!} target="_blank" rel="noreferrer">{c!.fb_url}</a> : c?.fb_url || '-'}</dd>
            <dt>SĐT</dt><dd>{c?.phone ? <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a> : '-'}</dd>
            <dt>Địa chỉ</dt><dd className="small">{c?.address || '-'}</dd>
            <dt>Ngày đơn</dt><dd>{dmy(o.order_date)}</dd>
            <dt>Ngày gửi</dt><dd>{dmy(o.shipped_at)}</dd>
            {returned && <><dt>Hoàn hàng</dt><dd>{dmy(o.returned_at)}{o.return_ship_fee_vnd > 0 ? ` · ship về ${vnd(o.return_ship_fee_vnd)}` : ''}{o.return_note ? <span className="small muted"> · {o.return_note}</span> : null}</dd></>}
            <dt>Mã vận đơn</dt><dd>{o.tracking_no || '-'}</dd>
            <dt>Ghi chú</dt><dd className="small">{o.note || '-'}</dd>
          </dl>
          {o.status !== 'cancelled' && (
            <details className="o-profit" open={desk}>
              <summary><span>{profitLabel}<span className="chev">▾</span></span><span className={`v ${(profit.value ?? 0) < 0 ? 'tone-bad' : ''}`}>{profitText}</span></summary>
              <div className="calc">
                {returned ? <>
                  <div className="ln"><span>Shop giữ lại</span><span>{vnd(s.kept_vnd)}</span></div>
                  {o.ship_fee_payer === 'shop' && o.ship_fee_vnd > 0 && <div className="ln"><span>Ship đi shop chịu</span><span>−{vnd(o.ship_fee_vnd)}</span></div>}
                  {o.return_ship_fee_vnd > 0 && <div className="ln"><span>Ship chiều về</span><span>−{vnd(o.return_ship_fee_vnd)}</span></div>}
                  <div className="ln total"><span>{profitLabel}</span><span>{profitText}</span></div>
                  <div className="formula">Chiếc đã về kho nên không trừ giá nhập. Lãi tính vào tháng hoàn hàng.</div>
                </> : <>
                  {rows.map(({ x, u, profit: p }) => (
                    <div key={x.id} className="ln">
                      <span>
                        {u?.code ?? '?'} · chốt {tr(x.unit_price_vnd)}
                        <span className="sub">giá nhập {u ? vnd(u.cost_vnd) : '-'}{u?.cost_is_overridden ? ' (sửa tay)' : u?.cost_is_provisional ? ' (tạm tính, chưa có ship lô)' : ''}</span>
                      </span>
                      <span>{profitStr(p)}</span>
                    </div>
                  ))}
                  {o.ship_fee_payer === 'shop' && o.ship_fee_vnd > 0 && <div className="ln"><span>Ship shop chịu</span><span>−{vnd(o.ship_fee_vnd)}</span></div>}
                  <div className="ln total"><span>{profitLabel}</span><span>{profitText}</span></div>
                  <div className="formula">Giá nhập theo từng chiếc - đổi nếu bạn sửa phí ship lô / sửa tay.{provisional ? ' Có chiếc giá nhập tạm tính (lô chưa có phí ship).' : ''}</div>
                </>}
              </div>
            </details>
          )}
        </div>
      </div>

      {sheet === 'menu' && (
        <Sheet title={`Thao tác · ${code}`} onClose={close}>
          <div className="list o-menu">
            {(o.status === 'preorder' || o.status === 'confirmed') && (
              <button className="li" onClick={() => nav(`/don/${o.id}/sua`)}><span className="main"><b>Sửa đơn</b><span className="s">Khách, chiếc, giá chốt, ship</span></span><Icon name="chev" size={16} /></button>
            )}
            <button className="li" onClick={() => setSheet('info')}><span className="main"><b>Sửa mã vận đơn / ghi chú</b><span className="s">{o.tracking_no || 'Chưa có mã vận đơn'}</span></span><Icon name="chev" size={16} /></button>
            {o.status === 'shipped' && (
              <button className="li" onClick={() => setSheet('cod')}><span className="main"><b>Sửa tiền COD</b><span className="s">{o.cod_amount_vnd > 0 ? `Shipper thu ${vnd(o.cod_amount_vnd)}` : 'Không thu COD'}</span></span><Icon name="chev" size={16} /></button>
            )}
            {canPay && (
              <button className="li" onClick={() => setSheet('pay')}><span className="main"><b>{closedMoney ? 'Ghi hoàn tiền' : 'Ghi khoản thu / hoàn tiền'}</b><span className="s">Chuyển khoản · Tiền mặt · COD</span></span><Icon name="chev" size={16} /></button>
            )}
            {qrAmount > 0 && (
              <button className="li" onClick={() => setSheet('qr')}><span className="main"><b>QR chuyển khoản</b><span className="s">{cfg ? `Khách quét trả ${vnd(qrAmount)} · nội dung ${qrContent(code)}` : 'Cần cài tài khoản ngân hàng trong Cài đặt'}</span></span><Icon name="chev" size={16} /></button>
            )}
            <button className="li" onClick={() => copyConfirm()}><span className="main"><b>Sao chép tin xác nhận đơn</b><span className="s">Mã chiếc, giá, ship, cọc, còn lại - dán Messenger / Zalo</span></span><Icon name="chev" size={16} /></button>
            {o.status === 'shipped' && (
              <button className="li danger" onClick={() => setSheet('return')}><span className="main"><b>Hoàn hàng / khách không nhận</b><span className="s">Chiếc về lại kho, chọn giữ hay hoàn cọc</span></span><Icon name="chev" size={16} /></button>
            )}
            {(o.status === 'preorder' || o.status === 'confirmed') && (
              <button className="li danger" onClick={() => setSheet('cancel')}><span className="main"><b>Huỷ đơn</b><span className="s">Bỏ giữ chiếc; tiền đã thu thành “cần hoàn”</span></span><Icon name="chev" size={16} /></button>
            )}
            <button className="li danger" id="od-delete" onClick={() => setSheet('del1')}><span className="main"><b>Xoá đơn</b><span className="s">Xoá hẳn đơn ghi nhầm - chiếc về kho, xoá khoản thu + sổ quỹ</span></span><Icon name="chev" size={16} /></button>
          </div>
        </Sheet>
      )}
      {sheet === 'ship' && (
        <ShipSheet onClose={close} busy={busy} tracking={o.tracking_no ?? ''}
          shortText={notIn.length ? notInText : ''} codes={codesAll} due={Math.max(due, 0)}
          onOk={(tracking, date, cod) => run(() => rpc('ship_order', { p_order_id: o.id, p_tracking_no: tracking || null, p_shipped_at: date || null, p_expected_version: o.version, p_cod_amount_vnd: cod }),
            `${code} · Vận chuyển tới khách${cod > 0 ? ` · COD ${tr(cod)}` : ''}${profit.value != null ? ` · lãi ${profitStr(profit.value, false, true)}` : ''}`)} />
      )}
      {sheet === 'cod' && (
        <CodSheet onClose={close} busy={busy} cod={o.cod_amount_vnd} received={s.cod_received_vnd} due={Math.max(due, 0)} version={o.version}
          onOk={(cod, version) => run(() => rpc('set_order_cod', { p_order_id: o.id, p_cod_amount_vnd: cod, p_expected_version: version }),
            cod > 0 ? `Đã lưu COD ${vnd(cod)}` : 'Đã bỏ COD')} />
      )}
      {sheet === 'return' && (
        <ReturnSheet onClose={close} busy={busy} codes={codesAll} paid={s.paid_vnd} deposit={s.deposit_vnd} codPending={s.cod_pending_vnd}
          shipShop={o.ship_fee_payer === 'shop' ? o.ship_fee_vnd : 0} shipCustomer={o.ship_fee_payer === 'customer' ? o.ship_fee_vnd : 0}
          shippedAt={o.shipped_at ?? o.order_date} version={o.version}
          onOk={(r) => run(() => rpc('return_order', {
            p_order_id: o.id, p_keep_deposit: r.keep, p_return_ship_fee_vnd: r.fee, p_returned_at: r.date || null, p_note: r.note || null, p_expected_version: r.version,
          }), `Đã hoàn hàng ${code}${r.refund > 0 ? ` · cần hoàn ${tr(r.refund)}` : ''}`)} />
      )}
      {sheet === 'done' && (
        <Sheet title={due > 0 ? 'Khách còn nợ' : 'Khách trả dư'} onClose={close}
          footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={() => complete(true)}>Vẫn chuyển Đã giao</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            {due > 0
              ? <>Còn phải thu {vnd(due)}{s.cod_pending_vnd > 0 && <> (trong đó COD hãng chưa chuyển {vnd(s.cod_pending_vnd)} - ghi “Nhận COD” khi tiền về)</>}. Vẫn chuyển đơn sang Đã giao? (BR-10)</>
              : `Khách trả dư ${vnd(-due)}. Vẫn chuyển đơn sang Đã giao? (Q-010)`}
          </p>
        </Sheet>
      )}
      {sheet === 'cancel' && (
        <Sheet title="Huỷ đơn?" onClose={close}
          footer={<button className="btn btn-danger btn-block" disabled={busy}
            onClick={() => run(() => rpc('cancel_order', { p_order_id: o.id, p_expected_version: o.version }),
              s.paid_vnd > 0 ? `Đã huỷ ${code} · cần hoàn ${tr(s.paid_vnd)}` : `Đã huỷ ${code}`)}>Huỷ đơn</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            Bỏ giữ {codesAll} cho {code} - các chiếc trả về Kho Lumi / Kho TQ / Kho VN. Tiền cọc đã thu cần ghi “Hoàn tiền” nếu trả lại khách.{s.paid_vnd > 0 ? ` Đã thu ${vnd(s.paid_vnd)}.` : ''} Không hoàn tác được.
          </p>
        </Sheet>
      )}
      {sheet === 'pay' && (
        <PaySheet onClose={close} busy={busy} refundOnly={closedMoney}
          prefill={closedMoney ? s.refund_due_vnd : s.cod_pending_vnd > 0 ? s.cod_pending_vnd : Math.abs(due)}
          defaultKind={closedMoney || due < 0 ? 'refund' : 'payment'}
          defaultMethod={!closedMoney && s.cod_pending_vnd > 0 ? 'cod' : 'transfer'}
          onOk={(amount, kind, method, date, note) => run(async () => {
            const { error } = await supabase.from('payments').insert({ order_id: o.id, paid_at: date, kind, method, amount_vnd: amount, note: note || null })
            if (error) throw new Error(errorMessage(error))
            await reload()
          }, `Đã ghi ${PAY_LABEL[kind].toLowerCase()} ${vnd(amount)} · ${PAY_METHOD_LABEL[method].toLowerCase()}`)} />
      )}
      {sheet === 'info' && (
        <InfoSheet onClose={close} busy={busy} tracking={o.tracking_no ?? ''} note={o.note ?? ''} version={o.version}
          onOk={(tracking, note, version) => run(async () => {
            const { data: upd, error } = await supabase.from('orders').update({ tracking_no: tracking || null, note: note || null })
              .eq('id', o.id).eq('version', version).select('id')
            if (error) throw new Error(errorMessage(error))
            await reload()
            if (!upd?.length) throw new Error(VERSION_CONFLICT_MSG)
          }, 'Đã lưu')} />
      )}
      {sheet === 'qr' && (
        <QrSheet onClose={close} cfg={cfg} amount={qrAmount} code={code} codPending={s.cod_pending_vnd}
          onOpenSettings={() => nav('/caidat')} onCopyMsg={() => copyConfirm(true)} />
      )}
      {sheet === 'del1' && (
        <Sheet title={`Xoá đơn ${code}?`} onClose={close}
          footer={<button className="btn btn-danger btn-block" id="od-del-next" onClick={() => setSheet('del2')}>Tiếp tục</button>}>
          <p className="muted" style={{ margin: 0 }}>Xoá hẳn đơn {code} ({ORDER_LABEL[o.status]}) - dùng khi ghi nhầm. Sau khi xoá:</p>
          <ul className="o-del-list">
            <li>{codesAll || 'Các chiếc của đơn'} trả về kho (Kho Lumi / Kho TQ / Kho VN), bán lại được.</li>
            <li>{payments.length ? `${payments.length} khoản thu / hoàn tiền (đã thu ${vnd(s.paid_vnd)})` : 'Các khoản thu của đơn'} bị xoá, kèm các dòng trong Sổ quỹ (cả ship shop chịu / ship chiều về).</li>
            <li>Lãi của đơn không còn tính vào báo cáo.</li>
          </ul>
          {o.status !== 'preorder' && o.status !== 'confirmed' && o.status !== 'cancelled' && (
            <div className="warn-box"><span>Đơn đã gửi hàng. Nếu khách thật sự đã mua, đừng xoá - dùng “Hoàn hàng” hoặc giữ đơn.</span></div>
          )}
        </Sheet>
      )}
      {sheet === 'del2' && (
        <Sheet title="Xác nhận lần cuối" onClose={close}
          footer={<button className="btn btn-danger btn-block" id="od-del-confirm" disabled={busy} onClick={() => run(async () => {
            await rpc('delete_order', { p_order_id: o.id, p_expected_version: o.version })
            nav('/don', { replace: true })
          }, `Đã xoá đơn ${code}`)}>{busy ? 'Đang xoá…' : `Xoá hẳn ${code}`}</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Không hoàn tác được. Xoá đơn {code} của {c?.fb_name ?? s.customer_name}{s.paid_vnd ? `, cùng khoản thu ${vnd(s.paid_vnd)}` : ''}?</p>
        </Sheet>
      )}
      {sheet && typeof sheet === 'object' && 'copy' in sheet && <CopySheet text={sheet.copy} onClose={close} />}
      {sheet && typeof sheet === 'object' && 'delPay' in sheet && (
        <Sheet title="Xoá khoản thu?" onClose={close}
          footer={<button className="btn btn-danger btn-block" disabled={busy} onClick={() => run(async () => {
            const { error } = await supabase.from('payments').delete().eq('id', sheet.delPay.id)
            if (error) throw new Error(errorMessage(error))
            await reload()
          }, 'Đã xoá khoản thu')}>Xoá khoản thu</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            {PAY_LABEL[sheet.delPay.kind]} · {PAY_METHOD_LABEL[sheet.delPay.method ?? 'transfer']} {vnd(sheet.delPay.amount_vnd)} ngày {dmy(sheet.delPay.paid_at)}. Chỉ xoá khi ghi nhầm - còn phải thu tính lại, dòng tương ứng trong Sổ quỹ cũng bị xoá.
          </p>
        </Sheet>
      )}
    </Shell>
  )
}

function ShipSheet({ onClose, onOk, busy, tracking, shortText, codes, due }: {
  onClose: () => void; onOk: (tracking: string, date: string, cod: number) => void; busy: boolean; tracking: string; shortText: string; codes: string; due: number
}) {
  const [tk, setTk] = useState(tracking)
  const [date, setDate] = useState(todayVn())
  // DON-S1: mặc định COD = số còn phải thu (khách trả nốt khi nhận hàng); 0 / trống = không thu COD.
  const [cod, setCod] = useState(fmt(due))
  const [err, setErr] = useState<string | null>(null)
  const codN = money0(cod)
  const submit = () => {
    if (codN == null) { setErr('Tiền COD là số đồng ≥ 0 (để trống nếu không thu COD).'); return }
    setErr(null)
    onOk(tk.trim(), date, codN)
  }
  return (
    <Sheet title="Gửi hàng" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy || !!shortText || !date} onClick={submit}>{busy ? 'Đang lưu…' : 'Xác nhận đã gửi'}</button>}>
      {shortText && <div className="warn-box"><span>Còn chiếc chưa về kho - chưa gửi được: {shortText}.</span></div>}
      <label className="f" htmlFor="sh-tracking">Mã vận đơn<input className="input" id="sh-tracking" value={tk} onChange={(e) => setTk(e.target.value)} placeholder="VD: GHTK 1234" maxLength={100} /></label>
      <label className="f" htmlFor="sh-cod">Tiền COD shipper thu (₫)
        <input className="input money" id="sh-cod" inputMode="numeric" value={cod} onChange={(e) => setCod(e.target.value)} placeholder="0" aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
        <span className="hint">
          {codN != null && codN > due ? `Lớn hơn số còn phải thu (${vnd(due)}) - kiểm tra lại. ` : ''}
          Còn phải thu {vnd(due)}. Để 0 nếu khách đã chuyển khoản đủ.
        </span>
      </label>
      <label className="f" htmlFor="sh-date">Ngày gửi<input className="input" id="sh-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <p className="hint">Đơn chuyển “Vận chuyển tới khách”, {codes} thành đã bán. Không hoàn tác được (khách bom ⇒ dùng “Hoàn hàng”).</p>
    </Sheet>
  )
}

function CodSheet({ onClose, onOk, busy, cod, received, due, version }: {
  onClose: () => void; onOk: (cod: number, version: number) => void; busy: boolean; cod: number; received: number; due: number; version: number
}) {
  const [ver] = useState(version)
  const [v, setV] = useState(fmt(cod))
  const [err, setErr] = useState<string | null>(null)
  const submit = () => {
    const n = money0(v)
    if (n == null) { setErr('Tiền COD là số đồng ≥ 0.'); return }
    setErr(null)
    onOk(n, ver)
  }
  return (
    <Sheet title="Tiền COD" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={submit}>Lưu</button>}>
      <label className="f" htmlFor="cod-amt">Tiền COD shipper thu (₫)
        <input className="input money" id="cod-amt" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} placeholder="0" aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
        <span className="hint">Đã nhận COD {vnd(received)} · còn phải thu {vnd(due)}. Khi hãng chuyển tiền, ghi khoản thu hình thức “COD”.</span>
      </label>
    </Sheet>
  )
}

function ReturnSheet({ onClose, onOk, busy, codes, paid, deposit, codPending, shipShop, shipCustomer, shippedAt, version }: {
  onClose: () => void; busy: boolean; codes: string; paid: number; deposit: number; codPending: number; shipShop: number; shipCustomer: number; shippedAt: string; version: number
  onOk: (r: { keep: boolean; fee: number; date: string; note: string; refund: number; version: number }) => void
}) {
  const [ver] = useState(version)
  // Giữ / hoàn cọc: bắt chọn rõ (không mặc định) - trừ khi đơn không có cọc.
  const [keep, setKeep] = useState<boolean | null>(deposit > 0 ? null : false)
  const [fee, setFee] = useState('')
  const [date, setDate] = useState(() => { const t = todayVn(); return t < shippedAt ? shippedAt : t })
  const [note, setNote] = useState('')
  const [err, setErr] = useState<Partial<Record<'keep' | 'fee' | 'date', string>>>({})
  const feeN = money0(fee)
  // Luật tiền Hoàn hàng (003): cần hoàn = max(đã thu ròng − (giữ cọc ? Σ cọc : 0), 0); lãi = shop giữ − ship đi shop chịu − ship về.
  const refund = Math.max(paid - (keep ? deposit : 0), 0)
  const kept = paid - refund
  const profitV = kept - shipShop - (feeN ?? 0)
  const submit = () => {
    const e: typeof err = {}
    if (keep == null) e.keep = 'Chọn giữ cọc hay hoàn cọc cho khách.'
    if (feeN == null) e.fee = 'Phí ship chiều về là số đồng ≥ 0.'
    if (!date) e.date = 'Chọn ngày hoàn hàng.'
    else if (date < shippedAt) e.date = `Ngày hoàn hàng không trước ngày gửi (${dmy(shippedAt)}).`
    setErr(e)
    if (Object.keys(e).length) return
    onOk({ keep: !!keep, fee: feeN ?? 0, date, note: note.trim(), refund, version: ver })
  }
  return (
    <Sheet title="Hoàn hàng / khách không nhận" onClose={onClose}
      footer={<button className="btn btn-danger btn-block" disabled={busy || keep == null} onClick={submit}>{busy ? 'Đang lưu…' : 'Xác nhận hoàn hàng'}</button>}>
      <p className="hint" style={{ margin: 0 }}>{codes} về lại Kho Lumi, bán lại được. Đơn chuyển “Hoàn hàng”, không còn đòi khách.</p>
      <div className="f" id="rt-keep">
        <span className="small muted">Tiền cọc{deposit > 0 ? ` (${vnd(deposit)})` : ''}</span>
        {deposit > 0
          ? <div className="o-choice" role="group" aria-label="Giữ hay hoàn cọc">
            <button type="button" className="chip" aria-pressed={keep === true} onClick={() => setKeep(true)}>Giữ cọc</button>
            <button type="button" className="chip" aria-pressed={keep === false} onClick={() => setKeep(false)}>Hoàn cọc cho khách</button>
          </div>
          : <span className="hint">Đơn không có khoản cọc.</span>}
        {err.keep && <span className="err-text">{err.keep}</span>}
      </div>
      <label className="f" htmlFor="rt-fee">Phí ship chiều về (₫)
        <input className="input money" id="rt-fee" inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" aria-invalid={!!err.fee} />
        {err.fee && <span className="err-text">{err.fee}</span>}
        {shipCustomer > 0 && <span className="hint">Khách chịu ship đi ({vnd(shipCustomer)}) nhưng bom ⇒ nếu shop phải trả hãng, cộng cả phí đó vào đây.</span>}
      </label>
      <label className="f" htmlFor="rt-date">Ngày hoàn hàng
        <input className="input" id="rt-date" type="date" value={date} min={shippedAt} onChange={(e) => setDate(e.target.value)} aria-invalid={!!err.date} />
        {err.date && <span className="err-text">{err.date}</span>}
      </label>
      <label className="f" htmlFor="rt-note">Ghi chú<input className="input" id="rt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: Khách không nghe máy, GHTK chuyển hoàn" maxLength={1000} /></label>
      <div className="calc o-preview" aria-live="polite">
        <div className="ln"><span>Đã thu của khách</span><span>{vnd(paid)}</span></div>
        <div className="ln"><span>Shop giữ lại</span><span>{keep == null ? '-' : vnd(kept)}</span></div>
        <div className="ln total"><span>Cần hoàn khách</span><span className={refund > 0 && keep != null ? 'req' : undefined}>{keep == null ? '-' : vnd(refund)}</span></div>
        {shipShop > 0 && <div className="ln"><span>Ship đi shop chịu</span><span>−{vnd(shipShop)}</span></div>}
        <div className="ln"><span>Ship chiều về</span><span>{(feeN ?? 0) > 0 ? '−' : ''}{vnd(feeN ?? 0)}</span></div>
        <div className="ln total"><span>{profitV < 0 ? 'Lỗ đơn' : 'Lãi đơn'}</span><span className={profitV < 0 ? 'req' : undefined}>{keep == null ? '-' : vnd(profitV)}</span></div>
        <div className="formula">
          Lãi = shop giữ − ship shop chịu − ship về (không trừ giá nhập vì chiếc về kho), tính vào tháng hoàn hàng.
          {refund > 0 && keep != null ? ' Cần hoàn hiện ở đơn tới khi bạn ghi “Hoàn tiền”.' : ''}
          {codPending > 0 ? ` COD chờ về ${vnd(codPending)} sẽ bỏ (hãng chuyển hoàn, không thu).` : ''}
          {' '}Không hoàn tác được.
        </div>
      </div>
    </Sheet>
  )
}

function PaySheet({ onClose, onOk, busy, prefill, defaultKind, defaultMethod, refundOnly }: {
  onClose: () => void; onOk: (amount: number, kind: PaymentKindDb, method: PaymentMethodDb, date: string, note: string) => void
  busy: boolean; prefill: number; defaultKind: PaymentKindDb; defaultMethod: PaymentMethodDb; refundOnly: boolean
}) {
  const [amt, setAmt] = useState(fmt(prefill))
  const [kind, setKindRaw] = useState<PaymentKindDb>(defaultKind)
  const [method, setMethod] = useState<PaymentMethodDb>(defaultKind === 'payment' ? defaultMethod : 'transfer')
  const [date, setDate] = useState(todayVn())
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const kinds: PaymentKindDb[] = refundOnly ? ['refund'] : ['payment', 'deposit', 'refund']
  // COD chỉ cho khoản "Thanh toán" (check DB payments_cod_is_payment)
  const methods: PaymentMethodDb[] = kind === 'payment' ? ['transfer', 'cash', 'cod'] : ['transfer', 'cash']
  const setKind = (k: PaymentKindDb) => { setKindRaw(k); if (k !== 'payment' && method === 'cod') setMethod('transfer') }
  const submit = () => {
    const a = parseNum(amt)
    if (a == null || a <= 0 || !Number.isInteger(a)) { setErr('Nhập số tiền lớn hơn 0 (đồng, số nguyên).'); return }
    if (!date) { setErr('Chọn ngày thu.'); return }
    setErr(null)
    onOk(a, kind, method, date, note.trim())
  }
  return (
    <Sheet title={refundOnly ? 'Ghi hoàn tiền' : 'Ghi thu tiền'} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={submit}>{busy ? 'Đang lưu…' : 'Lưu'}</button>}>
      <label className="f" htmlFor="p-amt">Số tiền (₫)
        <input className="input money" id="p-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value)} aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
      </label>
      {kinds.length > 1 && (
        <div className="seg" id="p-kind" role="group" aria-label="Loại khoản thu">
          {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{PAY_LABEL[k]}</button>)}
        </div>
      )}
      <div className="f">
        <span className="small muted" id="p-method-l">Hình thức</span>
        <div className="o-choice" id="p-method" role="group" aria-labelledby="p-method-l">
          {methods.map((m) => <button key={m} type="button" className="chip" aria-pressed={method === m} onClick={() => setMethod(m)}>{PAY_METHOD_LABEL[m]}</button>)}
        </div>
      </div>
      {kind === 'refund' && <p className="hint">Hoàn tiền trừ vào số đã thu của đơn.</p>}
      <p className="hint">Khoản này tự ghi vào Sổ quỹ ({kind === 'refund' ? 'tiền ra' : 'tiền vào'}) - không cần ghi thêm.</p>
      {method === 'cod' && <p className="hint">Tiền hãng ship chuyển về sau khi giao - trừ vào “COD chờ về”.</p>}
      <label className="f" htmlFor="p-date">Ngày<input className="input" id="p-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="f" htmlFor="p-note">Ghi chú<input className="input" id="p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={method === 'cod' ? 'VD: GHN đối soát 25/10' : 'VD: CK Vietcombank'} maxLength={1000} /></label>
    </Sheet>
  )
}

/** Dự phòng khi trình duyệt chặn sao chép tự động: ô chữ sửa được + chọn hết để tự sao chép. */
function CopySheet({ text, onClose }: { text: string; onClose: () => void }) {
  const toast = useToast()
  const [v, setV] = useState(text)
  const copy = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.focus()
    el.select()
    const ok = () => { toast('Đã sao chép'); onClose() }
    try {
      if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(v).then(ok, () => toast('Đã chọn hết chữ - bấm giữ rồi chọn “Sao chép”')); return }
    } catch { /* rơi xuống cách cũ */ }
    try { if (document.execCommand('copy')) { ok(); return } } catch { /* bỏ qua */ }
    toast('Đã chọn hết chữ - bấm giữ rồi chọn “Sao chép”')
  }
  return (
    <Sheet title="Tin xác nhận đơn" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" onClick={() => copy(document.getElementById('o-copy') as HTMLTextAreaElement | null)}>Sao chép</button>}>
      <p className="hint" style={{ margin: 0 }}>Không tự sao chép được - sửa nếu cần (vd. dòng STK), rồi bấm “Sao chép” hoặc bấm giữ trong ô để chọn.</p>
      <textarea className="input o-copy" id="o-copy" value={v} onChange={(e) => setV(e.target.value)} aria-label="Nội dung tin xác nhận" />
    </Sheet>
  )
}

function InfoSheet({ onClose, onOk, busy, tracking, note, version }: {
  onClose: () => void; onOk: (tracking: string, note: string, version: number) => void; busy: boolean; tracking: string; note: string; version: number
}) {
  // Version lúc mở sheet: máy khác sửa trong lúc đang mở ⇒ báo xung đột thay vì ghi đè.
  const [ver] = useState(version)
  const [tk, setTk] = useState(tracking)
  const [nt, setNt] = useState(note)
  return (
    <Sheet title="Mã vận đơn / ghi chú" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={() => onOk(tk.trim(), nt.trim(), ver)}>Lưu</button>}>
      <label className="f" htmlFor="od-tracking">Mã vận đơn<input className="input" id="od-tracking" value={tk} onChange={(e) => setTk(e.target.value)} maxLength={100} /></label>
      <label className="f" htmlFor="od-note">Ghi chú<textarea className="input" id="od-note" value={nt} onChange={(e) => setNt(e.target.value)} maxLength={2000} /></label>
    </Sheet>
  )
}

/** CR-005 ý 12: QR VietQR (số tiền + nội dung = mã đơn) - lưu ảnh PNG / sao chép STK / sao chép tin kèm dòng chuyển khoản. */
function QrSheet({ onClose, cfg, amount, code, codPending, onOpenSettings, onCopyMsg }: {
  onClose: () => void; cfg: BankCfg | null; amount: number; code: string; codPending: number; onOpenSettings: () => void; onCopyMsg: () => void
}) {
  const toast = useToast()
  const content = qrContent(code)
  const caption = cfg ? [vnd(amount), `${bankName(cfg.bin)} · ${cfg.accountNo}`, `${cfg.accountName ? `${cfg.accountName} · ` : ''}ND: ${content}`] : []
  const { img, error } = useVietQr(cfg, amount, content, caption)
  if (!cfg) {
    return (
      <Sheet title="QR chuyển khoản" onClose={onClose}
        footer={<button className="btn btn-primary btn-block" id="qr-settings" onClick={onOpenSettings}>Mở Cài đặt</button>}>
        <p className="muted" style={{ margin: 0 }}>Chưa có tài khoản nhận tiền. Vào Cài đặt › “QR chuyển khoản (VietQR)” chọn ngân hàng, nhập số tài khoản và tên chủ tài khoản - sau đó mỗi đơn có mã QR đúng số tiền còn phải thu, nội dung là mã đơn.</p>
      </Sheet>
    )
  }
  const save = () => {
    if (img && downloadPng(img.dataUrl, `QR-${content || 'don'}.png`)) toast('Đã tải ảnh QR')
    else toast('Không tải được - bấm giữ vào mã QR rồi chọn “Lưu ảnh”')
  }
  const copyStk = () => {
    const done = () => toast(`Đã sao chép STK ${cfg.accountNo}`)
    const fail = () => toast('Không sao chép được - bấm giữ số tài khoản để chọn')
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cfg.accountNo).then(done, fail)
      else fail()
    } catch { fail() }
  }
  return (
    <Sheet title={`QR chuyển khoản · ${code}`} onClose={onClose}
      footer={<div className="o-qr-actions">
        <button className="btn btn-primary btn-block" id="qr-save" disabled={!img} onClick={save}>Lưu ảnh QR</button>
        <button className="btn btn-ghost btn-block" id="qr-copy-stk" onClick={copyStk}>Sao chép STK</button>
        <button className="btn btn-ghost btn-block" id="qr-copy-msg" onClick={onCopyMsg}>Sao chép tin xác nhận kèm dòng chuyển khoản</button>
      </div>}>
      <div className="o-qr">
        {img ? <QrImg src={img.dataUrl} label={`Mã QR chuyển ${vnd(amount)} tới ${bankName(cfg.bin)} ${cfg.accountNo}, nội dung ${content}`} />
          : <div className="warn-box"><span>{error}</span></div>}
        <div className="o-qr-amt">{vnd(amount)}</div>
        <dl className="o-qr-info">
          <dt>Ngân hàng</dt><dd>{bankName(cfg.bin)}</dd>
          <dt>Số TK</dt><dd className="num" style={{ userSelect: 'all' }}>{cfg.accountNo}</dd>
          {cfg.accountName && <><dt>Chủ TK</dt><dd>{cfg.accountName}</dd></>}
          <dt>Nội dung</dt><dd className="num">{content}</dd>
        </dl>
        <p className="hint" style={{ margin: 0 }}>
          Khách quét bằng app ngân hàng: điền sẵn số tiền và nội dung. Trên điện thoại có thể bấm giữ mã QR › “Lưu ảnh”.
          {codPending > 0 ? ` Đã trừ ${vnd(codPending)} COD shipper thu hộ.` : ''} Khi tiền về, bấm “Thu tiền” để ghi.
        </p>
      </div>
    </Sheet>
  )
}
