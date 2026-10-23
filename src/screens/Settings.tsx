import { useEffect, useState } from 'react'
import { useData, useStore } from '../data/store.tsx'
import type { SettingsRow, ShipPayerDb } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { todayVn } from '../ui/format.ts'
import { CONFLICT_MSG, useDesk, writeError } from './overview/common.tsx'
import { readTheme, setTheme, type ThemeChoice } from './overview/theme.ts'
import { exportExcel } from './overview/exportData.ts'

/** main.tsx gọi trước khi render để áp giao diện Sáng / Tối đã chọn. */
export { applyStoredTheme } from './overview/theme.ts'

type SettingsPatch = Partial<Pick<SettingsRow, 'ai_scan_enabled' | 'ai_scan_monthly_cap' | 'ai_confidence_threshold' | 'default_ship_fee_payer'>>

// SC_15 Cài đặt: giao diện, AI quét tin, mặc định ship, xuất Excel, tài khoản.
export default function Settings() {
  const d = useData()
  const desk = useDesk()
  const { session, reload, signOut } = useStore()
  const toast = useToast()
  const st = d.settings
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme)
  const [cap, setCap] = useState(String(st?.ai_scan_monthly_cap ?? 100))
  const [conf, setConf] = useState(String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100)))
  const [errs, setErrs] = useState<{ cap?: string; conf?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [scans, setScans] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)

  // Nạp lại ô khi cài đặt đổi từ máy khác
  useEffect(() => {
    setCap(String(st?.ai_scan_monthly_cap ?? 100))
    setConf(String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100)))
  }, [st?.ai_scan_monthly_cap, st?.ai_confidence_threshold])

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

  function pickTheme(t: ThemeChoice) { setTheme(t); setThemeState(t) }

  function doExport() {
    setExporting(true)
    try { exportExcel(d); toast('Đã tạo file Excel') } catch { toast('Không tạo được file Excel — thử lại.') } finally { setExporting(false) }
  }

  const payer: ShipPayerDb = st?.default_ship_fee_payer ?? 'customer'
  const dirtyAi = cap !== String(st?.ai_scan_monthly_cap ?? 100) || conf !== String(Math.round((st?.ai_confidence_threshold ?? 0.7) * 100))

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
            <div className="main"><b>Lượt quét tháng này</b><div className="s">Gemini gói miễn phí — hết lượt thì nhập tay</div></div>
            <span className="v">{scans == null ? '—' : scans} / {st?.ai_scan_monthly_cap ?? 100} lượt</span>
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

        <p className="section-title">Đơn bán</p>
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
          <div className="li" style={{ cursor: 'default' }}><div className="main"><b>{session?.user.email ?? '—'}</b><div className="s">Dữ liệu đồng bộ giữa máy tính và điện thoại</div></div></div>
          <button className="li" id="sign-out" onClick={() => { void signOut() }}><div className="main"><b>Đăng xuất</b></div></button>
        </div>
      </div>
    </Shell>
  )
}
