// Mã lỗi RPC (raise exception … message = 'CODE') → câu tiếng Việt cho người dùng.
const MSG: Record<string, string> = {
  NOT_AUTHENTICATED: 'Phiên đăng nhập đã hết. Đăng nhập lại.',
  VERSION_CONFLICT: 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.',
  EXCHANGE_RATE_REQUIRED: 'Nhập tỷ giá.',
  SHIP_FEE_REQUIRED: 'Nhập phí ship về VN của lô trước khi nhận hàng (BR-02).',
  LOT_HAS_NO_LINES: 'Lô cần ít nhất một dòng hàng.',
  LOT_NOT_FOUND: 'Không tìm thấy lô.',
  LOT_ALREADY_RECEIVED: 'Lô đã nhận vào kho.',
  LOT_NOT_RECEIVED: 'Lô chưa nhận vào kho.',
  LOT_CANCELLED: 'Lô đã huỷ.',
  LOT_LOCKED: 'Lô đã nhận chỉ sửa được phí ship và ghi chú (Q-014).',
  ORDER_NOT_FOUND: 'Không tìm thấy đơn.',
  ORDER_HAS_NO_LINES: 'Đơn cần ít nhất một dòng hàng.',
  ORDER_LOCKED: 'Đơn đã gửi — không sửa được hàng / giá.',
  ORDER_NOT_CONFIRMED: 'Chỉ đơn Đã chốt mới gửi hàng được (Q-007).',
  ORDER_NOT_PREORDER: 'Đơn không ở trạng thái Đặt trước.',
  ORDER_NOT_SHIPPED: 'Đơn chưa gửi hàng.',
  INSUFFICIENT_STOCK: 'Vượt số có thể bán (BR-07).',
  INSUFFICIENT_ON_HAND: 'Không đủ hàng có sẵn để gửi (BR-09).',
  RECEIVABLE_NOT_ZERO: 'Khách còn nợ / trả dư — xác nhận để hoàn tất (BR-10).',
  INVALID_AMOUNT: 'Số tiền không hợp lệ.',
  INVALID_INPUT: 'Dữ liệu nhập chưa hợp lệ.',
  INVALID_STATUS_FOR_SAVE: 'Trạng thái không cho phép thao tác này.',
  TOO_MANY_LINES: 'Quá nhiều dòng hàng.',
  VARIANT_NOT_FOUND: 'Không tìm thấy model / màu.',
  LEDGER_MISMATCH: 'Sổ kho lệch — liên hệ người làm app.',
  SCAN_CAP_REACHED: 'Đã hết lượt quét AI tháng này — nhập tay.',
  SCAN_DISABLED: 'AI quét đang tắt trong Cài đặt.',
  SCAN_NOT_FOUND: 'Không tìm thấy lượt quét.',
  AI_QUOTA_EXHAUSTED: 'Gemini đang hết lượt miễn phí — nhập tay hoặc thử lại sau.',
  AI_UPSTREAM_ERROR: 'Gemini đang lỗi hoặc quá chậm — nhập tay hoặc thử lại sau.',
  AI_UNREADABLE: 'AI không đọc được tin này — thử ảnh rõ hơn (thấy giá + tên người bán) hoặc nhập tay.',
  IMAGE_NOT_FOUND: 'Không tìm thấy ảnh đã tải lên — chọn lại ảnh.',
  PAYLOAD_TOO_LARGE: 'Ảnh hoặc đoạn chữ quá lớn (ảnh tối đa 5 MB).',
  FORBIDDEN: 'Tài khoản này không được dùng AI quét.',
}
export function errorMessage(e: unknown): string {
  const raw = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
  const code = Object.keys(MSG).find((k) => raw.includes(k))
  if (code) return MSG[code]
  if (raw.includes('23503') || /foreign key/i.test(raw)) return 'Mục này đã có lô hoặc đơn dùng tới — hãy Ẩn thay vì xoá (BR-14).'
  if (raw.includes('23505') || /duplicate key/i.test(raw)) return 'Tên này đã có — đặt tên khác.'
  if (/Failed to fetch|NetworkError|network/i.test(raw)) return 'Mất kết nối mạng — chưa lưu. Thử lại khi có mạng.'
  return raw || 'Có lỗi xảy ra.'
}
