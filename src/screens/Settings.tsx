import { useEffect, useState } from 'react'
import { useData, useStore } from '../data/store.tsx'
import type { SettingsRow, ShipPayerDb } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { parseNum, pct, todayVn } from '../ui/format.ts'
import { isBuyingFeePct } from '../domain/index.ts'
import { CONFLICT_MSG, useDesk, writeError } from './overview/common.tsx'
import { readTheme, setTheme, type ThemeChoice } from './overview/theme.ts'
import { exportExcel } from './overview/exportData.ts'
import { accountNameNorm, BANKS, QrImg, useVietQr } from './orders/vietqr.tsx'
import { checkVietQr } from '../domain/vietqr.ts'
import { vnd } from '../ui/format.ts'
import '../styles/orders.css'

/** main.tsx gọi trước khi render để áp giao diện Sáng / Tối đã chọn. */
export { applyStoredTheme } from './overview/theme.ts'

type SettingsPatch = Partial<Pick<SettingsRow, 'ai_scan_enabled' | 'ai_scan_monthly_cap' | 'ai_confidence_threshold' | 'default_ship_fee_payer' | 'default_buying_fee_pct' | 'aging_warn_days' | 'aging_alert_days' | 'lot_late_days' | 'bank_info' | 'bank_bin' | 'bank_account_no' | 'bank_account_name'>>
/** Số tiền mẫu cho xem trước QR trong Cài đặt. */
const QR_SAMPLE_VND = 100000

/** Số % → chữ trong ô nhập kiểu VN: 2.5 → "2,5". */
const pctStr = (n: number | null | undefined) => String(Number(n ?? 0)).replace('.', ',')

// SC_15 Cài đặt: giao diện, AI quét tin, phí mua hộ mặc định (CR-003), mặc định ship, xuất Excel, tài khoản.
// CR-005 ý 12: tài khoản nhận tiền VietQR (bank_bin / bank_account_no / bank_account_name) + xem trước mã QR.
// CR-004: ngưỡng tuổi tồn (cam / đỏ) + lô về trễ (HOME-S1, KHO-S1, LOT-S2); STK in trong tin xác nhận đơn (DON-S2).
export default function Settings() {
  const d = useData()
  const desk = useDesk()
  const { session, reload, signOut } = useStore()
  const toast = useToast()
  const st = d.settings
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme)
  const [cap, setCap] = useState(String(st?.ai_scan_monthly_cap ?? 100))
  const [conf, setConf] = useState(String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100)))
  const [fee, setFee] = useState(pctStr(st?.default_buying_fee_pct))
  const [warn, setWarn] = useState(String(st?.aging_warn_days ?? 30))
  const [alert, setAlert] = useState(String(st?.aging_alert_days ?? 60))
  const [late, setLate] = useState(String(st?.lot_late_days ?? 21))
  const [bank, setBank] = useState(st?.bank_info ?? '')
  // VietQR: chọn ngân hàng trong danh sách hoặc "Khác" (nhập BIN 6 số)
  const knownBin = (b: string | null | undefined) => !!b && BANKS.some((x) => x.bin === b)
  const [qBank, setQBank] = useState(st?.bank_bin ? (knownBin(st.bank_bin) ? st.bank_bin : 'other') : '')
  const [qBin, setQBin] = useState(st?.bank_bin ?? '')
  const [qNo, setQNo] = useState(st?.bank_account_no ?? '')
  const [qName, setQName] = useState(st?.bank_account_name ?? '')
  const [errs, setErrs] = useState<{ cap?: string; conf?: string; fee?: string; warn?: string; alert?: string; late?: string; bank?: string; qBin?: string; qNo?: string; qName?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [scans, setScans] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  // Nạp lại ô khi cài đặt đổi từ máy khác
  useEffect(() => {
    setCap(String(st?.ai_scan_monthly_cap ?? 100))
    setConf(String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100)))
  }, [st?.ai_scan_monthly_cap, st?.ai_confidence_threshold])
  useEffect(() => { setFee(pctStr(st?.default_buying_fee_pct)) }, [st?.default_buying_fee_pct])
  useEffect(() => {
    setWarn(String(st?.aging_warn_days ?? 30)); setAlert(String(st?.aging_alert_days ?? 60)); setLate(String(st?.lot_late_days ?? 21))
  }, [st?.aging_warn_days, st?.aging_alert_days, st?.lot_late_days])
  useEffect(() => { setBank(st?.bank_info ?? '') }, [st?.bank_info])
  useEffect(() => {
    setQBank(st?.bank_bin ? (BANKS.some((x) => x.bin === st.bank_bin) ? st.bank_bin : 'other') : '')
    setQBin(st?.bank_bin ?? ''); setQNo(st?.bank_account_no ?? ''); setQName(st?.bank_account_name ?? '')
  }, [st?.bank_bin, st?.bank_account_no, st?.bank_account_name])

  // Lượt quét tháng này (cùng cách đếm với ai_scan_reserve: lỗi trước khi gọi AI không tính)
  useEffect(() => {
    let alive = true
    const start = `${todayVn().slice(0, 7)}-01T00:00:00+07:00`
    supabase.from('ai_scan_log').select('status,input_tokens').gte('created_at', start).then(({ data, error }) => {
      if (!alive) return
      if (error || !data) { setScans(null); return }
      setScans(data.filter((r) => !(r.status === 'error' && (r.input_tokens ?? 0) === 0)).length)
    })
    return () => { alive = false }
  }, [st?.version])

  async function save(patch: SettingsPatch, okMsg: string) {
    setBusy(true); setErrs({})
    try {
      if (st) {
        const { data, error } = await supabase.from('settings').update(patch).eq('user_id', st.user_id).eq('version', st.version).select('user_id')
        if (error) throw new Error(writeError(error))
        if (!data?.length) throw new Error(CONFLICT_MSG)
      } else {
        const { error } = await supabase.from('settings').insert(patch)
        if (error) throw new Error(writeError(error))
      }
      await reload()
      toast(okMsg)
    } catch (e) {
      setErrs({ form: (e as Error).message })
      await reload()
    } finally { setBusy(false) }
  }

  function saveAi() {
    const c = Number(cap.trim()), p = Number(conf.trim().replace(',', '.'))
    const e: typeof errs = {}
    if (!cap.trim() || !Number.isInteger(c) || c < 0 || c > 1000) e.cap = 'Nhập số nguyên từ 0 đến 1000.'
    if (!conf.trim() || !Number.isFinite(p) || p < 0 || p > 100) e.conf = 'Nhập phần trăm từ 0 đến 100.'
    setErrs(e)
    if (e.cap || e.conf) return
    save({ ai_scan_monthly_cap: c, ai_confidence_threshold: Math.round(p) / 100 }, 'Đã lưu cài đặt AI')
  }

  /** CR-003: phí mua hộ mặc định cho lô mới - 0..100 %, cho phép thập phân (2,5). Lô cũ không đổi. */
  function saveFee() {
    const v = fee.trim() ? parseNum(fee) : 0
    if (v == null || !isBuyingFeePct(v)) {
      setErrs({ fee: 'Nhập số % từ 0 đến 100 (vd. 3 hoặc 2,5), tối đa 2 chữ số thập phân.' })
      return
    }
    save({ default_buying_fee_pct: Math.round(v * 100) / 100 }, `Phí mua hộ mặc định: ${pct(v)}`)
  }

  /** Ngưỡng ngày: số nguyên 1..3650, cam < đỏ (ràng buộc DB settings_aging_days_order). */
  function saveDays() {
    const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)
    const w = int(warn), a = int(alert), l = int(late)
    const e: typeof errs = {}
    const bad = (n: number) => !Number.isInteger(n) || n < 1 || n > 3650
    if (bad(w)) e.warn = 'Nhập số ngày nguyên từ 1 đến 3650.'
    if (bad(a)) e.alert = 'Nhập số ngày nguyên từ 1 đến 3650.'
    else if (!e.warn && a <= w) e.alert = `Ngưỡng đỏ phải lớn hơn ngưỡng cam (${w} ngày).`
    if (bad(l)) e.late = 'Nhập số ngày nguyên từ 1 đến 3650.'
    setErrs(e)
    if (e.warn || e.alert || e.late) return
    save({ aging_warn_days: w, aging_alert_days: a, lot_late_days: l }, 'Đã lưu ngưỡng ngày')
  }

  function saveBank() {
    const v = bank.trim()
    if (v.length > 500) { setErrs({ bank: 'Tối đa 500 ký tự.' }); return }
    save({ bank_info: v || null }, v ? 'Đã lưu số tài khoản' : 'Đã xoá số tài khoản')
  }

  // VietQR: BIN đang chọn (danh sách / tự nhập), số TK bỏ khoảng trắng, tên HOA không dấu
  const curBin = qBank === 'other' ? qBin.trim() : qBank
  const curNo = qNo.replace(/\s/g, '')
  const curName = accountNameNorm(qName).trim()
  function saveQr() {
    const e: typeof errs = {}
    const empty = !qBank && !curNo && !curName
    if (!empty) {
      if (!/^[0-9]{6}$/.test(curBin)) e.qBin = qBank === 'other' ? 'Mã BIN gồm đúng 6 số (vd. 970436).' : 'Chọn ngân hàng.'
      if (!/^[0-9A-Za-z]{1,19}$/.test(curNo)) e.qNo = 'Số tài khoản chỉ gồm chữ / số, tối đa 19 ký tự.'
      if (!curName || curName.length > 50) e.qName = 'Nhập tên chủ tài khoản (chữ HOA không dấu, tối đa 50 ký tự) như trên app ngân hàng.'
    }
    setErrs(e)
    if (e.qBin || e.qNo || e.qName) return
    save(empty ? { bank_bin: null, bank_account_no: null, bank_account_name: null } : { bank_bin: curBin, bank_account_no: curNo, bank_account_name: curName },
      empty ? 'Đã xoá tài khoản VietQR' : 'Đã lưu tài khoản VietQR')
  }
  const qrOk = !checkVietQr({ bin: curBin, accountNo: curNo })
  const qrPreview = useVietQr(qrOk ? { bin: curBin, accountNo: curNo, accountName: curName } : null, QR_SAMPLE_VND, 'D-001', [])
  const dirtyQr = curBin !== (st?.bank_bin ?? '') || curNo !== (st?.bank_account_no ?? '') || curName !== (st?.bank_account_name ?? '')

  function pickTheme(t: ThemeChoice) { setTheme(t); setThemeState(t) }

  function doExport() {
    setExporting(true)
    try { exportExcel(d); toast('Đã tạo file Excel') } catch { toast('Không tạo được file Excel - thử lại.') } finally { setExporting(false) }
  }

  const payer: ShipPayerDb = st?.default_ship_fee_payer ?? 'customer'
  const dirtyAi = cap !== String(st?.ai_scan_monthly_cap ?? 100) || conf !== String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100))
  const dirtyFee = fee.trim() !== pctStr(st?.default_buying_fee_pct)
  const dirtyDays = warn !== String(st?.aging_warn_days ?? 30) || alert !== String(st?.aging_alert_days ?? 60) || late !== String(st?.lot_late_days ?? 21)
  const dirtyBank = bank.trim() !== (st?.bank_info ?? '').trim()

  return (
    <Shell section="caidat" title="Cài đặt" back={desk ? undefined : '/them'}>
      <div className="stack" style={{ maxWidth: 640 }}>
        <p className="section-title">Giao diện</p>
        <div className="seg" role="group" aria-label="Giao diện" style={{ justifyContent: 'flex-start', alignSelf: 'flex-start' }}>
          {([['auto', 'Theo máy'], ['light', 'Sáng'], ['dark', 'Tối']] as const).map(([k, t]) => (
            <button key={k} id={`theme-${k}`} aria-pressed={theme === k} onClick={() => pickTheme(k)}>{t}</button>
          ))}
        </div>

        <p className="section-title">AI đọc tin Goofish</p>
        <div className="list">
          <div className="li" style={{ cursor: 'default' }}>
            <div className="main"><b>Dùng AI điền sẵn form lô</b><div className="s">Tắt thì chỉ nhập tay</div></div>
            <input type="checkbox" className="switch" id="ai-enabled" aria-label="Dùng AI điền sẵn form lô" checked={st?.ai_scan_enabled ?? true} disabled={busy}
              onChange={(e) => save({ ai_scan_enabled: e.target.checked }, e.target.checked ? 'Đã bật AI quét tin' : 'Đã tắt AI quét tin')} />
          </div>
          <div className="li" style={{ cursor: 'default' }}>
            <div className="main"><b>Lượt quét tháng này</b><div className="s">Gemini gói miễn phí - hết lượt thì nhập tay</div></div>
            <span className="v">{scans == null ? '-' : scans} / {st?.ai_scan_monthly_cap ?? 100} lượt</span>
          </div>
        </div>
        <div className="two">
          <label className="f">Giới hạn lượt / tháng
            <input className={`input money ${errs.cap ? 'invalid' : ''}`} id="ai-cap" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
            {errs.cap && <span className="field-err">{errs.cap}</span>}
          </label>
          <label className="f">Ngưỡng tin cậy (%)
            <input className={`input money ${errs.conf ? 'invalid' : ''}`} id="ai-conf" inputMode="numeric" value={conf} onChange={(e) => setConf(e.target.value)} />
            {errs.conf && <span className="field-err">{errs.conf}</span>}
          </label>
        </div>
        <p className="hint">Trường AI đọc có độ tin cậy dưới ngưỡng sẽ để trống và đánh dấu “kiểm tra” (BR-13).</p>
        <button className="btn btn-ghost" id="ai-save" style={{ alignSelf: 'flex-start' }} disabled={busy || !dirtyAi} onClick={saveAi}>Lưu cài đặt AI</button>

        <p className="section-title">Lô nhập</p>
        <label className="f" style={{ maxWidth: 300 }}>Phí mua hộ mặc định %
          <input className={`input money ${errs.fee ? 'invalid' : ''}`} id="fee-default" inputMode="decimal" value={fee} placeholder="0"
            onChange={(e) => setFee(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirtyFee) saveFee() }} />
          {errs.fee && <span className="field-err">{errs.fee}</span>}
        </label>
        <p className="hint">% trên tiền hàng (giá ¥ × tỷ giá), điền sẵn khi tạo lô mới và sửa được trên từng lô; cộng vào giá nhập ₫ từng chiếc và phải trả trung gian. Đổi ở đây không làm đổi lô đã có.</p>
        <button className="btn btn-ghost" id="fee-save" style={{ alignSelf: 'flex-start' }} disabled={busy || !dirtyFee} onClick={saveFee}>Lưu phí mua hộ mặc định</button>

        <p className="section-title">Ngưỡng ngày (tồn lâu, lô về trễ)</p>
        <div className="two ov-two">
          <label className="f">Tồn lâu - cam sau (ngày)
            <input className={`input money ${errs.warn ? 'invalid' : ''}`} id="age-warn" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} />
            {errs.warn && <span className="field-err">{errs.warn}</span>}
          </label>
          <label className="f">Tồn lâu - đỏ sau (ngày)
            <input className={`input money ${errs.alert ? 'invalid' : ''}`} id="age-alert" inputMode="numeric" value={alert} onChange={(e) => setAlert(e.target.value)} />
            {errs.alert && <span className="field-err">{errs.alert}</span>}
          </label>
        </div>
        <label className="f" style={{ maxWidth: 300 }}>Lô về trễ khi đặt quá (ngày)
          <input className={`input money ${errs.late ? 'invalid' : ''}`} id="lot-late" inputMode="numeric" value={late} onChange={(e) => setLate(e.target.value)} />
          {errs.late && <span className="field-err">{errs.late}</span>}
        </label>
        <p className="hint">Số ngày tồn trong Kho đổi màu cam / đỏ theo ngưỡng; Tổng quan nhắc chiếc tồn quá ngưỡng đỏ và lô đặt quá số ngày trên mà chưa nhận.</p>
        <button className="btn btn-ghost" id="days-save" style={{ alignSelf: 'flex-start' }} disabled={busy || !dirtyDays} onClick={saveDays}>Lưu ngưỡng ngày</button>

        <p className="section-title">QR chuyển khoản (VietQR)</p>
        <p className="hint" style={{ marginTop: 0 }}>Tài khoản nhận tiền của shop. Chi tiết đơn có nút “QR” tạo mã đúng số tiền còn phải thu, nội dung là mã đơn - khách quét bằng app ngân hàng.</p>
        <div className="two ov-two">
          <label className="f">Ngân hàng
            <select className={`input ${errs.qBin ? 'invalid' : ''}`} id="qr-bank" value={qBank} onChange={(e) => setQBank(e.target.value)}>
              <option value="">Chọn ngân hàng…</option>
              {BANKS.map((b) => <option key={b.bin} value={b.bin}>{b.name}</option>)}
              <option value="other">Khác (nhập mã BIN)</option>
            </select>
            {qBank !== 'other' && errs.qBin && <span className="field-err">{errs.qBin}</span>}
          </label>
          {qBank === 'other' && (
            <label className="f">Mã BIN ngân hàng (6 số)
              <input className={`input money ${errs.qBin ? 'invalid' : ''}`} id="qr-bin" inputMode="numeric" maxLength={6} value={qBin} placeholder="970436" onChange={(e) => setQBin(e.target.value.replace(/\D/g, ''))} />
              {errs.qBin && <span className="field-err">{errs.qBin}</span>}
            </label>
          )}
        </div>
        <div className="two ov-two">
          <label className="f">Số tài khoản
            <input className={`input money ${errs.qNo ? 'invalid' : ''}`} id="qr-account-no" inputMode="numeric" autoComplete="off" maxLength={24} value={qNo} placeholder="0123456789" onChange={(e) => setQNo(e.target.value)} />
            {errs.qNo && <span className="field-err">{errs.qNo}</span>}
          </label>
          <label className="f">Tên chủ tài khoản
            <input className={`input ${errs.qName ? 'invalid' : ''}`} id="qr-account-name" autoComplete="off" autoCapitalize="characters" maxLength={50} value={qName} placeholder="NGUYEN VAN A"
              onChange={(e) => setQName(accountNameNorm(e.target.value))} />
            {errs.qName && <span className="field-err">{errs.qName}</span>}
          </label>
        </div>
        <div className="set-qr">
          {qrPreview.img
            ? <QrImg src={qrPreview.img.dataUrl} label="Mã QR xem trước" />
            : <div className="note-box" style={{ flex: 1 }}><span>Chọn ngân hàng và nhập số tài khoản để xem trước mã QR.</span></div>}
          {qrPreview.img && <p className="hint" style={{ margin: 0, flex: 1, minWidth: 160 }}>Mã mẫu {vnd(QR_SAMPLE_VND)}, nội dung “D-001”. Thử quét bằng app ngân hàng: phải hiện đúng ngân hàng, số TK và tên chủ tài khoản trước khi lưu.</p>}
        </div>
        <button className="btn btn-ghost" id="qr-save-settings" style={{ alignSelf: 'flex-start' }} disabled={busy || !dirtyQr} onClick={saveQr}>Lưu tài khoản VietQR</button>

        <p className="section-title">Đơn bán</p>
        <label className="f">Dòng STK in trong tin xác nhận đơn (khi không dùng dòng VietQR)
          <textarea className={`input ${errs.bank ? 'invalid' : ''}`} id="bank-info" rows={3} maxLength={500} value={bank}
            placeholder="VD: STK 0123456789 · Vietcombank · NGUYEN VAN A" onChange={(e) => setBank(e.target.value)} />
          {errs.bank && <span className="field-err">{errs.bank}</span>}
        </label>
        <button className="btn btn-ghost" id="bank-save" style={{ alignSelf: 'flex-start' }} disabled={busy || !dirtyBank} onClick={saveBank}>Lưu số tài khoản</button>
        <div className="li list" style={{ cursor: 'default', flexWrap: 'wrap' }}>
          <div className="main"><b>Phí ship giao khách mặc định</b><div className="s">Áp khi tạo đơn mới; sửa được trên từng đơn</div></div>
          <div className="seg" role="group" aria-label="Phí ship mặc định">
            <button id="payer-customer" aria-pressed={payer === 'customer'} disabled={busy} onClick={() => payer !== 'customer' && save({ default_ship_fee_payer: 'customer' }, 'Mặc định: khách trả ship')}>Khách trả</button>
            <button id="payer-shop" aria-pressed={payer === 'shop'} disabled={busy} onClick={() => payer !== 'shop' && save({ default_ship_fee_payer: 'shop' }, 'Mặc định: shop chịu ship')}>Shop chịu</button>
          </div>
        </div>
        {errs.form && <p className="err-text">{errs.form}</p>}

        <p className="section-title">Dữ liệu</p>
        <div className="list">
          <button className="li" id="export-xlsx" onClick={doExport} disabled={exporting}>
            <div className="main"><b>Xuất Excel</b><div className="s">Lô nhập, từng chiếc cối, đơn bán, dòng đơn, thu tiền, tồn theo model, công nợ trung gian, ghi chú (.xlsx)</div></div>
            <Icon name="chev" size={16} />
          </button>
        </div>
        <p className="hint">Mọi thao tác đã lưu ngay lên máy chủ; xuất Excel chỉ để xem / lưu riêng khi cần (Q-018).</p>

        <p className="section-title">Tài khoản</p>
        <div className="list">
          <div className="li" style={{ cursor: 'default' }}><div className="main"><b>{session?.user.email ?? '-'}</b><div className="s">Dữ liệu đồng bộ giữa máy tính và điện thoại</div></div></div>
          <button className="li" id="sign-out" onClick={() => { void signOut() }}><div className="main"><b>Đăng xuất</b></div></button>
        </div>
      </div>
    </Shell>
  )
}
