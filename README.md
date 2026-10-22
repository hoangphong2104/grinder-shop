# Grinder Shop

Quản lý kho & bán cối xay cà phê 1Zpresso: lô nhập Goofish (AI đọc ảnh tin bằng Gemini), tồn kho theo model · màu, giá vốn bình quân, đơn bán Facebook (cọc, đặt trước, gửi hàng), công nợ trung gian, báo cáo lãi. Dùng trên máy tính và điện thoại, dữ liệu đồng bộ tức thì (Supabase Realtime).

- App: https://hoangphong2104.github.io/grinder-shop/
- Stack: React + Vite + TypeScript (PWA) · Supabase (Postgres + RLS + RPC, Auth, Storage, Realtime, Edge Function `scan-goofish` → Gemini API)
- Database: `supabase/migrations/` (chạy `supabase/setup-all.sql` trong SQL Editor)
- Lõi tính tiền: `src/domain/` (`npm test`)

```bash
npm ci
npm run dev
```
