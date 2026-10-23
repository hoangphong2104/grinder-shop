import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase.ts'
import { Brandmark } from '../ui/icons.tsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pass })
    setBusy(false)
    if (error) setErr(/invalid/i.test(error.message) ? 'Sai email hoặc mật khẩu.' : /fetch|network/i.test(error.message) ? 'Không có mạng.' : error.message)
  }
  return (
    <form className="login" onSubmit={submit}>
      <div className="logo"><Brandmark />Grinder Shop</div>
      <p className="muted small" style={{ margin: 0 }}>Đăng nhập để dùng trên máy tính và điện thoại - dữ liệu đồng bộ tức thì.</p>
      <label className="f">Email<input className="input" id="lg-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label className="f">Mật khẩu<input className="input" id="lg-pass" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required /></label>
      {err && <div className="err-text" role="alert">{err}</div>}
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
    </form>
  )
}
