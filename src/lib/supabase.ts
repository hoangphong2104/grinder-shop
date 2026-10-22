import { createClient } from '@supabase/supabase-js'

// Khoá công khai (publishable) — an toàn trong code web; dữ liệu được bảo vệ bằng đăng nhập + RLS (System Design §2).
const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
if (!url || !key) throw new Error('Thiếu VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY trong .env')

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})
