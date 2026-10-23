#!/bin/bash
# Chạy toàn bộ test v2 trên 1 cụm PostgreSQL 16 tạm (xoá khi xong). KHÔNG đụng Supabase thật.
#   bash supabase/v2/tests/run_tests.sh
# Luồng: initdb → stub Supabase → cài v1 (migrations/001 + 002) + dữ liệu v1 → setup-v2.sql (2 lần, idempotent)
#        → kiểm tra reset → test nghiệp vụ → test 2 phiên tranh 1 chiếc → dừng server, xoá cụm.
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
step "setup-v2.sql (lần 2, idempotent)";            "${P[@]}" -f "$V2/setup-v2.sql" >>"$LOG" 2>&1
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

if grep -q 'FAIL' "$LOG"; then
  grep 'FAIL' "$LOG"; echo "KẾT QUẢ: CÓ LỖI"; exit 1
fi
grep -o 'PASS: .*' "$LOG" > "$BASE/pass.txt"
echo "KẾT QUẢ: $(wc -l < "$BASE/pass.txt" | tr -d ' ') PASS, 0 FAIL  (log: tests/last_run.log)"
