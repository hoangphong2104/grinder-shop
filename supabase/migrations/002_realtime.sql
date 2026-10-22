-- Q-017 (Chủ dự án 2026-10-22: "lưu real time"): bật Supabase Realtime cho các bảng nghiệp vụ.
-- Realtime (postgres_changes) tôn trọng RLS + quyền SELECT của role authenticated → chỉ nhận thay đổi dữ liệu của chính mình.
-- App nhận sự kiện → tải lại dữ liệu (debounce) → máy kia cập nhật ngay.
alter publication supabase_realtime add table
  public.models, public.variants, public.sellers, public.lots, public.lot_lines,
  public.intermediary_txns, public.customers, public.orders, public.order_lines,
  public.payments, public.settings;
