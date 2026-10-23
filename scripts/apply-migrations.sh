#!/usr/bin/env bash
# Áp các migration CHƯA áp lên database Supabase thật (gọi từ GitHub Actions).
# - Danh sách + thứ tự: supabase/v2/deploy-order.txt; ghi nhận trong private.schema_migrations (tên, sha256, thời điểm).
# - Mỗi file tự gói transaction; lỗi → dừng ngay (ON_ERROR_STOP), file lỗi không được ghi nhận.
# - File đã áp mà nội dung đổi → chỉ cảnh báo, KHÔNG chạy lại (muốn sửa: viết migration mới).
# Cần biến môi trường SUPABASE_DB_URL (Session pooler URI). Không in ra URL / mật khẩu.
set -euo pipefail
: "${SUPABASE_DB_URL:?Thiếu SUPABASE_DB_URL}"
DIR="$(cd "$(dirname "$0")/../supabase/v2" && pwd)"
PSQL=(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -X -q -t -A)

"${PSQL[@]}" <<'SQL'
create schema if not exists private;
create table if not exists private.schema_migrations (
  name text primary key,
  sha256 text,
  applied_at timestamptz not null default now(),
  note text
);
SQL

# Lần đầu: ghi mốc các file đã chạy tay (không chạy lại).
if [ "$("${PSQL[@]}" -c "select count(*) from private.schema_migrations")" = "0" ]; then
  grep -v '^\s*#' "$DIR/deploy-baseline.txt" | sed '/^\s*$/d' | while read -r f; do
    "${PSQL[@]}" -c "insert into private.schema_migrations(name, sha256, note) values ('$f', '$(shasum -a 256 "$DIR/$f" | cut -d' ' -f1)', 'baseline: chạy tay trước khi có CI') on conflict do nothing"
    echo "mốc: $f"
  done
fi

applied=0
while read -r f; do
  [ -z "$f" ] && continue
  sum=$(shasum -a 256 "$DIR/$f" | cut -d' ' -f1)
  old=$("${PSQL[@]}" -c "select sha256 from private.schema_migrations where name = '$f'")
  if [ -n "$old" ]; then
    [ "$old" != "$sum" ] && echo "::warning::$f đã áp nhưng nội dung đã đổi — KHÔNG chạy lại; viết migration mới nếu cần."
    continue
  fi
  echo "Áp $f …"
  "${PSQL[@]}" -f "$DIR/$f" > /dev/null
  "${PSQL[@]}" -c "insert into private.schema_migrations(name, sha256) values ('$f', '$sum')"
  echo "Đã áp $f"
  applied=$((applied + 1))
done < <(grep -v '^\s*#' "$DIR/deploy-order.txt" | sed '/^\s*$/d')
echo "Xong: áp mới $applied file."
