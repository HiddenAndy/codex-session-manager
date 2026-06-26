#!/bin/zsh
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

printf '\033]0;Codex Session Manager\007'

PORT="${PORT:-4317}"
URL="http://127.0.0.1:${PORT}/"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/session-manager-$(date +%Y%m%d-%H%M%S).log"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 이상이 필요합니다."
  echo "설치 후 다시 실행하세요: https://nodejs.org/"
  read -r "?Enter 키를 누르면 종료합니다."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "현재 Node.js 버전: $(node -v)"
  echo "Node.js 20 이상이 필요합니다."
  read -r "?Enter 키를 누르면 종료합니다."
  exit 1
fi

if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ] || { [ -f "package-lock.json" ] && [ "package-lock.json" -nt "node_modules" ]; }; then
  echo "의존성을 확인합니다..."
  npm install || {
    echo "npm install 실패"
    read -r "?Enter 키를 누르면 종료합니다."
    exit 1
  }
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "이미 서버가 실행 중입니다: $URL"
  RUNNING_PID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN | head -n 1)"
  RUNNING_DIR=""
  if [ -n "$RUNNING_PID" ]; then
    RUNNING_DIR="$(lsof -p "$RUNNING_PID" 2>/dev/null | awk '$4 == "cwd" {print $9; exit}')"
  fi
  if [ -n "$RUNNING_DIR" ]; then
    echo "실행 중인 위치: $RUNNING_DIR"
    echo "현재 실행한 위치: $PROJECT_DIR"
    if [ "$RUNNING_DIR" != "$PROJECT_DIR" ]; then
      echo "주의: 다른 위치의 서버가 이미 실행 중입니다."
      echo "현재 package.json을 수정해도 열린 화면은 기존 서버 버전을 기준으로 동작합니다."
      echo "해당 서버를 종료한 뒤 다시 실행하면 현재 위치에서 시작됩니다."
    fi
  fi
  open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

echo "서버를 시작합니다: $URL"
mkdir -p "$LOG_DIR"
echo "로그 파일: $LOG_FILE"
CODEX_SESSION_MANAGER_AUTO_SHUTDOWN=1 PORT="$PORT" npm start >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
tail -n +1 -f "$LOG_FILE" &
TAIL_PID=$!

for _ in {1..80}; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "서버가 시작 중 종료되었습니다."
    wait "$SERVER_PID"
    kill "$TAIL_PID" >/dev/null 2>&1 || true
    echo "로그 파일: $LOG_FILE"
    read -r "?Enter 키를 누르면 종료합니다."
    exit 1
  fi
  if curl -fsS "$URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

open "$URL" >/dev/null 2>&1 || echo "브라우저를 자동으로 열지 못했습니다. 직접 열어주세요: $URL"

wait "$SERVER_PID"
EXIT_CODE=$?
kill "$TAIL_PID" >/dev/null 2>&1 || true
echo "서버가 종료되었습니다."
echo "로그 파일: $LOG_FILE"

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "서버가 비정상 종료되었습니다. 위 로그를 확인하세요."
  read -r "?Enter 키를 누르면 종료합니다."
  exit "$EXIT_CODE"
fi

if [ "$(uname -s)" = "Darwin" ]; then
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal)
      osascript <<'APPLESCRIPT' >/dev/null 2>&1 &
tell application "Terminal"
  repeat with w in windows
    if name of w contains "Codex Session Manager" then
      close w
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
      ;;
    iTerm.app)
      osascript <<'APPLESCRIPT' >/dev/null 2>&1 &
tell application id "com.googlecode.iterm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s contains "Codex Session Manager" then
          close s
          return
        end if
      end repeat
    end repeat
  end repeat
end tell
APPLESCRIPT
      ;;
  esac
fi

exit "$EXIT_CODE"
