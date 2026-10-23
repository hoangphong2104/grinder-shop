// Mã lỗi RPC (raise exception … message = 'CODE') → câu tiếng Việt cho người dùng.
const MSG: Record<string, string> = {
  NOT_AUTHENTICATED: 'Phiên đăng nhập đã hết. Đăng nhập lại.',
  VERSION_CONFLICT: 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.',
  EXCHANGE_RATE_REQUIRED: 'Nhập tỷ giá.',
  SHIP_FEE_REQUIRED: 'Nhập phí ship về VN của lô trước khi nhận hàng (BR-02).',
  LOT_HAS_NO_LINES: 'Lô cần ít nhất một chiếc cối.',
  LOT_NOT_FOUND: 'Không tìm thấy lô.',
  LOT_ALREADY_RECEIVED: 'Lô đã nhận vào kho.',
  LOT_NOT_RECEIVED: 'Lô chưa nhận vào kho.',
  LOT_CANCELLED: 'Lô đã huỷ.',
  LOT_LOCKED: 'Lô đã nhận: không thêm / bớt chiếc, không đổi giá ¥ / tỷ giá. Sửa phí ship ở trang lô; giá nhập ₫ sửa tay, giá bán, seri sửa ở từng chiếc.',
  ORDER_NOT_FOUND: 'Không tìm thấy đơn.',
  ORDER_HAS_NO_LINES: 'Đơn cần ít nhất một chiếc cối.',
  ORDER_LOCKED: 'Đơn đã gửi — không sửa được hàng / giá.',
  ORDER_NOT_CONFIRMED: 'Chỉ đơn Đã chốt mới gửi hàng được (Q-007).',
  ORDER_NOT_PREORDER: 'Đơn không ở trạng thái Đặt trước.',
  ORDER_NOT_SHIPPED: 'Đơn chưa gửi hàng.',
  RECEIVABLE_NOT_ZERO: 'Khách còn nợ / trả dư — xác nhận để hoàn tất (BR-10).',
  INVALID_AMOUNT: 'Số tiền không hợp lệ.',
  INVALID_INPUT: 'Dữ liệu nhập chưa hợp lệ.',
  INVALID_STATUS_FOR_SAVE: 'Trạng thái không cho phép thao tác này.',
  TOO_MANY_LINES: 'Quá nhiều chiếc trong một đơn (tối đa 50).',
  MODEL_NOT_FOUND: 'Không tìm thấy model.',
  UNIT_NOT_FOUND: 'Không tìm thấy chiếc cối.',
  UNIT_NOT_AVAILABLE: 'Chiếc cối này đã bán, đã được giữ cho đơn khác hoặc thuộc lô đã huỷ.',
  UNIT_RESERVED: 'Chiếc cối đang được giữ cho một đơn — huỷ / sửa đơn đó trước.',
  UNIT_NOT_RECEIVED: 'Có chiếc chưa về kho — chưa chốt / gửi được.',
  UNIT_PRICE_REQUIRED: 'Nhập giá bán cho từng chiếc.',
  DUPLICATE_UNIT: 'Một chiếc chỉ được chọn một lần trong đơn.',
  LOT_HAS_RESERVED_UNITS: 'Lô có chiếc đang được giữ cho đơn — huỷ các đơn đó trước khi huỷ lô.',
  INVALID_QTY: 'Số lượng phải từ 1 đến 1000.',
  TOO_MANY_UNITS: 'Lô quá nhiều chiếc (tối đa 1000).',
  SELLER_NOT_FOUND: 'Không tìm thấy người bán.',
  CUSTOMER_REQUIRED: 'Chọn khách hoặc nhập khách mới.',
  CUSTOMER_NOT_FOUND: 'Không tìm thấy khách.',
  DEPOSIT_ONLY_ON_CREATE: 'Tiền cọc chỉ nhập lúc tạo đơn — sửa đơn thì ghi ở "Ghi thu tiền".',
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
  if (code) return MSG[code] + detailSuffix(e)
  if (raw.includes('23503') || /foreign key/i.test(raw)) return 'Mục này đã có chiếc cối, lô hoặc đơn dùng tới — hãy Ẩn thay vì xoá (BR-14).'
  if (raw.includes('models_user_prefix_uq')) return 'Tiền tố mã này đã dùng cho model khác — chọn tiền tố khác.'
  if (raw.includes('23505') || /duplicate key/i.test(raw)) return 'Tên này đã có — đặt tên khác.'
  if (/Failed to fetch|NetworkError|network/i.test(raw)) return 'Mất kết nối mạng — chưa lưu. Thử lại khi có mạng.'
  return raw || 'Có lỗi xảy ra.'
}

/** RPC v2 gửi chi tiết JSON trong `details` (vd. {"code":"KU-007"} hoặc {"unit_codes":[…],"order_ids":[…]}) → thêm mã chiếc vào câu báo. */
function detailSuffix(e: unknown): string {
  const d = e && typeof e === 'object' && 'details' in e ? (e as { details: unknown }).details : null
  if (typeof d !== 'string' || !d.trim().startsWith('{')) return ''
  try {
    const j = JSON.parse(d) as { code?: string; unit_codes?: string[] }
    const codes = j.unit_codes?.length ? j.unit_codes : j.code ? [j.code] : []
    return codes.length ? ` (${codes.join(', ')})` : ''
  } catch { return '' }
}
