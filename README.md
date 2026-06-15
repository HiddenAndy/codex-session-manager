# Codex Session Manager

Local-only diagnostics and repair UI for Codex Desktop session history.

## Run

macOS에서는 `start.command`를 더블클릭하면 됩니다.

- 필요한 경우에만 `npm install`을 실행합니다.
- 서버가 준비되면 브라우저를 자동으로 엽니다.
- `start.command`로 실행한 경우 열린 페이지가 닫히고 heartbeat가 2분 동안 끊기면 서버가 자동 종료됩니다.

```sh
npm start
```

수동 실행 시 `http://127.0.0.1:4317`을 엽니다.

## Updates

앱 우측의 `프로그램 업데이트` 영역에서 GitHub 업데이트를 확인하고 설치할 수 있습니다.

기본 업데이트 소스는 `HiddenAndy/codex-session-manager`입니다.

- 우선 최신 GitHub Release를 확인합니다.
- Release asset 이름은 `codex-session-manager.zip`이어야 합니다.
- Release가 없으면 저장소 기본 브랜치 zip을 확인합니다.
- 설치 전 기존 앱 파일은 `updates/backup-*`에 백업됩니다.
- 로컬 설정, 로그, 백업, 스냅샷, dist 파일은 업데이트로 덮어쓰지 않습니다.

Release용 zip은 다음 명령으로 생성합니다.

```sh
npm run package:release
```

생성된 `dist/codex-session-manager.zip`을 GitHub Release asset으로 업로드합니다.
버전 기반 업데이트를 쓰려면 `package.json`의 `version`을 올리고, 같은 버전의 태그를 `v0.1.1`처럼 생성합니다.

필요하면 환경 변수로 업데이트 소스를 바꿀 수 있습니다.

- `CODEX_SESSION_MANAGER_UPDATE_REPO`: `owner/repo` 형식의 저장소
- `CODEX_SESSION_MANAGER_UPDATE_ASSET`: Release asset 파일명
- `CODEX_SESSION_MANAGER_UPDATE_BRANCH`: Release가 없을 때 확인할 브랜치
- `GITHUB_TOKEN`: 비공개 저장소 또는 API rate limit 회피용 토큰

## What It Checks

- Session JSONL `cwd` vs `state_5.sqlite` `threads.cwd`
- Missing session files or DB rows
- Non-canonical rollout filenames
- Duplicate session files for the same thread id
- Missing `session_index.jsonl` entries

## Mutations

The UI can run a `cwd` repair across session JSONL files and the SQLite `threads`
table. It writes a backup under `~/.codex/backups/codex_session_manager_cwd_*`
before mutating anything.

The backup delete button is intentionally limited to:

- entries under `~/.codex/backups`
- session files ending in `_bak.jsonl`
