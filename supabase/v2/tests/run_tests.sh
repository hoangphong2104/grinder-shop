#!/bin/bash
# Chạy toàn bộ test v2 trên 1 cụm PostgreSQL 16 tạm (xoá khi xong). KHÔNG đụng Supabase thật.
#   bash supabase/v2/tests/run_tests.sh
# Luồng: initdb → stub Supabase → cài v1 (migrations/001 + 002) + dữ liệu v1 → setup-v2.sql (2 lần, idempotent)
#        → kiểm tra reset → test nghiệp vụ → test 2 phiên tranh 1 chiếc
#        → CR-003: 002_buying_fee.sql 2 lần trên DB cài mới + test phí mua hộ
#        → CR-004: 003 (2 lần) trên DB cài mới (001 đã gồm CR-003 + CR-004; 002 chạy lại phải lỗi an toàn) + test 05, 10
#        → nâng cấp (mô phỏng LỊCH SỬ DB THẬT): DB thứ 2 = v1 có dữ liệu → 000 + fixtures/001_schema_v2_pre003.sql
#          (bản v2 trước CR-003) + dữ liệu (test 03) → chụp → 002 (2 lần) → dữ liệu không đổi → dữ liệu thêm (test 05)
#          → chụp → 003 (2 lần) → dữ liệu cũ không đổi (test 09) + test CR-004 (10)
#          → so schema: cài mới (setup-v2) = v2 cũ + 002 + 003
#        → dừng server, xoá cụm.
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
PGBIN=${PGBIN:-/opt/homebrew/bin}
BASE=${PGV2_BASE:-/tmp/claude-501/pgv2}        # đường dẫn ngắn: socket unix > 103 byte sẽ lỗi
PORT=${PGV2_PORT:-54329}
HERE="$(cd "$(dirname "$0")" && pwd)"
V2="$(cd "$HERE/.." && pwd)"
V1="$(cd "$V2/../migrations" && pwd)"
LOG="$BASE/test.log"

cleanup() {
  [ -f "$LOG" ] && cp "$LOG" "$HERE/last_run.log"
  "$PGBIN/pg_ctl" -D "$BASE/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$BASE"
}
trap cleanup EXIT

rm -rf "$BASE"; mkdir -p "$BASE"
"$PGBIN/initdb" -D "$BASE/data" --locale=C -E UTF8 -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$BASE/data" -l "$BASE/server.log" -w \
  -o "-k $BASE -p $PORT -c listen_addresses='' -c timezone=UTC" start >/dev/null
PSQL=("$PGBIN/psql" -h "$BASE" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -X -q)
"${PSQL[@]}" -d postgres -c "create database grinder" >/dev/null
P=("${PSQL[@]}" -d grinder)

: > "$LOG"
step() { echo "== $*" | tee -a "$LOG"; }

# setup-v2.sql phải đúng = 6 dòng header + 000 + dòng trống + 001
if cat "$V2/000_reset_v1.sql" <(printf '\n') "$V2/001_schema_v2.sql" | cmp -s - <(tail -n +7 "$V2/setup-v2.sql"); then
  echo "PASS: setup-v2.sql = 000_reset_v1.sql + 001_schema_v2.sql" | tee -a "$LOG"
else
  echo "FAIL: setup-v2.sql khác 000 + 001 (tạo lại bằng cat)" | tee -a "$LOG"; exit 1
fi

step "stub Supabase";        "${P[@]}" -f "$HERE/00_supabase_stub.sql" >>"$LOG" 2>&1
step "v1: 001_init + 002_realtime"; "${P[@]}" -f "$V1/001_init.sql" >>"$LOG" 2>&1; "${P[@]}" -f "$V1/002_realtime.sql" >>"$LOG" 2>&1
step "v1: dữ liệu mẫu";      "${P[@]}" -f "$HERE/01_v1_seed.sql" 2>&1 | tee -a "$LOG"
step "setup-v2.sql (lần 1, trên DB v1 có dữ liệu)"; "${P[@]}" -f "$V2/setup-v2.sql" >>"$LOG" 2>&1
# CI (scripts/apply-migrations.sh) ghi nhật ký vào private.schema_migrations — chạy lại setup-v2 (000) không được xoá bảng này
"${P[@]}" -c "create table if not exists private.schema_migrations (name text primary key, sha256 text, applied_at timestamptz not null default now(), note text); insert into private.schema_migrations(name) values ('setup-v2.sql')" >>"$LOG" 2>&1
step "setup-v2.sql (lần 2, idempotent)";            "${P[@]}" -f "$V2/setup-v2.sql" >>"$LOG" 2>&1
if [ "$("${P[@]}" -At -c "select count(*) from private.schema_migrations")" = "1" ]; then
  echo "PASS: 000_reset_v1.sql giữ private.schema_migrations (nhật ký migration của CI)" | tee -a "$LOG"
else
  echo "FAIL: 000_reset_v1.sql làm mất private.schema_migrations" | tee -a "$LOG"; exit 1
fi
"${P[@]}" -c "drop table private.schema_migrations" >>"$LOG" 2>&1   # không có ở DB nâng cấp ⇒ bỏ để so schema
step "000_reset_v1.sql chạy riêng 2 lần + 001";     "${P[@]}" -f "$V2/000_reset_v1.sql" >>"$LOG" 2>&1
"${P[@]}" -f "$V2/000_reset_v1.sql" >>"$LOG" 2>&1; "${P[@]}" -f "$V2/001_schema_v2.sql" >>"$LOG" 2>&1
step "kiểm tra reset";       "${P[@]}" -f "$HERE/02_verify_reset.sql" >>"$LOG" 2>&1
step "test nghiệp vụ v2";    "${P[@]}" -f "$HERE/03_v2_tests.sql" >>"$LOG" 2>&1

step "race: 2 phiên giữ cùng ZP6-006"
"${P[@]}" -At -f "$HERE/04_race_a.sql" > "$BASE/race_a.out" 2>&1 &
APID=$!
sleep 1
T0=$(date +%s)
"${P[@]}" -At -f "$HERE/04_race_b.sql" > "$BASE/race_b.out" 2>&1
T1=$(date +%s)
wait $APID
cat "$BASE/race_a.out" "$BASE/race_b.out" >> "$LOG"
grep -q '^A_SAVED confirmed' "$BASE/race_a.out" && echo "PASS: race: phiên A lưu đơn ZP6-006 (confirmed)" >> "$LOG"
if [ $((T1 - T0)) -ge 1 ]; then
  echo "PASS: race: phiên B phải chờ khoá của A ($((T1 - T0))s)" >> "$LOG"
else
  echo "FAIL: race: phiên B không chờ khoá ($((T1 - T0))s)" >> "$LOG"; exit 1
fi

# ---------- CR-003 + CR-004 trên DB cài mới ----------
step "003_cod_return_condition.sql (lần 1 + 2) trên DB cài mới (001 đã gồm CR-004 ⇒ không đổi gì)"
"${P[@]}" -f "$V2/003_cod_return_condition.sql" >>"$LOG" 2>&1; "${P[@]}" -f "$V2/003_cod_return_condition.sql" >>"$LOG" 2>&1
step "002_buying_fee.sql chạy nhầm SAU 003 phải lỗi và rollback (không hỏng gì — so schema bên dưới chứng minh)"
if "${P[@]}" -f "$V2/002_buying_fee.sql" >>"$LOG" 2>&1; then
  echo "FAIL: 002 chạy lại sau 003 lẽ ra phải lỗi (v_lot_summary bớt cột)" | tee -a "$LOG"; exit 1
else
  echo "PASS: 002 chạy nhầm sau 003 ⇒ lỗi 'cannot drop columns from view', transaction rollback" | tee -a "$LOG"
fi
step "test CR-003 trên DB cài mới"; "${P[@]}" -f "$HERE/05_buying_fee_tests.sql" >>"$LOG" 2>&1
step "test CR-004 trên DB cài mới"; "${P[@]}" -f "$HERE/10_cr004_tests.sql" >>"$LOG" 2>&1

step "nâng cấp: DB v1 → v2 TRƯỚC CR-003 (fixtures/001_schema_v2_pre003.sql) + dữ liệu"
"${PSQL[@]}" -d postgres -c "create database grinder_up" >/dev/null
U=("${PSQL[@]}" -d grinder_up)
sed '/^create role /d' "$HERE/00_supabase_stub.sql" | "${U[@]}" -f - >>"$LOG" 2>&1   # role dùng chung cả cụm, đã tạo
"${U[@]}" -f "$V1/001_init.sql" >>"$LOG" 2>&1; "${U[@]}" -f "$V1/002_realtime.sql" >>"$LOG" 2>&1
"${U[@]}" -f "$HERE/01_v1_seed.sql" >>"$LOG" 2>&1
"${U[@]}" -f "$V2/000_reset_v1.sql" >>"$LOG" 2>&1; "${U[@]}" -f "$HERE/fixtures/001_schema_v2_pre003.sql" >>"$LOG" 2>&1
"${U[@]}" -f "$HERE/02_verify_reset.sql" >>"$LOG" 2>&1
"${U[@]}" -f "$HERE/03_v2_tests.sql" >>"$LOG" 2>&1
step "nâng cấp: chụp số liệu trước 002"; "${U[@]}" -f "$HERE/06_upgrade_snapshot.sql" >>"$LOG" 2>&1
step "nâng cấp: 002_buying_fee.sql lần 1 (DB v2 cũ có dữ liệu)"; "${U[@]}" -f "$V2/002_buying_fee.sql" >>"$LOG" 2>&1
step "nâng cấp: 002_buying_fee.sql lần 2 (idempotent)";          "${U[@]}" -f "$V2/002_buying_fee.sql" >>"$LOG" 2>&1
step "nâng cấp: dữ liệu cũ giữ nguyên";  "${U[@]}" -f "$HERE/07_upgrade_verify.sql" >>"$LOG" 2>&1
step "nâng cấp: test CR-003 trên DB đã nâng cấp (thêm dữ liệu sau 002)"; "${U[@]}" -f "$HERE/05_buying_fee_tests.sql" >>"$LOG" 2>&1
step "nâng cấp: chụp số liệu trước 003";  "${U[@]}" -f "$HERE/08_cr004_snapshot.sql" >>"$LOG" 2>&1
step "nâng cấp: 003_cod_return_condition.sql lần 1 (DB thật mô phỏng: pre-003 + 002 + dữ liệu)"; "${U[@]}" -f "$V2/003_cod_return_condition.sql" >>"$LOG" 2>&1
step "nâng cấp: 003_cod_return_condition.sql lần 2 (idempotent)";  "${U[@]}" -f "$V2/003_cod_return_condition.sql" >>"$LOG" 2>&1
step "nâng cấp: dữ liệu cũ giữ nguyên sau 003";  "${U[@]}" -f "$HERE/09_cr004_verify.sql" >>"$LOG" 2>&1
step "nâng cấp: test CR-004 trên DB đã nâng cấp"; "${U[@]}" -f "$HERE/10_cr004_tests.sql" >>"$LOG" 2>&1

step "so schema public + private: cài mới (setup-v2) = v2 cũ + 002 + 003"
dump() { "$PGBIN/pg_dump" -h "$BASE" -p "$PORT" -U postgres -d "$1" --schema-only --no-owner -n public -n private \
           | grep -vE '^(--|\\restrict|\\unrestrict)' | sed '/^$/d'; }
dump grinder > "$BASE/schema_fresh.sql"; dump grinder_up > "$BASE/schema_up.sql"
if [ -s "$BASE/schema_fresh.sql" ] && diff -u "$BASE/schema_fresh.sql" "$BASE/schema_up.sql" >> "$LOG" 2>&1; then
  echo "PASS: schema giống hệt: cài mới (001 có CR-003 + CR-004) = v2 cũ + 002 + 003 ($(wc -l < "$BASE/schema_fresh.sql" | tr -d ' ') dòng pg_dump)" | tee -a "$LOG"
else
  echo "FAIL: schema cài mới khác v2 cũ + 002 + 003 (xem diff trong log)" | tee -a "$LOG"; exit 1
fi

if grep -q 'FAIL' "$LOG"; then
  grep 'FAIL' "$LOG"; echo "KẾT QUẢ: CÓ LỖI"; exit 1
fi
grep -o 'PASS: .*' "$LOG" > "$BASE/pass.txt"
echo "KẾT QUẢ: $(wc -l < "$BASE/pass.txt" | tr -d ' ') PASS, 0 FAIL  (log: tests/last_run.log)"
