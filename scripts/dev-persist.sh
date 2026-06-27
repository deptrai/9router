#!/usr/bin/env bash
# dev-persist.sh — Wrapper tự restart `next dev` khi process exit/crash.
# Dùng thay cho `npm run dev` khi muốn server sống lại sau mỗi lần sửa code gây crash.
# Thoát bằng Ctrl-C (SIGINT/SIGTERM) sẽ dừng hẳn, không restart.
set -u

PORT="${PORT:-20128}"
RESTART_DELAY=2
EXIT_CODE=0

trap 'echo ""; echo "[dev-persist] Nhận tín hiệu dừng — thoát hẳn."; exit 0' INT TERM

echo "[dev-persist] Bắt đầu: next dev --webpack --port $PORT (auto-restart khi crash)"
echo "[dev-persist] Nhấn Ctrl-C để dừng hẳn."
echo ""

while true; do
  npx next dev --webpack --port "$PORT"
  EXIT_CODE=$?
  echo ""
  echo "[dev-persist] next dev thoát với code $EXIT_CODE — restart sau ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
