#!/bin/zsh
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

printf '\033]0;Codex Session Manager Stop\007'

PORT="${PORT:-4317}"
PID_FILE="$PROJECT_DIR/.codex-session-manager.pid"
STOPPED=0

stop_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then
    return
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return
  fi
  echo "서버를 종료합니다: PID $pid"
  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      sleep 0.2
    else
      STOPPED=1
      return
    fi
  done
  echo "정상 종료가 지연되어 강제 종료합니다: PID $pid"
  kill -9 "$pid" >/dev/null 2>&1 || true
  STOPPED=1
}

if [ -f "$PID_FILE" ]; then
  stop_pid "$(cat "$PID_FILE" 2>/dev/null | head -n 1)"
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    for pid in ${(f)PIDS}; do
      stop_pid "$pid"
    done
  fi
fi

if [ "$STOPPED" -eq 0 ]; then
  echo "실행 중인 서버가 없습니다."
else
  echo "서버가 종료되었습니다."
fi

exit 0
