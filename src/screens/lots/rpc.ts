// Gọi RPC mà vẫn giữ mã lỗi + detail (JSON) của DB — useStore().rpc chỉ trả câu tiếng Việt, mà màn lô cần
// detail để báo cụ thể (LOT_HAS_RESERVED_UNITS → mã đơn, UNIT_RESERVED → mã chiếc). Thành công ⇒ tải lại dữ liệu.
import { useCallback } from 'react'
import { supabase } from '../../lib/supabase.ts'
import { useStore } from '../../data/store.tsx'
import { errorMessage } from '../../data/errors.ts'

export class RpcError extends Error {
  code: string | null
  detail: unknown
  constructor(message: string, code: string | null, detail: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** Đọc detail của exception (chuỗi JSON hoặc text) — không parse được ⇒ trả chuỗi gốc. */
function parseDetail(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try { return JSON.parse(raw) } catch { return raw }
}

export function useRpcDetail() {
  const { reload } = useStore()
  return useCallback(async <T,>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      const raw = String(error.message ?? '')
      const code = /^[A-Z_]+$/.test(raw.trim()) ? raw.trim() : null
      if (raw.includes('VERSION_CONFLICT')) await reload()
      throw new RpcError(errorMessage(error), code, parseDetail((error as { details?: unknown }).details))
    }
    await reload()
    return data as T
  }, [reload])
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
