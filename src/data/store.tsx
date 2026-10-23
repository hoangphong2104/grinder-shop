// Kho dữ liệu dùng chung: tải toàn bộ dữ liệu của người dùng (1 người, dữ liệu nhỏ), nghe Supabase Realtime
// để máy kia cập nhật ngay (Q-017), và bọc các RPC (mọi thay đổi tiền / kho đi qua RPC - System Design §5).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase.ts'
import { errorMessage } from './errors.ts'
import type { DbData } from './types.ts'
import { buildDemoData, demoSession } from './demo.ts'

// Chế độ xem thử (CHỈ khi dev): URL có `?demo` ⇒ dữ liệu mẫu, không đăng nhập, không gọi Supabase.
// `import.meta.env.DEV` = false khi build ⇒ DEMO là hằng false, Vite/Rollup loại bỏ cả nhánh demo lẫn file demo.ts.
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has('demo')

const EMPTY_BAL = { total_payable_vnd: 0, total_transferred_vnd: 0, total_adjustment_vnd: 0, balance_vnd: 0 }

async function fetchAll(): Promise<DbData> {
  const q = <T,>(p: PromiseLike<{ data: T | null; error: unknown }>) =>
    Promise.resolve(p).then(({ data, error }) => { if (error) throw error; return data as T })
  const [models, units, sellers, lots, txns, customers, orders, orderLines, payments, settings, unitView, modelStock, lotSummary, orderSummary, balance, suggestions, notes] =
    await Promise.all([
      q(supabase.from('models').select('*').order('sort_order').order('created_at')),
      q(supabase.from('units').select('*').order('code')),
      q(supabase.from('sellers').select('*').order('created_at')),
      q(supabase.from('lots').select('*').order('created_at')),
      q(supabase.from('intermediary_txns').select('*').order('txn_date').order('created_at')),
      q(supabase.from('customers').select('*').order('created_at')),
      q(supabase.from('orders').select('*').order('created_at')),
      q(supabase.from('order_lines').select('*').order('line_no')),
      q(supabase.from('payments').select('*').order('paid_at').order('created_at')),
      q(supabase.from('settings').select('*').maybeSingle()),
      q(supabase.from('v_units').select('*').order('code')),
      q(supabase.from('v_model_stock').select('*').order('sort_order')),
      q(supabase.from('v_lot_summary').select('*')),
      q(supabase.from('v_order_summary').select('*')),
      q(supabase.from('v_intermediary_balance').select('*').maybeSingle()),
      q(supabase.from('v_suggestions').select('*').maybeSingle()),
      q(supabase.from('notes').select('*')),
    ])
  const code = (rows: { id: string }[], p: string) => Object.fromEntries(rows.map((r, i) => [r.id, `${p}-${String(i + 1).padStart(3, '0')}`]))
  return {
    models, units, sellers, lots, txns, customers, orders, orderLines, payments, settings, unitView, modelStock, lotSummary, orderSummary, notes,
    balance: balance ?? EMPTY_BAL,
    suggestions: suggestions ?? { last_exchange_rate: null, last_ship_fee_per_unit_vnd: null, last_buying_fee_pct: null },
    lotCode: code(lots, 'L'), orderCode: code(orders, 'D'),
  } as DbData
}

interface Store {
  session: Session | null
  data: DbData | null
  loading: boolean
  error: string | null
  online: boolean
  reload: () => Promise<void>
  /** Gọi RPC; lỗi → ném Error với câu tiếng Việt; thành công → tải lại dữ liệu. */
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>
  signOut: () => Promise<void>
}
const Ctx = createContext<Store | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => (DEMO ? demoSession() : null))
  const [authReady, setAuthReady] = useState(DEMO)
  const [data, setData] = useState<DbData | null>(() => (DEMO ? buildDemoData() : null))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    // Demo: giữ phiên giả, không nghe đăng nhập Supabase
    const sub = DEMO ? null : supabase.auth.onAuthStateChange((_e, s) => setSession(s)).data
    if (!DEMO) supabase.auth.getSession().then(({ data: d }) => { setSession(d.session); setAuthReady(true) })
    const on = () => setOnline(true), off = () => setOnline(false)
    addEventListener('online', on); addEventListener('offline', off)
    return () => { sub?.subscription.unsubscribe(); removeEventListener('online', on); removeEventListener('offline', off) }
  }, [])

  const reload = useCallback(async () => {
    if (DEMO) return // demo: dữ liệu cố định
    try { setData(await fetchAll()); setError(null) } catch (e) { setError(errorMessage(e)) }
  }, [])

  // Đăng nhập xong: khởi tạo (settings + 3 model mặc định) → tải → nghe realtime.
  useEffect(() => {
    if (DEMO) return // demo: không bootstrap, không mở kênh realtime
    if (!session) { setData(null); return }
    let alive = true
    setLoading(true)
    ;(async () => {
      const { error: e } = await supabase.rpc('bootstrap_user')
      if (e) setError(errorMessage(e))
      await reload()
      if (alive) setLoading(false)
    })()
    const debounced = () => { clearTimeout(timer.current); timer.current = window.setTimeout(reload, 250) }
    const ch = supabase.channel('db-changes').on('postgres_changes', { event: '*', schema: 'public' }, debounced).subscribe()
    const vis = () => { if (document.visibilityState === 'visible') debounced() }
    document.addEventListener('visibilitychange', vis)
    return () => { alive = false; supabase.removeChannel(ch); document.removeEventListener('visibilitychange', vis) }
  }, [session, reload])

  const rpc = useCallback(async <T,>(fn: string, args?: Record<string, unknown>) => {
    if (DEMO) throw new Error('Chế độ xem thử: không lưu được')
    const { data: res, error: e } = await supabase.rpc(fn, args)
    if (e) {
      if (String(e.message).includes('VERSION_CONFLICT')) await reload()
      throw new Error(errorMessage(e))
    }
    await reload()
    return res as T
  }, [reload])

  const signOut = useCallback(async () => {
    if (DEMO) { location.href = location.pathname; return } // demo: thoát về màn đăng nhập thường
    await supabase.auth.signOut(); setData(null)
  }, [])

  const value = useMemo(() => ({ session, data, loading: !authReady || loading, error, online, reload, rpc, signOut }),
    [session, data, authReady, loading, error, online, reload, rpc, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore ngoài DataProvider')
  return s
}
/** Dùng trong màn hình đã đăng nhập (App chỉ render màn khi data đã có). */
export function useData(): DbData {
  const { data } = useStore()
  if (!data) throw new Error('Chưa có dữ liệu')
  return data
}
