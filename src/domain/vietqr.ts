/**
 * CR-005 ý 12 - VietQR chuyển khoản (chuẩn EMVCo QR / NAPAS 247, chuyển tới số tài khoản).
 * Khách quét ⇒ app ngân hàng điền sẵn ngân hàng (BIN), số TK, số tiền (= còn phải thu); app không truyền nội dung (để mặc định của ngân hàng).
 *
 * Cấu trúc (mỗi trường = ID 2 số + độ dài 2 số + giá trị):
 *   00 "01"                          Payload Format Indicator
 *   01 "12" (có số tiền) | "11"      Point of Initiation: 12 = dùng 1 lần (dynamic), 11 = tĩnh
 *   38 Merchant Account Information  00 "A000000727" (GUID NAPAS) · 01 { 00 BIN 6 số · 01 số TK } · 02 "QRIBFTTA"
 *                                    (dịch vụ chuyển nhanh tới TÀI KHOẢN)
 *   53 "704"                         tiền tệ VND (ISO 4217)
 *   54 số tiền                       số nguyên đồng (≤ 13 ký tự); bỏ khi không có số tiền
 *   58 "VN"                          quốc gia
 *   62 { 08 nội dung }               Additional Data - Purpose of Transaction (≤ 25 ký tự, không dấu)
 *   63 CRC                           CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) trên toàn chuỗi kể cả "6304", 4 ký tự HEX hoa
 * Tên chủ TK (accountName) KHÔNG đưa vào chuỗi: chuyển khoản tới TK (P2P) không bắt buộc trường 59, app ngân hàng tự tra
 * tên người nhận từ số TK - tên chỉ để hiện cạnh mã QR / kiểm tra nhập liệu.
 */

export interface VietQrInput {
  /** Mã BIN NAPAS của ngân hàng nhận, 6 số (vd. 970436 = Vietcombank). */
  bin: string;
  /** Số tài khoản nhận (1..19 chữ / số). */
  accountNo: string;
  /** Tên chủ tài khoản - chỉ để hiển thị (không mã hoá vào QR). */
  accountName?: string | null;
  /** Số tiền ₫ (số nguyên > 0); null / 0 ⇒ QR tĩnh, khách tự nhập số tiền. */
  amount?: number | null;
  /** Nội dung chuyển khoản (vd. mã đơn "D-005"); bỏ dấu, chỉ giữ chữ / số / khoảng trắng / '-', tối đa 25 ký tự. */
  content?: string | null;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, không đảo bit, không XOR cuối) của chuỗi (UTF-8) → 4 ký tự HEX hoa. */
export function crc16Ccitt(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Bỏ dấu tiếng Việt (đ → d), chỉ giữ A-Z a-z 0-9, khoảng trắng và '-'; gộp khoảng trắng; cắt `max` ký tự. */
export function vietQrText(text: string, max = 25): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

const tlv = (id: string, value: string): string => {
  if (value.length > 99) throw new RangeError(`VietQR: trường ${id} quá dài (${value.length})`);
  return id + String(value.length).padStart(2, '0') + value;
};

/** Lỗi nhập liệu (tiếng Việt) hoặc null nếu tạo được QR. */
export function checkVietQr(input: VietQrInput): string | null {
  if (!/^[0-9]{6}$/.test(input.bin ?? '')) return 'Chọn ngân hàng (mã BIN 6 số) trong Cài đặt.';
  if (!/^[0-9A-Za-z]{1,19}$/.test(input.accountNo ?? '')) return 'Số tài khoản chỉ gồm chữ / số, tối đa 19 ký tự.';
  const a = input.amount;
  if (a != null && (!Number.isInteger(a) || a < 0 || String(a).length > 13)) return 'Số tiền phải là số nguyên đồng ≥ 0.';
  return null;
}

/**
 * Chuỗi VietQR (EMVCo) để vẽ mã QR. Ném RangeError khi dữ liệu sai (gọi `checkVietQr` trước để báo người dùng).
 * amount > 0 ⇒ QR dùng 1 lần có số tiền; nội dung rỗng sau khi bỏ dấu ⇒ không có trường 62.
 */
export function buildVietQrPayload(input: VietQrInput): string {
  const err = checkVietQr(input);
  if (err) throw new RangeError(`VietQR: ${err}`);
  const amount = input.amount && input.amount > 0 ? input.amount : null;
  const content = vietQrText(input.content ?? '');
  const account = tlv('00', 'A000000727') + tlv('01', tlv('00', input.bin) + tlv('01', input.accountNo)) + tlv('02', 'QRIBFTTA');
  const body =
    tlv('00', '01') +
    tlv('01', amount ? '12' : '11') +
    tlv('38', account) +
    tlv('53', '704') +
    (amount ? tlv('54', String(amount)) : '') +
    tlv('58', 'VN') +
    (content ? tlv('62', tlv('08', content)) : '') +
    '6304';
  return body + crc16Ccitt(body);
}
