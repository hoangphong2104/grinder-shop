# Edge Function `scan-goofish`

Đọc 1 tin rao Goofish (闲鱼) từ **ảnh chụp màn hình** hoặc **chữ copy** bằng Google Gemini (gói miễn phí), rồi trả về dữ liệu **điền sẵn** cho form lô (F2). Hợp đồng: `2.0-design/approved/system-design-lite-v1.md` §5.2.

- **BR-13:** AI chỉ điền sẵn. Function không ghi bảng nghiệp vụ nào, chỉ ghi `ai_scan_log` (`ai_scan_reserve` / `ai_scan_finish`). Lô chỉ được tạo khi bấm Lưu (`save_lot`).
- **NFR-10:** dùng JWT của người dùng (RLS áp dụng), không dùng `service_role`. `GEMINI_API_KEY` chỉ nằm trong Secrets của Supabase.
- **NFR-11:** chỉ gửi cho Gemini ảnh / chữ của tin rao và danh mục model / biến thể (tên + tên gọi khác). Không đọc bảng khách / đơn / công nợ.

| File | Nội dung |
|---|---|
| `index.ts` | Toàn bộ function, gồm 1 file để dán thẳng vào trình soạn thảo trên Dashboard |
| `test.ts` | 19 test (Deno), giả lập `fetch` cho Supabase và Gemini, không gọi mạng thật |

---

## 1. Hợp đồng đã cài đặt

**Request:** `POST /functions/v1/scan-goofish`, header `Authorization: Bearer <JWT người dùng>` (`supabase.functions.invoke` tự gắn).

```json
{ "input": { "kind": "image", "image_path": "<uid>/goofish/<uuid>.jpg" },
  "goofish_url": "https://www.goofish.com/item?id=1027765536701" }
```
hoặc `"input": { "kind": "text", "text": "<chữ copy, ≤ 20.000 ký tự>" }`. `goofish_url` không bắt buộc (`null` hoặc bỏ trống ⇒ không tra lô trùng).

**Response 200:**

```json
{
  "ok": true,
  "scan_id": "<uuid>",
  "model": "gemini-3.8-flash",
  "fields": {
    "listing_title":   { "value": "1Zpresso K-Ultra 手摇磨豆机 全新", "confidence": 0.95 },
    "price_cny":       { "value": 1010, "confidence": 0.93 },
    "seller_nickname": { "value": "咖啡小王", "confidence": 0.9 },
    "seller_region":   { "value": "浙江", "confidence": 0.85 },
    "model_id":        { "value": "<uuid>", "confidence": 0.92, "matched_text": "K-Ultra" },
    "variant_id":      { "value": null, "confidence": 0.4 }
  },
  "flags": ["variant_id"],
  "condition_text": "全新未拆",
  "notes": "Có giá gạch ngang ¥1.299 — đã lấy giá hiện tại ¥1.010.",
  "seller_match": { "seller_id": "<uuid>", "nickname": "咖啡小王", "is_avoided": false },
  "duplicate_lot_ids": [],
  "usage": { "scans_this_month": 12, "cap": 100 }
}
```

**Lỗi:** `{ "ok": false, "error": { "code": "...", "message": "<tiếng Việt>" } }`

| HTTP | code | Khi nào |
|---|---|---|
| 400 | `INVALID_INPUT` | body không phải JSON / > 256 KB; thiếu `input`; `kind` sai; text rỗng hoặc > 20.000 ký tự; `image_path` không bắt đầu bằng `{uid}/` hoặc có `..`; file không phải JPEG / PNG / WebP. Method khác POST trả **405** với cùng code |
| 401 | `NOT_AUTHENTICATED` | thiếu JWT / JWT hết hạn |
| 403 | `FORBIDDEN` | user không có trong `ALLOWED_USER_IDS`, hoặc request từ Origin không được phép |
| 403 | `SCAN_DISABLED` | đã tắt quét AI trong Cài đặt |
| 404 | `IMAGE_NOT_FOUND` | không tải được ảnh từ Storage |
| 413 | `PAYLOAD_TOO_LARGE` | ảnh > 5 MB |
| 422 | `AI_UNREADABLE` | bị chặn (`blockReason`), `finishReason` ≠ `STOP`, JSON sai, hoặc AI báo không phải tin Goofish |
| 429 | `SCAN_CAP_REACHED` | hết hạn mức an toàn tháng. Có thêm `error.used` và `error.cap` |
| 429 | `AI_QUOTA_EXHAUSTED` | Gemini trả 429 (đã thử `SCAN_MODEL_FALLBACK` nếu có). **Không tính vào hạn mức** |
| 502 | `AI_UPSTREAM_ERROR` | Gemini 5xx / 4xx khác / timeout 45 s / lỗi mạng |
| 500 | `INTERNAL` | thiếu secret, lỗi đọc DB, lỗi khác |

**Những chỗ §5.2 chưa rõ, đã chọn như sau:**

1. **Có `flags` khi nào:** độ tin cậy < `settings.ai_confidence_threshold` **hoặc** giá trị bị validate loại (giá sai, mã ngoài danh mục, biến thể không thuộc model). Trường bị flag luôn có `value: null`. Trường bị loại có `confidence: 0`. Nếu AI trả `null` với độ tin cậy cao (vd. tin không ghi nơi gửi), trường đó **không** bị flag.
2. **`SCAN_CAP_REACHED`:** `used` / `cap` nằm phẳng trong `error` (`error.used`, `error.cap`).
3. **Gửi danh mục cho Gemini bằng mã ngắn (`M1`, `V1`…)** thay cho uuid trong prompt và enum, kèm `"NONE"`. Code đổi lại thành uuid. Client vẫn nhận `model_id` / `variant_id` là uuid như §5.2. Cách này giúp AI không phải chép lại uuid dài.
4. **Biến thể phải thuộc model đã chọn**, xét sau khi áp ngưỡng cho model. Nếu model bị null thì biến thể cũng bị null và flag.
5. **Validate tự viết** (hàm `cleanAiOutput`), không dùng zod, để giữ ít phụ thuộc. Phạm vi kiểm tra đúng như §5.2 bước 8.
6. **Text:** chuẩn hoá khoảng trắng trước, sau đó nếu vẫn > 20.000 ký tự thì trả **400** (không tự cắt).
7. **`output_tokens` = `candidatesTokenCount + thoughtsTokenCount`**, vì token "thinking" cũng tính quota. `cost_usd` luôn = 0.
8. **`seller_match`:** so nickname đã qua ngưỡng, không phân biệt hoa thường (`ilike`, đã escape `%` `_`). Ưu tiên người bán chưa ẩn. **`duplicate_lot_ids`:** lô cùng `goofish_item_id`, trừ lô đã huỷ, giống `save_lot`.
9. **`usage.scans_this_month`:** đếm sau khi đóng log, cùng quy tắc với `ai_scan_reserve` (bỏ lượt lỗi 0 token).
10. **CORS:** cho phép `https://hoangphong2104.github.io` và `http://localhost:5173`, đổi được bằng `ALLOWED_ORIGINS`. Trình duyệt từ Origin khác bị trả 403 ngay, không tốn lượt. Request không có Origin (curl) vẫn chạy.
11. **Lỗi trước khi gọi Gemini** (ảnh không có, file sai định dạng…) ghi `ai_scan_finish(error, 0 token)`, nên không tính vào hạn mức. Lỗi **sau** khi Gemini đã trả lời (vd. `AI_UNREADABLE`) có token, nên **có tính**.

---

## 2. Secrets / biến môi trường

| Tên | Bắt buộc | Giá trị |
|---|---|---|
| `GEMINI_API_KEY` | ✔ | Key tạo ở Google AI Studio. **Không bật billing** cho project Google chứa key |
| `ALLOWED_USER_IDS` | ✔ | `a0478118-6be3-4fe8-b2bd-b6b49011ca84` (nhiều id thì cách nhau bằng dấu phẩy). Để trống thì **mọi người bị chặn** |
| `SCAN_MODEL` | nên đặt | Mặc định `gemini-3.8-flash` (xem mục 4) |
| `SCAN_MODEL_FALLBACK` | tuỳ chọn | Model thử 1 lần khi model chính trả 429, vd. `gemini-3.5-flash-lite` |
| `ALLOWED_ORIGINS` | tuỳ chọn | Ghi đè danh sách CORS, cách nhau bằng dấu phẩy |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase tự cấp | Không cần đặt. Nếu thiếu anon key, function dùng header `apikey` mà supabase-js gửi kèm |

---

## 3. Deploy (không cần CLI)

1. **Supabase Dashboard** → project `kho-coi` → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Đặt tên function là **`scan-goofish`** (đúng tên này, client gọi theo tên).
3. Xoá code mẫu, dán **toàn bộ** nội dung `index.ts`, rồi bấm **Deploy function**. Không cần dán `test.ts`.
4. **Edge Functions → Secrets** (hoặc *Project Settings → Edge Functions*) → thêm `GEMINI_API_KEY`, `ALLOWED_USER_IDS`, `SCAN_MODEL` (+ `SCAN_MODEL_FALLBACK` nếu muốn) → Save. Secret có hiệu lực ngay, không cần deploy lại.
5. **Xác thực JWT:** mở function → tab **Details / Settings** → giữ **bật** "Enforce JWT verification" (mặc định). Function vẫn tự kiểm lại bằng `auth.getUser()` và `ALLOWED_USER_IDS`. *Ngoại lệ:* nếu project dùng **JWT signing keys mới** và gateway từ chối cả token hợp lệ (401 không phải JSON của function), thì có thể tắt tuỳ chọn này. Function vẫn an toàn vì tự xác thực.
6. Migration `001_init.sql` phải đã chạy (có `ai_scan_reserve`, `ai_scan_finish`, bucket `private-images`). Tài khoản phải đã đăng nhập app ít nhất 1 lần (`bootstrap_user` tạo `settings` + 3 model).

*Cách CLI (nếu sau này dùng):* `supabase functions deploy scan-goofish` và `supabase secrets set GEMINI_API_KEY=… ALLOWED_USER_IDS=… SCAN_MODEL=…`. Nếu cần tắt JWT check thì thêm `[functions.scan-goofish] verify_jwt = false` vào `supabase/config.toml`.

**Không bao giờ** dán `GEMINI_API_KEY` vào code, repo (repo public), GitHub variables hay chat.

---

## 4. Model Gemini và hạn mức miễn phí — **phải kiểm lại khi deploy**

Kiểm ngày 2026-10-22 trên ai.google.dev (trang *Models* và *Pricing*):

- `gemini-3.8-flash` là bản Flash **Stable** mới nhất, có **Free tier**. Đây là giá trị mặc định trong code.
- `gemini-3.5-flash-lite` là bản Stable, có Free tier, nhanh và rẻ quota hơn. Hợp làm `SCAN_MODEL_FALLBACK`.
- `gemini-2.5-flash` vẫn chạy nhưng Google ghi là **chỉ cho người đã dùng trước đó**, và project mới nên dùng bản 3.x. Key mới tạo có thể không gọi được ⇒ không dùng làm mặc định.

**Hạn mức miễn phí (RPM / RPD / TPM) không được ghi cứng ở đây.** Hãy xem trong **Google AI Studio → Rate limits** của key, vì Google đổi thường xuyên. Đổi model chỉ cần sửa secret `SCAN_MODEL`, không cần deploy lại.

Cấu hình gửi kèm theo thế hệ model (`generationConfig`):
- `gemini-2.5-flash*`: `temperature 0` + `thinkingBudget 0`.
- `gemini-3*` trở lên: `thinkingLevel "low"`, giữ temperature mặc định theo khuyến nghị của Google cho Gemini 3.

Nếu Google đổi tên trường và trả 400, function sẽ trả `AI_UPSTREAM_ERROR` với thông báo "kiểm tra GEMINI_API_KEY / SCAN_MODEL". Cách xử lý: xem log, rồi sửa `generationConfigFor` trong `index.ts`.

Gói miễn phí: Google có thể dùng nội dung gửi lên để cải thiện sản phẩm. Điều này đã được chấp nhận vì chỉ gửi tin rao công khai (NFR-11).

---

## 5. Thử bằng curl

Lấy **access token** của bạn: mở app (đã đăng nhập) → DevTools → Application → Local Storage → key `sb-<ref>-auth-token` → copy `access_token` (hết hạn sau khoảng 1 giờ).

```bash
export SB_URL="https://<ref>.supabase.co"
export ANON="<anon / publishable key>"
export TOKEN="<access_token vừa copy>"

# Quét chữ copy
curl -sS "$SB_URL/functions/v1/scan-goofish" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"input":{"kind":"text","text":"1Zpresso K-Ultra 手摇磨豆机 全新未拆 ¥1010 原价¥1299 包邮 卖家：咖啡小王 IP属地：浙江"},
       "goofish_url":"https://www.goofish.com/item?id=1027765536701"}' | jq

# Quét ảnh: upload trước vào bucket private-images, thư mục <uid>/goofish/ (qua app hoặc Dashboard → Storage)
curl -sS "$SB_URL/functions/v1/scan-goofish" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"input":{"kind":"image","image_path":"a0478118-6be3-4fe8-b2bd-b6b49011ca84/goofish/test.jpg"}}' | jq

# Kiểm tra CORS preflight
curl -si -X OPTIONS "$SB_URL/functions/v1/scan-goofish" \
  -H "Origin: https://hoangphong2104.github.io" \
  -H "Access-Control-Request-Headers: authorization, x-client-info, apikey, content-type" | head -12
```

Cần thấy: `ok: true`, `fields.price_cny.value = 1010` (không lấy ¥1299), `model_id` = uuid của K Ultra. Bảng `ai_scan_log` có thêm 1 dòng `status = ok`. Xem log ở **Edge Functions → scan-goofish → Logs**: chỉ có `scan_id`, model, token, mã lỗi, không có nội dung tin.

Trước khi dùng thật (ADR-06): thử khoảng 10 ảnh Goofish thật, ghi lại độ đúng của giá / model. Nếu kém thì đổi `SCAN_MODEL`.

---

## 6. Chạy test (máy dev)

```bash
deno test --allow-env --no-config supabase/functions/scan-goofish/test.ts
deno check --no-config supabase/functions/scan-goofish/index.ts
```

Test giả lập `fetch` cho Auth / PostgREST / Storage / Gemini. Các trường hợp được kiểm: validate output AI, ngưỡng tin cậy, biến thể sai model, request hợp lệ / sai path / user lạ / thiếu JWT, 429 thì thử fallback rồi trả `AI_QUOTA_EXHAUSTED` và finish với 0 token, `finishReason ≠ STOP`, Gemini 5xx, `SCAN_CAP_REACHED`, CORS. Test **không** chạy với Supabase / Gemini thật.
