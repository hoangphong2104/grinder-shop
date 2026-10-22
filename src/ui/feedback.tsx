// Toast + Sheet (hộp thoại trượt lên trên điện thoại, giữa màn trên máy tính).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

const ToastCtx = createContext<(msg: string) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const t = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => { setMsg(m); clearTimeout(t.current); t.current = window.setTimeout(() => setMsg(null), 2800) }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div id="toast" aria-live="polite">{msg && <div className="toast" role="status">{msg}</div>}</div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

export function Sheet({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Focus một lần lúc mở: ô nhập đầu tiên; sheet chỉ có nút (xác nhận) thì focus "Đóng" — tránh Enter nhầm vào nút nguy hiểm.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    addEventListener('keydown', k)
    const root = ref.current
    ;(root?.querySelector<HTMLElement>('input,select,textarea') ?? root?.querySelector<HTMLElement>('[data-sheet-close]'))?.focus()
    return () => removeEventListener('keydown', k)
  }, [])
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="grab" />
        <h2>{title}</h2>
        {children}
        {footer}
        <button className="btn btn-ghost btn-block" onClick={onClose} data-sheet-close>Đóng</button>
      </div>
    </div>
  )
}
