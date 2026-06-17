import { createServer } from "node:http";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PACKAGE_JSON_PATH = join(__dirname, "package.json");
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const DEFAULT_BACKUPS_ROOT = join(__dirname, "backups");
const CONFIG_PATH = join(__dirname, ".codex-session-manager.json");
const PID_PATH = join(__dirname, ".codex-session-manager.pid");
const UPDATE_STATE_PATH = join(__dirname, ".codex-session-manager-update.json");
const UPDATE_WORK_DIR = join(__dirname, "updates");
const UPDATE_REPO = process.env.CODEX_SESSION_MANAGER_UPDATE_REPO || "HiddenAndy/codex-session-manager";
const UPDATE_ASSET_NAME = process.env.CODEX_SESSION_MANAGER_UPDATE_ASSET || "codex-session-manager.zip";
const UPDATE_BRANCH = process.env.CODEX_SESSION_MANAGER_UPDATE_BRANCH || "";
const UPDATE_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_SESSION_MANAGER_UPDATE_TIMEOUT_MS || 8000);
let CODEX_HOME = DEFAULT_CODEX_HOME;
let SESSIONS_ROOT = join(CODEX_HOME, "sessions");
let ARCHIVED_SESSIONS_ROOT = join(CODEX_HOME, "archived_sessions");
let BACKUPS_ROOT = DEFAULT_BACKUPS_ROOT;
let STATE_DB = defaultStateDbPath(CODEX_HOME);
let SESSION_INDEX = join(CODEX_HOME, "session_index.jsonl");
let CODEX_CONFIG_TOML = join(CODEX_HOME, "config.toml");
let CODEX_GLOBAL_STATE = join(CODEX_HOME, ".codex-global-state.json");
let CODEX_GLOBAL_STATE_BAK = join(CODEX_HOME, ".codex-global-state.json.bak");
let CODEX_CHAT_PROCESSES = join(CODEX_HOME, "process_manager", "chat_processes.json");
const PORT = Number(process.env.PORT || 4317);
const AUTO_SHUTDOWN = process.env.CODEX_SESSION_MANAGER_AUTO_SHUTDOWN === "1";
const HEARTBEAT_TIMEOUT_MS = Number(process.env.CODEX_SESSION_MANAGER_HEARTBEAT_TIMEOUT_MS || 120000);
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_ROLLOUT_RE = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${UUID_RE}\\.jsonl$`,
);
const APP_PACKAGE = await readPackageMetadata();

function expandHomePath(value) {
  const textValue = String(value || "").trim();
  if (textValue === "~") return homedir();
  if (textValue.startsWith("~/")) return join(homedir(), textValue.slice(2));
  return textValue;
}

function resolveConfigPath(value, fallback) {
  return resolve(expandHomePath(value || fallback));
}

function defaultStateDbPath(codexHome) {
  const sqlitePath = join(codexHome, "sqlite", "state_5.sqlite");
  return existsSync(sqlitePath) ? sqlitePath : join(codexHome, "state_5.sqlite");
}

function normalizeBackupsRoot(value, fallback = DEFAULT_BACKUPS_ROOT) {
  const resolved = resolveConfigPath(value, fallback);
  return basename(resolved) === "backups" ? resolved : join(resolved, "backups");
}

function applyConfigPaths(config = {}) {
  CODEX_HOME = resolveConfigPath(config.codexHome, DEFAULT_CODEX_HOME);
  SESSIONS_ROOT = resolveConfigPath(config.sessionsRoot, join(CODEX_HOME, "sessions"));
  ARCHIVED_SESSIONS_ROOT = join(CODEX_HOME, "archived_sessions");
  BACKUPS_ROOT = normalizeBackupsRoot(config.backupsRoot, DEFAULT_BACKUPS_ROOT);
  STATE_DB = resolveConfigPath(config.stateDb, defaultStateDbPath(CODEX_HOME));
  SESSION_INDEX = join(CODEX_HOME, "session_index.jsonl");
  CODEX_CONFIG_TOML = join(CODEX_HOME, "config.toml");
  CODEX_GLOBAL_STATE = join(CODEX_HOME, ".codex-global-state.json");
  CODEX_GLOBAL_STATE_BAK = join(CODEX_HOME, ".codex-global-state.json.bak");
  CODEX_CHAT_PROCESSES = join(CODEX_HOME, "process_manager", "chat_processes.json");
}

async function loadConfig() {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    applyConfigPaths(config);
    return;
  } catch {
    applyConfigPaths();
  }
}

async function saveConfig(payload) {
  const previousBackupsRoot = BACKUPS_ROOT;
  const expanded = expandHomePath(payload.codexHome);
  if (!expanded.startsWith("/")) throw new Error("absolute codexHome required");
  const codexHome = resolve(expanded);
  const sessionsRoot = resolveConfigPath(payload.sessionsRoot, join(codexHome, "sessions"));
  const backupsRoot = normalizeBackupsRoot(payload.backupsRoot, DEFAULT_BACKUPS_ROOT);
  const stateDb = resolveConfigPath(payload.stateDb, defaultStateDbPath(codexHome));
  const codexHomeStat = await stat(codexHome).catch(() => null);
  if (!codexHomeStat?.isDirectory()) throw new Error("codexHome directory not found");
  const sessionsRootStat = await stat(sessionsRoot).catch(() => null);
  if (!sessionsRootStat?.isDirectory()) throw new Error("sessionsRoot directory not found");
  const stateDbStat = await stat(stateDb).catch(() => null);
  if (!stateDbStat?.isFile()) throw new Error("stateDb file not found");
  await mkdir(backupsRoot, { recursive: true });
  await moveBackupEntries(previousBackupsRoot, backupsRoot);
  applyConfigPaths({ codexHome, sessionsRoot, backupsRoot, stateDb });
  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify({ codexHome: CODEX_HOME, sessionsRoot: SESSIONS_ROOT, backupsRoot: BACKUPS_ROOT, stateDb: STATE_DB }, null, 2)}\n`,
    "utf8",
  );
  return getConfig();
}

async function uniqueBackupDestination(dest) {
  if (!(await exists(dest))) return dest;
  const parent = dirname(dest);
  const name = basename(dest);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(parent, `${name}_moved_${i}`);
    if (!(await exists(candidate))) return candidate;
  }
  return join(parent, `${name}_moved_${Date.now()}`);
}

async function movePath(src, dest) {
  try {
    await rename(src, dest);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(src, dest, { recursive: true, preserveTimestamps: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function moveBackupEntries(fromRoot, toRoot) {
  const from = resolve(fromRoot);
  const to = resolve(toRoot);
  if (from === to) return { moved: [], skipped: [] };
  if (!(await exists(from))) return { moved: [], skipped: [] };
  await mkdir(to, { recursive: true });
  const moved = [];
  const skipped = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = await uniqueBackupDestination(join(to, entry.name));
    if (resolve(dest).startsWith(`${resolve(src)}/`)) {
      skipped.push(src);
      continue;
    }
    await movePath(src, dest);
    moved.push({ from: src, to: dest });
  }
  return { moved, skipped };
}

async function getConfig() {
  return {
    codexHome: CODEX_HOME,
    sessionsRoot: SESSIONS_ROOT,
    backupsRoot: BACKUPS_ROOT,
    stateDb: STATE_DB,
    defaultCodexHome: DEFAULT_CODEX_HOME,
    defaultSessionsRoot: join(CODEX_HOME, "sessions"),
    defaultBackupsRoot: DEFAULT_BACKUPS_ROOT,
    defaultStateDb: defaultStateDbPath(CODEX_HOME),
    configPath: CONFIG_PATH,
    codexHomeExists: await exists(CODEX_HOME),
    sessionsRootExists: await exists(SESSIONS_ROOT),
    backupsRootExists: await exists(BACKUPS_ROOT),
    stateDbExists: await exists(STATE_DB),
  };
}

await loadConfig();

let lastHeartbeatAt = Date.now();
let heartbeatStarted = false;
let activeRequests = 0;

function noteHeartbeat() {
  heartbeatStarted = true;
  lastHeartbeatAt = Date.now();
}

async function writePidFile() {
  await writeFile(PID_PATH, `${process.pid}\n`, "utf8").catch(() => {});
}

async function removePidFile() {
  await rm(PID_PATH, { force: true }).catch(() => {});
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

const SQLITE_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000];

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isSqliteBusyError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("database is locked") || message.includes("database busy") || message.includes("sqlite_busy");
}

async function sqlite(args, options = {}) {
  const retries = options.retries ?? SQLITE_RETRY_DELAYS_MS.length;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await sqliteOnce(args, options);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === retries) break;
      await sleep(SQLITE_RETRY_DELAYS_MS[Math.min(attempt, SQLITE_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw lastError;
}

function sqliteOnce(args, options = {}) {
  const sqliteArgs = ["-cmd", ".timeout 5000", ...args];
  if (options.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("sqlite3", sqliteArgs);
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          reject(new Error(err || `sqlite3 exited with ${code}`));
          return;
        }
        resolvePromise(out);
      });
      child.stdin.end(options.input);
    });
  }
  return new Promise((resolvePromise, reject) => {
    execFile("sqlite3", sqliteArgs, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message += stderr ? `\n${stderr}` : "";
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function execFileText(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function getCodexProcessStatus() {
  try {
    const output = await execFileText("ps", ["-axo", "pid=,args="]);
    const processes = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean)
      .filter((process) => process.command === "/Applications/Codex.app/Contents/MacOS/Codex");
    return { open: processes.length > 0, processes };
  } catch (error) {
    return { open: false, error: error.message };
  }
}

async function assertCodexClosed() {
  const status = await getCodexProcessStatus();
  if (status.open) throw new Error("Codex가 실행 중입니다. Codex를 완전히 종료한 뒤 다시 시도하세요.");
  return status;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageMetadata() {
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
    return {
      name: parsed.name || "codex-session-manager",
      version: parsed.version || "0.0.0",
    };
  } catch {
    return { name: "codex-session-manager", version: "0.0.0" };
  }
}

async function readUpdateState() {
  try {
    return JSON.parse(await readFile(UPDATE_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeUpdateState(state) {
  await writeFile(UPDATE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function getUpdateNotice() {
  const state = await readUpdateState();
  if (!state.updatedAt) return { show: false, currentVersion: APP_PACKAGE.version };
  const stateVersion = normalizeVersion(state.version || "");
  const currentVersion = APP_PACKAGE.version;
  const sameInstalledVersion = !stateVersion || stateVersion === currentVersion || state.source === "branch";
  const alreadyShown = state.noticeShownFor === currentVersion;
  return {
    show: sameInstalledVersion && !alreadyShown,
    currentVersion,
    label: state.label || `v${currentVersion}`,
    source: state.source || "",
    updatedAt: state.updatedAt || "",
  };
}

async function markUpdateNoticeRead() {
  const state = await readUpdateState();
  if (!state.updatedAt) return { ok: true, changed: false };
  await writeUpdateState({
    ...state,
    noticeShownFor: APP_PACKAGE.version,
    noticeShownAt: new Date().toISOString(),
  });
  return { ok: true, changed: true };
}

function updateHeaders() {
  const headers = {
    "accept": "application/vnd.github+json",
    "user-agent": `${APP_PACKAGE.name}/${APP_PACKAGE.version}`,
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}${path}`, {
    headers: updateHeaders(),
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

function normalizeVersion(value) {
  return String(value || "0.0.0").trim().replace(/^v/i, "");
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function releaseAsset(release) {
  return (release?.assets || []).find((asset) => asset.name === UPDATE_ASSET_NAME) || null;
}

async function releaseUpdateCandidate() {
  const release = await githubJson("/releases/latest");
  if (!release || release.draft || release.prerelease) return null;
  const asset = releaseAsset(release);
  if (!asset) {
    return {
      source: "release",
      available: false,
      reason: `${UPDATE_ASSET_NAME} 릴리스 asset을 찾을 수 없습니다.`,
      latestVersion: normalizeVersion(release.tag_name),
      releaseUrl: release.html_url,
      publishedAt: release.published_at,
    };
  }
  const latestVersion = normalizeVersion(release.tag_name);
  const available = compareVersions(latestVersion, APP_PACKAGE.version) > 0;
  return {
    source: "release",
    available,
    currentVersion: APP_PACKAGE.version,
    latestVersion,
    label: `v${latestVersion}`,
    downloadUrl: asset.browser_download_url,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    assetName: asset.name,
    reason: available ? "" : "현재 버전이 최신 릴리스와 같거나 더 높습니다.",
  };
}

async function releaseRedirectUpdateCandidate() {
  const latestUrl = `https://github.com/${UPDATE_REPO}/releases/latest`;
  const response = await fetch(latestUrl, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
  });
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location") || "";
  const match = location.match(/\/releases\/tag\/([^/?#]+)/);
  if (!match) return null;
  const tagName = decodeURIComponent(match[1]);
  const latestVersion = normalizeVersion(tagName);
  const downloadUrl = `https://github.com/${UPDATE_REPO}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(UPDATE_ASSET_NAME)}`;
  const assetResponse = await fetch(downloadUrl, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
  });
  if (assetResponse.status === 404) {
    return {
      source: "release",
      available: false,
      reason: `${UPDATE_ASSET_NAME} 릴리스 asset을 찾을 수 없습니다.`,
      latestVersion,
      releaseUrl: location,
    };
  }
  if (!assetResponse.ok && ![301, 302, 303, 307, 308].includes(assetResponse.status)) return null;
  const available = compareVersions(latestVersion, APP_PACKAGE.version) > 0;
  return {
    source: "release",
    available,
    currentVersion: APP_PACKAGE.version,
    latestVersion,
    label: tagName.startsWith("v") ? tagName : `v${latestVersion}`,
    downloadUrl,
    releaseUrl: location,
    publishedAt: null,
    assetName: UPDATE_ASSET_NAME,
    reason: available ? "" : "현재 버전이 최신 릴리스와 같거나 더 높습니다.",
  };
}

async function branchUpdateCandidate() {
  const repo = await githubJson("");
  if (!repo) return null;
  const branchName = UPDATE_BRANCH || repo.default_branch || "main";
  const branch = await githubJson(`/branches/${encodeURIComponent(branchName)}`);
  if (!branch?.commit?.sha) return null;
  const updateState = await readUpdateState();
  const latestRevision = branch.commit.sha;
  const currentRevision = updateState.revision || "";
  const available = currentRevision !== latestRevision;
  return {
    source: "branch",
    available,
    currentVersion: APP_PACKAGE.version,
    currentRevision,
    latestRevision,
    label: `${branchName}@${latestRevision.slice(0, 7)}`,
    downloadUrl: `https://github.com/${UPDATE_REPO}/archive/refs/heads/${encodeURIComponent(branchName)}.zip`,
    releaseUrl: `https://github.com/${UPDATE_REPO}/tree/${encodeURIComponent(branchName)}`,
    publishedAt: branch.commit.commit?.committer?.date || null,
    assetName: `${branchName}.zip`,
    reason: available ? "" : "현재 브랜치 리비전이 최신입니다.",
  };
}

async function getUpdateStatus() {
  const base = {
    repo: UPDATE_REPO,
    assetName: UPDATE_ASSET_NAME,
    currentVersion: APP_PACKAGE.version,
  };
  try {
    const release = await releaseUpdateCandidate();
    if (release?.available || release?.source === "release") return { ...base, ...release };
    const branch = await branchUpdateCandidate();
    if (branch) return { ...base, ...branch };
    return { ...base, available: false, reason: "업데이트 소스를 찾을 수 없습니다." };
  } catch (error) {
    const fallbackRelease = await releaseRedirectUpdateCandidate().catch(() => null);
    if (fallbackRelease) return { ...base, ...fallbackRelease, checkedBy: "release-redirect" };
    const message =
      error?.name === "TimeoutError" || /timeout/i.test(error?.message || "")
        ? "업데이트 서버 응답 시간이 초과되었습니다."
        : /GitHub API 5\d\d/.test(error?.message || "")
          ? "GitHub API가 일시적으로 응답하지 않습니다."
        : error.message;
    return { ...base, available: false, error: message };
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function downloadUpdateZip(candidate) {
  await mkdir(UPDATE_WORK_DIR, { recursive: true });
  const zipPath = join(UPDATE_WORK_DIR, `codex-session-manager-update-${timestampSlug()}.zip`);
  const response = await fetch(candidate.downloadUrl, {
    headers: updateHeaders(),
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`업데이트 다운로드 실패 ${response.status}`);
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  return zipPath;
}

function updateRunnerScript({ zipPath, candidate }) {
  const updateState = {
    source: candidate.source,
    label: candidate.label,
    version: candidate.latestVersion || APP_PACKAGE.version,
    revision: candidate.latestRevision || "",
    updatedAt: new Date().toISOString(),
  };
  return `#!/bin/sh
set -eu
APP_DIR=${shellQuote(__dirname)}
ZIP_PATH=${shellQuote(zipPath)}
SERVER_PID=${shellQuote(process.pid)}
PORT=${shellQuote(PORT)}
UPDATE_STATE=${shellQuote(UPDATE_STATE_PATH)}
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S).log"
cleanup_update_work() {
  rm -f "$ZIP_PATH"
  rm -f "$0"
  find "$APP_DIR/updates" -maxdepth 1 -type d -name 'extract.*' -exec rm -rf {} + 2>/dev/null || true
  find "$APP_DIR/updates" -maxdepth 1 -type d -name 'backup-*' -exec rm -rf {} + 2>/dev/null || true
  find "$APP_DIR/updates" -maxdepth 1 -type f -name 'codex-session-manager-update-*.zip' -delete 2>/dev/null || true
  find "$APP_DIR/updates" -maxdepth 1 -type f -name 'run-update-*.sh' -delete 2>/dev/null || true
}
{
  echo "Codex Session Manager update start: $(date)"
  echo "Source: ${candidate.source} ${candidate.label || ""}"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      sleep 0.25
    else
      break
    fi
  done
  TMP_DIR="$(mktemp -d "$APP_DIR/updates/extract.XXXXXX")"
  unzip -q "$ZIP_PATH" -d "$TMP_DIR"
  SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 2 -type f -name package.json -print | while IFS= read -r package_file; do
    candidate_dir="$(dirname "$package_file")"
    if [ -f "$candidate_dir/server.mjs" ] && [ -d "$candidate_dir/public" ]; then
      printf "%s\\n" "$candidate_dir"
      break
    fi
  done)"
  if [ -z "$SRC_DIR" ]; then
    echo "No application root found in update archive."
    exit 1
  fi
  BACKUP_DIR="$APP_DIR/updates/backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  for item in README.md package.json package-lock.json server.mjs start.command stop.command public docs; do
    if [ -e "$APP_DIR/$item" ]; then
      mv "$APP_DIR/$item" "$BACKUP_DIR/$item"
    fi
  done
  cp "$SRC_DIR/README.md" "$APP_DIR/README.md"
  cp "$SRC_DIR/package.json" "$APP_DIR/package.json"
  cp "$SRC_DIR/package-lock.json" "$APP_DIR/package-lock.json"
  cp "$SRC_DIR/server.mjs" "$APP_DIR/server.mjs"
  cp "$SRC_DIR/start.command" "$APP_DIR/start.command"
  cp "$SRC_DIR/stop.command" "$APP_DIR/stop.command"
  if [ -d "$SRC_DIR/docs" ]; then
    rm -rf "$APP_DIR/docs"
    cp -R "$SRC_DIR/docs" "$APP_DIR/docs"
  fi
  rm -rf "$APP_DIR/public"
  cp -R "$SRC_DIR/public" "$APP_DIR/public"
  chmod +x "$APP_DIR/start.command" || true
  chmod +x "$APP_DIR/stop.command" || true
  cat > "$UPDATE_STATE" <<'UPDATE_STATE_JSON'
${JSON.stringify(updateState, null, 2)}
UPDATE_STATE_JSON
  cleanup_update_work
  echo "Update complete. Update work files cleaned."
  if command -v npm >/dev/null 2>&1; then
    npm --prefix "$APP_DIR" install
    if command -v open >/dev/null 2>&1; then
      open "$APP_DIR/start.command" >/dev/null 2>&1 || true
    else
      echo "Update installed. Run start.command to restart the server."
    fi
  else
    echo "npm command not found; update installed but server was not restarted."
  fi
} >>"$LOG_FILE" 2>&1
`;
}

async function installUpdate() {
  const candidate = await getUpdateStatus();
  if (!candidate.available || !candidate.downloadUrl) {
    throw new Error(candidate.error || candidate.reason || "설치할 업데이트가 없습니다.");
  }
  const zipPath = await downloadUpdateZip(candidate);
  await mkdir(UPDATE_WORK_DIR, { recursive: true });
  const scriptPath = join(UPDATE_WORK_DIR, `run-update-${timestampSlug()}.sh`);
  await writeFile(scriptPath, updateRunnerScript({ zipPath, candidate }), "utf8");
  const child = spawn("sh", [scriptPath], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }, 200).unref();
  return {
    ok: true,
    source: candidate.source,
    label: candidate.label,
    message: "업데이트를 설치합니다. 서버가 종료된 뒤 자동으로 다시 시작됩니다.",
  };
}

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function existingDirectoryForPicker(path) {
  const resolved = resolve(expandHomePath(path || CODEX_HOME));
  const candidates = [resolved, dirname(resolved), CODEX_HOME, homedir()];
  for (const candidate of candidates) {
    const st = await stat(candidate).catch(() => null);
    if (st?.isDirectory()) return candidate;
  }
  return homedir();
}

async function selectPath(payload) {
  const kind = payload.kind === "file" ? "file" : "directory";
  const currentPath = String(payload.currentPath || "");
  const defaultDirectory = await existingDirectoryForPicker(currentPath);
  const prompt = kind === "file" ? "SQLite DB 파일을 선택하세요." : "폴더를 선택하세요.";
  const chooseLine =
    kind === "file"
      ? `choose file with prompt "${appleScriptString(prompt)}" default location defaultLocation`
      : `choose folder with prompt "${appleScriptString(prompt)}" default location defaultLocation`;
  const script = [
    `set defaultLocation to POSIX file "${appleScriptString(defaultDirectory)}"`,
    `set pickedPath to ${chooseLine}`,
    "POSIX path of pickedPath",
  ].join("\n");
  try {
    const stdout = await execFileText("osascript", ["-e", script]);
    const selectedPath = stdout.trim();
    return { canceled: false, path: kind === "directory" ? normalizeAbsolutePath(selectedPath) : selectedPath };
  } catch (error) {
    const message = `${error.stderr || ""}\n${error.message || ""}`;
    if (message.includes("User canceled") || message.includes("사용자가 취소") || message.includes("(-128)") || error.code === 1) {
      return { canceled: true };
    }
    throw error;
  }
}

function normalizeAbsolutePath(value) {
  const textValue = expandHomePath(value);
  if (!String(textValue || "").startsWith("/")) return String(textValue || "").trim();
  return resolve(textValue);
}

function pathMatchVariants(value) {
  const textValue = String(value || "").trim();
  const normalized = normalizeAbsolutePath(textValue);
  const variants = [textValue, normalized];
  if (normalized && normalized !== "/") variants.push(`${normalized}/`);
  return [...new Set(variants.filter((item) => item.startsWith("/")))];
}

async function* walk(dir) {
  if (!(await exists(dir))) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function readJsonlMeta(path) {
  const file = await open(path, "r");
  try {
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(16 * 1024);
    while (total < 1024 * 1024) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(10);
      if (newlineIndex !== -1) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += bytesRead;
    }
    const firstLine = Buffer.concat(chunks).toString("utf8").trim();
    return firstLine ? JSON.parse(firstLine) : null;
  } finally {
    await file.close();
  }
}

async function loadThreads() {
  if (!(await exists(STATE_DB))) return [];
  const stdout = await sqlite([
    "-json",
    STATE_DB,
    `select id, rollout_path, created_at_ms, updated_at_ms, source, cwd, title, archived, git_sha, git_branch, first_user_message, thread_source, agent_nickname, agent_role, preview from threads order by updated_at_ms desc`,
  ]);
  return JSON.parse(stdout || "[]");
}

async function loadSpawnEdges() {
  if (!(await exists(STATE_DB))) return [];
  try {
    const stdout = await sqlite([
      "-json",
      STATE_DB,
      `select parent_thread_id as parentId, child_thread_id as childId, status from thread_spawn_edges`,
    ]);
    return JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
}

async function loadIndex() {
  if (!(await exists(SESSION_INDEX))) return [];
  const rows = [];
  for (const line of (await readFile(SESSION_INDEX, "utf8")).split("\n")) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function sessionFileRoots() {
  return [...new Set([SESSIONS_ROOT, ARCHIVED_SESSIONS_ROOT].map((path) => resolve(path)))];
}

function isManagedSessionFilePath(filePath) {
  const resolved = resolve(filePath);
  return sessionFileRoots().some((root) => isInside(resolved, root));
}

function backupPathForSessionFile(backupDir, filePath) {
  return join(backupDir, relative(CODEX_HOME, filePath));
}

async function loadSessionFiles() {
  const files = [];
  for (const root of sessionFileRoots()) {
    for await (const path of walk(root)) {
      if (!path.endsWith(".jsonl")) continue;
      const name = basename(path);
      const st = await stat(path);
      let meta = null;
      let parseError = null;
      try {
        const first = await readJsonlMeta(path);
        meta = first?.type === "session_meta" ? first.payload : null;
      } catch (error) {
        parseError = error.message;
      }
      files.push({
        path,
        relativePath: relative(CODEX_HOME, path),
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        canonicalName: CANONICAL_ROLLOUT_RE.test(name),
        isBak: name.endsWith("_bak.jsonl"),
        parseError,
        id: meta?.id || null,
        cwd: meta?.cwd || null,
        threadSource: meta?.thread_source || null,
        parentThreadId: meta?.parent_thread_id || meta?.source?.subagent?.thread_spawn?.parent_thread_id || null,
        agentNickname: meta?.agent_nickname || meta?.source?.subagent?.thread_spawn?.agent_nickname || null,
        agentRole: meta?.agent_role || meta?.source?.subagent?.thread_spawn?.agent_role || null,
        source: typeof meta?.source === "string" ? meta.source : meta?.source ? "object" : null,
        gitBranch: meta?.git?.branch || null,
      });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function backupRelativePath(path) {
  const resolved = resolve(path);
  const resolvedBackupsRoot = resolve(BACKUPS_ROOT);
  if (isInside(resolved, resolvedBackupsRoot)) {
    const relativeToBackups = relative(resolvedBackupsRoot, resolved);
    return relativeToBackups ? `backups/${relativeToBackups}` : "backups";
  }
  return relative(CODEX_HOME, path);
}

async function loadBackups() {
  const entries = [];
  const backupContext = {
    indexMap: byId(await loadIndex()),
    threadMap: byId(await loadThreads()),
  };
  if (await exists(BACKUPS_ROOT)) {
    for (const entry of await readdir(BACKUPS_ROOT, { withFileTypes: true })) {
      const path = join(BACKUPS_ROOT, entry.name);
      const st = await stat(path);
      const type = entry.isDirectory() ? "backup-dir" : "backup-file";
      entries.push({
        type,
        name: entry.name,
        path,
        relativePath: backupRelativePath(path),
        description: await backupDescription(path, type, backupContext),
        size: st.size,
        mtimeMs: st.mtimeMs,
        deletable: isSafeBackupDeleteTarget(path, entry.isDirectory()),
        restorable: await backupRestoreStatus(path, type),
        chatTitles: await backupChatTitles(path, type, backupContext),
        originalStatus: await backupOriginalStatus(path, type),
      });
    }
  }
  for await (const path of walk(SESSIONS_ROOT)) {
    if (!path.endsWith("_bak.jsonl")) continue;
    const st = await stat(path);
    entries.push({
      type: "session-bak",
      name: basename(path),
      path,
      relativePath: relative(CODEX_HOME, path),
      description: await backupDescription(path, "session-bak", backupContext),
      size: st.size,
      mtimeMs: st.mtimeMs,
      deletable: true,
      restorable: await backupRestoreStatus(path, "session-bak"),
      chatTitles: await backupChatTitles(path, "session-bak", backupContext),
      originalStatus: await backupOriginalStatus(path, "session-bak"),
    });
  }
  const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted.map((entry, index) => ({ id: sorted.length - index, ...entry }));
}

function titleFromContext(id, context) {
  if (!id) return "";
  const index = context.indexMap.get(id)?.[0];
  if (index?.thread_name) return index.thread_name;
  const thread = context.threadMap.get(id)?.[0];
  return thread?.title || thread?.first_user_message || "";
}

async function backupIndexTitleMap(path) {
  const indexPath = join(path, "session_index.jsonl");
  const map = new Map();
  if (!(await exists(indexPath))) return map;
  for (const line of (await readFile(indexPath, "utf8")).split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.id && row.thread_name) map.set(row.id, row.thread_name);
    } catch {
      // Ignore malformed historical backup rows.
    }
  }
  return map;
}

async function backupChatTitles(path, type, context) {
  const titles = new Map();
  async function addById(id, preferredTitle = "") {
    if (!id || titles.has(id)) return;
    const title = preferredTitle || titleFromContext(id, context);
    if (title) titles.set(id, titleFromMessage(title, id));
  }
  async function addSessionFile(filePath) {
    const meta = await readSessionMetaIfExists(filePath);
    if (meta?.id) await addById(meta.id);
  }

  if (type === "session-bak") {
    await addSessionFile(path.replace(/_bak\.jsonl$/, ".jsonl"));
    if (titles.size === 0) await addSessionFile(path);
    return [...titles.values()];
  }

  if (type !== "backup-dir") return [];
  const manifestPath = join(path, "manifest.json");
  if (!(await exists(manifestPath))) {
    for (const filePath of await looseBackupSessionFiles(path)) await addSessionFile(filePath);
    return [...titles.values()];
  }
  const backupTitles = await backupIndexTitleMap(path);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const item of Array.isArray(manifest.changed) ? manifest.changed : []) {
      const preferredTitle = isContextOnlyMessage(item.next) ? "" : item.next || "";
      await addById(item.id, preferredTitle);
    }
    for (const id of Array.isArray(manifest.indexRowsAdded) ? manifest.indexRowsAdded : []) await addById(id, backupTitles.get(id));
    for (const id of Array.isArray(manifest.dbThreadsAdded) ? manifest.dbThreadsAdded : []) await addById(id, backupTitles.get(id));
    for (const id of Array.isArray(manifest.ids) ? manifest.ids : []) await addById(id, backupTitles.get(id));
    for (const original of Array.isArray(manifest.deletedFiles) ? manifest.deletedFiles : []) {
      const originalExists = await exists(original);
      const backupCopy = backupPathForSessionFile(path, original);
      const meta = await readSessionMetaIfExists(originalExists ? original : backupCopy);
      if (meta?.id) await addById(meta.id, backupTitles.get(meta.id));
    }
  } catch {
    return [];
  }
  return [...titles.values()];
}

async function backupDescription(path, type, context) {
  if (type === "session-bak") return { label: "세션 파일 백업", detail: `${basename(path)}의 원본 세션 파일 백업` };
  if (type !== "backup-dir") return { label: "백업 파일", detail: basename(path) };

  const name = basename(path);
  const manifest = await readManifest(path);
  if (name.includes("_before_restore_")) {
    const source = manifest?.restoreSource || "";
    const sourceTitles = source ? await backupChatTitles(source, "backup-dir", context) : [];
    const sourceName = source ? relative(CODEX_HOME, source) : "";
    return {
      label: "되돌리기 전 자동 백업",
      detail: sourceTitles.length > 0 ? `${sourceTitles.join(", ")} 되돌리기 전 상태` : sourceName ? `${sourceName} 되돌리기 전 상태` : "백업 되돌리기 전 현재 상태",
      sourcePath: source || null,
      sourceRelativePath: sourceName || null,
      sourceTitles,
    };
  }
  if (name.includes("_thread_repair_")) return { label: "채팅 복구 전 백업", detail: (await backupManifestTarget(manifest, context, path)) || "채팅 복구 전 상태" };
  if (name.includes("_auto_repair_")) return { label: "채팅 자동 복구 전 백업", detail: manifest?.project || "프로젝트 채팅 자동 복구 전 상태" };
  if (name.includes("_cwd_")) return { label: "CWD 변경 전 백업", detail: manifest?.from && manifest?.to ? `${manifest.from} -> ${manifest.to}` : "프로젝트 경로 변경 전 상태" };
  if (name.includes("_project_registration_")) {
    const target = manifest?.project || (await backupManifestTarget(manifest, context, path)) || "";
    return { label: "프로젝트 참조 복구 전 백업", detail: target ? `${basename(target)} 참조 복구` : "Codex 프로젝트 목록 등록 전 상태" };
  }
  if (name.includes("_remove_project_")) {
    const project = manifest?.project || "";
    const chatCount = Number(manifest?.chatCount || 0);
    const agentCount = Number(manifest?.agentCount || 0);
    const countText = chatCount || agentCount ? `채팅 ${chatCount}개, agent ${agentCount}개` : "빈 프로젝트";
    return { label: "프로젝트 제거 전 백업", detail: project ? `${project} 제거 (${countText})` : `프로젝트 제거 (${countText})` };
  }
  if (name.includes("_delete_")) {
    const target = await backupManifestTarget(manifest, context, path);
    return { label: "채팅 삭제 전 백업", detail: target ? `${target} 삭제` : "채팅 삭제 전 상태" };
  }
  if (name.includes("_fix_titles_")) return { label: "채팅 제목 보정 전 백업", detail: "채팅 제목 보정 전 상태" };
  if (name.includes("_config_project_")) return { label: "프로젝트 설정 변경 전 백업", detail: "config.toml" };
  if (name.includes("_state_5_cwd_migration_")) return { label: "SQLite CWD 마이그레이션 백업", detail: "state_5.sqlite CWD 값 마이그레이션 전 상태" };
  if (name.includes("_manual_cwd_mismatch_")) return { label: "수동 CWD 불일치 테스트 백업", detail: "CWD 불일치 테스트 전 상태" };
  return { label: "작업 전 백업", detail: `알 수 없는 작업 전 상태 (${name})` };
}

async function readManifest(path) {
  const manifestPath = join(path, "manifest.json");
  if (!(await exists(manifestPath))) return null;
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function backupManifestTarget(manifest, context, backupPath = null) {
  const ids = [
    manifest?.id,
    manifest?.requestedId,
    ...(Array.isArray(manifest?.ids) ? manifest.ids : []),
    ...(Array.isArray(manifest?.indexRowsAdded) ? manifest.indexRowsAdded : []),
    ...(Array.isArray(manifest?.dbThreadsAdded) ? manifest.dbThreadsAdded : []),
  ].filter(Boolean);
  const titles = [...new Set(ids.map((id) => titleFromContext(id, context)).filter(Boolean).map((title) => titleFromMessage(title, "")))];
  if (titles.length > 0) return titles.slice(0, 3).join(", ");
  if (backupPath) {
    const backupTitles = await backupChatTitles(backupPath, "backup-dir", context);
    if (backupTitles.length > 0) return backupTitles.slice(0, 3).join(", ");
  }
  if (manifest?.project) return manifest.project;
  if (ids.length > 0) return ids.slice(0, 3).join(", ");
  return "";
}

async function backupRestoreStatus(path, type) {
  if (type === "session-bak") {
    return { possible: path.endsWith("_bak.jsonl"), mode: "session-file" };
  }
  if (type !== "backup-dir") return { possible: false, reason: "unsupported-type" };
  const hasState = await exists(join(path, "state_5.sqlite"));
  const hasIndex = await exists(join(path, "session_index.jsonl"));
  const hasSessions = await exists(join(path, "sessions"));
  const hasArchivedSessions = await exists(join(path, "archived_sessions"));
  const hasConfig = await exists(join(path, "config.toml"));
  const looseSessionFiles = await looseBackupSessionFiles(path);
  return {
    possible: hasState || hasIndex || hasSessions || hasArchivedSessions || hasConfig || looseSessionFiles.length > 0,
    mode: "snapshot",
    restores: {
      stateDb: hasState,
      sessionIndex: hasIndex,
      sessions: hasSessions,
      archivedSessions: hasArchivedSessions,
      config: hasConfig,
      looseSessionFiles: looseSessionFiles.length,
    },
  };
}

async function looseBackupSessionFiles(path) {
  const files = [];
  for await (const filePath of walk(path)) {
    const rel = relative(path, filePath);
    if (!filePath.endsWith(".jsonl")) continue;
    if (rel === "session_index.jsonl" || rel.startsWith("sessions/") || rel.startsWith("archived_sessions/")) continue;
    files.push(filePath);
  }
  return files;
}

function sessionPathFromBackupFile(filePath, meta) {
  const date = new Date(meta?.timestamp || "");
  if (!Number.isNaN(date.getTime())) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return join(SESSIONS_ROOT, year, month, day, basename(filePath));
  }
  const match = basename(filePath).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (match) return join(SESSIONS_ROOT, match[1], match[2], match[3], basename(filePath));
  return join(SESSIONS_ROOT, basename(filePath));
}

async function backupOriginalStatus(path, type) {
  if (type === "session-bak") {
    const originalPath = path.replace(/_bak\.jsonl$/, ".jsonl");
    const originalExists = await exists(originalPath);
    const meta = await readSessionMetaIfExists(originalExists ? originalPath : path);
    return {
      kind: "single-file",
      originalPath,
      project: meta?.cwd || null,
      threadId: meta?.id || null,
      existing: originalExists ? 1 : 0,
      missing: originalExists ? 0 : 1,
      total: 1,
    };
  }

  if (type !== "backup-dir") return { kind: "unknown", total: 0, existing: 0, missing: 0 };

  const manifestPath = join(path, "manifest.json");
  if (!(await exists(manifestPath))) {
    if (await exists(join(path, "config.toml"))) {
      return {
        kind: "config-snapshot",
        total: 1,
        existing: (await exists(CODEX_CONFIG_TOML)) ? 1 : 0,
        missing: (await exists(CODEX_CONFIG_TOML)) ? 0 : 1,
      };
    }
    const looseFiles = await looseBackupSessionFiles(path);
    if (looseFiles.length === 0) return { kind: "unknown", total: 0, existing: 0, missing: 0 };
    let existing = 0;
    const projects = new Set();
    const threadIds = new Set();
    for (const filePath of looseFiles) {
      const meta = await readSessionMetaIfExists(filePath);
      const originalPath = sessionPathFromBackupFile(filePath, meta);
      if (await exists(originalPath)) existing += 1;
      if (meta?.cwd) projects.add(meta.cwd);
      if (meta?.id) threadIds.add(meta.id);
    }
    return {
      kind: "loose-session-files",
      total: looseFiles.length,
      existing,
      missing: looseFiles.length - existing,
      project: projects.size === 1 ? [...projects][0] : null,
      projects: [...projects],
      threadIds: [...threadIds],
    };
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const originals = Array.isArray(manifest.deletedFiles) ? manifest.deletedFiles : [];
    let existing = 0;
    const projects = new Set();
    const threadIds = new Set();
    for (const original of originals) {
      const originalExists = await exists(original);
      if (originalExists) existing += 1;
      const backupCopy = join(path, relative(CODEX_HOME, original));
      const meta = await readSessionMetaIfExists(originalExists ? original : backupCopy);
      if (meta?.cwd) projects.add(meta.cwd);
      if (meta?.id) threadIds.add(meta.id);
    }
    return {
      kind: "manifest",
      total: originals.length,
      existing,
      missing: originals.length - existing,
      project: projects.size === 1 ? [...projects][0] : null,
      projects: [...projects],
      threadIds: [...threadIds],
    };
  } catch {
    return { kind: "unknown", total: 0, existing: 0, missing: 0 };
  }
}

async function readSessionMetaIfExists(path) {
  if (!(await exists(path))) return null;
  try {
    const first = await readJsonlMeta(path);
    return first?.type === "session_meta" ? first.payload : null;
  } catch {
    return null;
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.text || item?.input_text || "")
    .filter(Boolean)
    .join("\n");
}

function isContextOnlyMessage(message) {
  const textValue = String(message || "").trim();
  return (
    textValue.startsWith("<environment_context>") ||
    textValue.startsWith("<developer_context>") ||
    textValue.startsWith("# Context from my IDE setup:") ||
    textValue.startsWith("# In app browser:") ||
    textValue.startsWith("# Browser comments:")
  );
}

function isDeveloperInstructionTitle(message) {
  const textValue = String(message || "").trim();
  return (
    (textValue.startsWith("In /Users/") && textValue.includes("Do not edit files")) ||
    (textValue.startsWith("In /Users/") && textValue.includes("Produce only")) ||
    textValue.startsWith("We need ")
  );
}

function shouldReplaceStoredTitle(message) {
  const textValue = String(message || "").trim();
  return !textValue || isContextOnlyMessage(textValue) || isDeveloperInstructionTitle(textValue);
}

function cleanUserMessageCandidate(message) {
  const textValue = String(message || "").trim();
  const requestMarker = "## My request for Codex:";
  if (textValue.includes(requestMarker)) {
    return textValue.slice(textValue.indexOf(requestMarker) + requestMarker.length).trim();
  }
  return textValue;
}

async function readSessionSummary(path) {
  const meta = await readSessionMetaIfExists(path);
  let firstUserMessage = "";
  let turnContext = null;
  let scanned = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      scanned += 1;
      if (scanned > 250) break;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!turnContext && row.type === "turn_context") turnContext = row.payload || null;
      if (!firstUserMessage && row.type === "event_msg" && row.payload?.type === "user_message") {
        const candidate = cleanUserMessageCandidate(row.payload.message);
        if (!isContextOnlyMessage(candidate)) firstUserMessage = candidate;
      }
      if (!firstUserMessage && row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
        const candidate = cleanUserMessageCandidate(contentText(row.payload.content));
        if (!isContextOnlyMessage(candidate)) firstUserMessage = candidate;
      }
      if (firstUserMessage && turnContext) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { meta, firstUserMessage, turnContext };
}

function byId(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.id) continue;
    if (!map.has(row.id)) map.set(row.id, []);
    map.get(row.id).push(row);
  }
  for (const values of map.values()) {
    values.sort((a, b) => rowUpdatedAtMs(b) - rowUpdatedAtMs(a));
  }
  return map;
}

function rowUpdatedAtMs(row) {
  if (Number.isFinite(Number(row?.updated_at_ms))) return Number(row.updated_at_ms);
  if (Number.isFinite(Number(row?.mtimeMs))) return Number(row.mtimeMs);
  if (row?.updated_at) {
    const time = Date.parse(row.updated_at);
    if (Number.isFinite(time)) return time;
  }
  if (Number.isFinite(Number(row?.updated_at))) return Number(row.updated_at) * 1000;
  return 0;
}

async function buildSummary() {
  const [threads, sessionFiles, indexRows, backups, spawnEdges, globalState, globalProjects, configProjects] = await Promise.all([
    loadThreads(),
    loadSessionFiles(),
    loadIndex(),
    loadBackups(),
    loadSpawnEdges(),
    loadCodexGlobalState(),
    loadGlobalProjects(),
    loadConfigProjects(),
  ]);
  const projectlessThreadIds = new Set(globalState["projectless-thread-ids"] || []);
  const globalProjectSet = new Set(globalProjects.map(normalizeAbsolutePath));
  const threadMap = byId(threads);
  const fileMap = byId(sessionFiles);
  const indexMap = byId(indexRows);
  const projectExistsCache = new Map();
  async function projectExists(project) {
    if (!project) return true;
    if (!projectExistsCache.has(project)) {
      const st = await stat(project).catch(() => null);
      projectExistsCache.set(project, Boolean(st?.isDirectory()));
    }
    return projectExistsCache.get(project);
  }
  const parentByChild = new Map();
  const childrenByParent = new Map();
  for (const edge of spawnEdges) {
    parentByChild.set(edge.childId, edge.parentId);
    if (!childrenByParent.has(edge.parentId)) childrenByParent.set(edge.parentId, []);
    childrenByParent.get(edge.parentId).push(edge.childId);
  }
  const ids = new Set([...threadMap.keys(), ...fileMap.keys(), ...indexMap.keys()]);
  const records = await Promise.all([...ids].map(async (id) => {
    const thread = threadMap.get(id)?.[0] || null;
    const files = fileMap.get(id) || [];
    const primaryFile = files.find((file) => file.canonicalName) || files[0] || null;
    const index = indexMap.get(id)?.[0] || null;
    const parentId = parentByChild.get(id) || primaryFile?.parentThreadId || null;
    const role = thread?.thread_source === "subagent" || primaryFile?.threadSource === "subagent" ? "agent" : "user";
    const project = thread?.cwd || primaryFile?.cwd || null;
    const projectless = projectlessThreadIds.has(id);
    const issues = [];
    if (!thread) issues.push("missing-db-thread");
    if (!primaryFile) issues.push("missing-session-file");
    if (thread && primaryFile && thread.cwd !== primaryFile.cwd) issues.push("cwd-mismatch");
    if (primaryFile && !primaryFile.canonicalName) issues.push("non-canonical-session-file");
    if (files.length > 1) issues.push("duplicate-session-files");
    if (thread && primaryFile && normalize(thread.rollout_path) !== normalize(primaryFile.path)) {
      issues.push("rollout-path-differs");
    }
    if (!index) issues.push("missing-session-index");
    if (!projectless && project && !(await projectExists(project))) issues.push("missing-project-path");
    if (!projectless && project && (await projectExists(project)) && !globalProjectSet.has(normalizeAbsolutePath(project))) {
      issues.push("missing-codex-project-registration");
    }
    return { id, role, project, projectless, parentId, thread, primaryFile, files, index, issues };
  }));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const groups = [];
  for (const record of records) {
    if (record.parentId) continue;
    const explicitChildren = childrenByParent.get(record.id) || [];
    const inferredChildren = records.filter((candidate) => candidate.parentId === record.id).map((candidate) => candidate.id);
    const childIds = [...new Set([...explicitChildren, ...inferredChildren])];
    const children = childIds
      .map((childId) => recordById.get(childId))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
        const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
        return bTime - aTime;
      });
    groups.push({ parent: record, children, projectless: record.projectless || children.some((child) => child.projectless) });
  }
  const orphanChildrenByParent = new Map();
  for (const record of records) {
    if (!record.parentId || recordById.has(record.parentId)) continue;
    if (!orphanChildrenByParent.has(record.parentId)) orphanChildrenByParent.set(record.parentId, []);
    orphanChildrenByParent.get(record.parentId).push(record);
  }
  for (const [missingParentId, children] of orphanChildrenByParent) {
    children.sort((a, b) => {
      const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
      const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
      return bTime - aTime;
    });
    groups.push({ parent: null, missingParentId, children, projectless: children.some((child) => child.projectless) });
  }
  const representedProjects = new Set();
  const projectlessProjects = new Set();
  for (const group of groups) {
    for (const record of [group.parent, ...group.children].filter(Boolean)) {
      if (record.projectless) {
        if (record.project) projectlessProjects.add(normalizeAbsolutePath(record.project));
        continue;
      }
      if (record.project) representedProjects.add(normalizeAbsolutePath(record.project));
    }
  }
  for (const project of [...new Set([...globalProjects, ...configProjects])].sort()) {
    if (!representedProjects.has(project) && !projectlessProjects.has(project)) {
      const projectIssues = [];
      if (!(await projectExists(project))) projectIssues.push("missing-project-path");
      if (!globalProjectSet.has(normalizeAbsolutePath(project))) projectIssues.push("missing-codex-project-registration");
      groups.push({ parent: null, children: [], project, emptyProject: true, projectIssues });
    }
  }
  groups.sort((a, b) => {
    if (a.emptyProject && b.emptyProject) return String(a.project).localeCompare(String(b.project));
    if (a.emptyProject) return 1;
    if (b.emptyProject) return -1;
    const aRecord = a.parent || a.children[0];
    const bRecord = b.parent || b.children[0];
    const aTime = aRecord?.thread?.updated_at_ms || aRecord?.primaryFile?.mtimeMs || 0;
    const bTime = bRecord?.thread?.updated_at_ms || bRecord?.primaryFile?.mtimeMs || 0;
    return bTime - aTime;
  });
  records.sort((a, b) => {
    const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
    const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
    return bTime - aTime;
  });
  const issueCounts = {};
  for (const record of records) {
    for (const issue of record.issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }
  return {
    codexHome: CODEX_HOME,
    codexHomeExists: await exists(CODEX_HOME),
    configPath: CONFIG_PATH,
    defaultCodexHome: DEFAULT_CODEX_HOME,
    stateDb: STATE_DB,
    stateDbExists: await exists(STATE_DB),
    sessionsRoot: SESSIONS_ROOT,
    sessionsRootExists: await exists(SESSIONS_ROOT),
    backupsRoot: BACKUPS_ROOT,
    backupsRootExists: await exists(BACKUPS_ROOT),
    generatedAt: new Date().toISOString(),
    counts: {
      threads: threads.length,
      sessionFiles: sessionFiles.length,
      indexRows: indexRows.length,
      records: records.length,
      backups: backups.length,
      spawnEdges: spawnEdges.length,
      groups: groups.length,
      projects: new Set([...globalProjects, ...configProjects.filter((project) => !projectlessProjects.has(project)), ...representedProjects]).size,
    },
    issueCounts,
    spawnEdges,
    groups,
    records,
    backups,
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

async function backupStateFiles(backupDir) {
  await mkdir(backupDir, { recursive: true });
  await backupFileIfExists(CODEX_CONFIG_TOML, join(backupDir, "config.toml"));
  await backupFileIfExists(CODEX_GLOBAL_STATE, join(backupDir, ".codex-global-state.json"));
  await backupFileIfExists(CODEX_GLOBAL_STATE_BAK, join(backupDir, ".codex-global-state.json.bak"));
  await backupFileIfExists(CODEX_CHAT_PROCESSES, join(backupDir, "process_manager", "chat_processes.json"));
  if (await exists(STATE_DB)) {
    await sqlite([STATE_DB, `.backup '${join(backupDir, "state_5.sqlite")}'`]);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${STATE_DB}${suffix}`;
    if (await exists(src)) {
      await cp(src, join(backupDir, basename(src)), { preserveTimestamps: true });
    }
  }
}

async function backupFileIfExists(src, dest) {
  if (!(await exists(src))) return false;
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { preserveTimestamps: true });
  return true;
}

function tomlProjectHeader(project) {
  return `[projects."${String(project).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

function unescapeTomlProjectName(value) {
  return String(value || "").replace(/\\(["\\])/g, "$1");
}

async function loadConfigProjects() {
  if (!(await exists(CODEX_CONFIG_TOML))) return [];
  const textContent = await readFile(CODEX_CONFIG_TOML, "utf8");
  const projects = [];
  const re = /^\[projects\."((?:\\.|[^"\\])*)"\]\s*$/gm;
  let match;
  while ((match = re.exec(textContent)) !== null) {
    const project = normalizeAbsolutePath(unescapeTomlProjectName(match[1]));
    if (project.startsWith("/")) projects.push(project);
  }
  return [...new Set(projects)];
}

async function ensureCodexProjectConfig(project) {
  if (!project || !(await exists(CODEX_CONFIG_TOML))) return { changed: false, reason: "missing-config" };
  const textContent = await readFile(CODEX_CONFIG_TOML, "utf8");
  const header = tomlProjectHeader(normalizeAbsolutePath(project));
  if (textContent.includes(header)) return { changed: false, reason: "already-present" };
  const addition = `\n${header}\ntrust_level = "trusted"\n`;
  await writeFile(CODEX_CONFIG_TOML, `${textContent.replace(/\s*$/, "")}\n${addition}`, "utf8");
  return { changed: true, project };
}

async function replaceCodexProjectConfig(fromValues, to) {
  if (!(await exists(CODEX_CONFIG_TOML))) return { changed: false, reason: "missing-config" };
  const normalizedTo = normalizeAbsolutePath(to);
  const toHeader = tomlProjectHeader(normalizedTo);
  const fromHeaders = new Set(fromValues.map((value) => tomlProjectHeader(value)).filter((header) => header !== toHeader));
  const lines = (await readFile(CODEX_CONFIG_TOML, "utf8")).split("\n");
  let hasToHeader = lines.some((line) => line.trim() === toHeader);
  let changed = false;
  const nextLines = [];
  let skippingOldBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) skippingOldBlock = false;
    if (fromHeaders.has(trimmed)) {
      changed = true;
      if (hasToHeader) {
        skippingOldBlock = true;
        continue;
      }
      nextLines.push(toHeader);
      hasToHeader = true;
      continue;
    }
    if (skippingOldBlock) continue;
    nextLines.push(line);
  }

  if (!hasToHeader) {
    nextLines.push("", toHeader, 'trust_level = "trusted"');
    changed = true;
  }

  if (changed) await writeFile(CODEX_CONFIG_TOML, `${nextLines.join("\n").replace(/\s*$/, "")}\n`, "utf8");
  return { changed, project: normalizedTo };
}

async function removeCodexProjectConfig(project) {
  if (!(await exists(CODEX_CONFIG_TOML))) return { changed: false, reason: "missing-config" };
  const targets = new Set(pathMatchVariants(project).map((value) => tomlProjectHeader(normalizeAbsolutePath(value))));
  const lines = (await readFile(CODEX_CONFIG_TOML, "utf8")).split("\n");
  const nextLines = [];
  let changed = false;
  let skippingBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) skippingBlock = false;
    if (targets.has(trimmed)) {
      changed = true;
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) continue;
    nextLines.push(line);
  }

  if (changed) await writeFile(CODEX_CONFIG_TOML, `${nextLines.join("\n").replace(/\s*$/, "")}\n`, "utf8");
  return { changed, project: normalizeAbsolutePath(project) };
}

function replaceProjectPathArray(values, fromSet, to) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  let changed = false;
  const next = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeAbsolutePath(value);
    const mapped = fromSet.has(normalized) || fromSet.has(String(value || "")) ? to : value;
    if (mapped !== value) changed = true;
    if (seen.has(mapped)) {
      changed = true;
      continue;
    }
    seen.add(mapped);
    next.push(mapped);
  }
  if (!seen.has(to) && values.some((value) => fromSet.has(normalizeAbsolutePath(value)) || fromSet.has(String(value || "")))) {
    next.push(to);
    changed = true;
  }
  return { value: next, changed };
}

function replaceProjectPathMapValues(map, fromSet, to) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && (fromSet.has(normalizeAbsolutePath(value)) || fromSet.has(value))) {
      next[key] = to;
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return { value: next, changed };
}

function replaceProjectPathMapKeys(map, fromSet, to) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    const mappedKey = fromSet.has(normalizeAbsolutePath(key)) || fromSet.has(key) ? to : key;
    if (mappedKey !== key) changed = true;
    next[mappedKey] = value;
  }
  return { value: next, changed };
}

function appendMissingProjectPathArray(values, project) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  const normalizedProject = normalizeAbsolutePath(project);
  if (values.some((value) => normalizeAbsolutePath(value) === normalizedProject || String(value || "") === normalizedProject)) {
    return { value: values, changed: false };
  }
  return { value: [...values, normalizedProject], changed: true };
}

function globalStateProjectCandidates(state) {
  const values = new Set();
  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    for (const value of state[key] || []) values.add(value);
  }
  const projectlessThreadIds = new Set(state["projectless-thread-ids"] || []);
  for (const [threadId, value] of Object.entries(state["thread-workspace-root-hints"] || {})) {
    if (!projectlessThreadIds.has(threadId)) values.add(value);
  }
  for (const key of Object.keys(state["electron-workspace-root-labels"] || {})) values.add(key);
  return [...values].filter((value) => typeof value === "string" && value.startsWith("/"));
}

async function loadCodexGlobalState() {
  if (!(await exists(CODEX_GLOBAL_STATE))) return {};
  return JSON.parse(await readFile(CODEX_GLOBAL_STATE, "utf8"));
}

async function loadGlobalProjects() {
  const state = await loadCodexGlobalState();
  return [...new Set(globalStateProjectCandidates(state).map(normalizeAbsolutePath))];
}

function isLikelyPreviousProjectPath(candidate, currentPaths) {
  const normalizedCandidate = normalizeAbsolutePath(candidate);
  const candidateBase = basename(normalizedCandidate);
  if (!candidateBase) return false;
  return currentPaths.some((currentPath) => {
    const normalizedCurrent = normalizeAbsolutePath(currentPath);
    if (normalizedCurrent === normalizedCandidate) return false;
    if (dirname(normalizedCurrent) !== dirname(normalizedCandidate)) return false;
    const currentBase = basename(normalizedCurrent);
    if (currentBase.startsWith(`${candidateBase}-`) || currentBase.startsWith(`${candidateBase}_`)) return true;
    if (!currentBase.startsWith(candidateBase)) return false;
    return /^\d+$/.test(currentBase.slice(candidateBase.length));
  });
}

async function replaceCodexProjectGlobalStateFile(filePath, fromValues, to, options = {}) {
  if (!(await exists(filePath))) return { changed: false, reason: "missing-global-state" };
  const normalizedTo = normalizeAbsolutePath(to);
  const state = JSON.parse(await readFile(filePath, "utf8"));
  const normalizedFromValues = fromValues.flatMap(pathMatchVariants).map(normalizeAbsolutePath);
  const inferredAliases = globalStateProjectCandidates(state).filter((candidate) => isLikelyPreviousProjectPath(candidate, normalizedFromValues));
  const fromSet = new Set([...normalizedFromValues, ...inferredAliases.flatMap(pathMatchVariants).map(normalizeAbsolutePath)]);
  let changed = false;

  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    const result = replaceProjectPathArray(state[key], fromSet, normalizedTo);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  for (const key of ["thread-workspace-root-hints"]) {
    const result = replaceProjectPathMapValues(state[key], fromSet, normalizedTo);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  for (const key of ["electron-workspace-root-labels"]) {
    const result = replaceProjectPathMapKeys(state[key], fromSet, normalizedTo);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  let ensured = false;
  if (options.ensureProject) {
    for (const key of ["project-order", "electron-saved-workspace-roots"]) {
      const result = appendMissingProjectPathArray(state[key], normalizedTo);
      state[key] = result.value;
      changed = changed || result.changed;
      ensured = ensured || result.changed;
    }
  }

  if (changed) await writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
  return { changed, project: normalizedTo, inferredAliases, ensured };
}

async function replaceCodexProjectGlobalState(fromValues, to, options = {}) {
  const primary = await replaceCodexProjectGlobalStateFile(CODEX_GLOBAL_STATE, fromValues, to, options);
  const backup = await replaceCodexProjectGlobalStateFile(CODEX_GLOBAL_STATE_BAK, fromValues, to, options);
  return {
    changed: primary.changed || backup.changed,
    project: normalizeAbsolutePath(to),
    files: {
      globalState: primary,
      globalStateBackup: backup,
    },
  };
}

async function replaceCodexChatProcesses(fromValues, to) {
  if (!(await exists(CODEX_CHAT_PROCESSES))) return { changed: false, reason: "missing-chat-processes" };
  const normalizedTo = normalizeAbsolutePath(to);
  const fromSet = new Set(fromValues.flatMap(pathMatchVariants).map(normalizeAbsolutePath));
  const processes = JSON.parse(await readFile(CODEX_CHAT_PROCESSES, "utf8"));
  if (!Array.isArray(processes)) return { changed: false, reason: "invalid-chat-processes" };
  let changed = false;
  let entriesChanged = 0;
  for (const entry of processes) {
    if (!entry || typeof entry !== "object" || typeof entry.cwd !== "string") continue;
    if (!fromSet.has(normalizeAbsolutePath(entry.cwd))) continue;
    entry.cwd = normalizedTo;
    changed = true;
    entriesChanged += 1;
  }
  if (changed) await writeFile(CODEX_CHAT_PROCESSES, `${JSON.stringify(processes, null, 2)}\n`, "utf8");
  return { changed, entriesChanged, path: CODEX_CHAT_PROCESSES };
}

function removeProjectPathArray(values, targetSet) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  const next = values.filter((value) => !targetSet.has(normalizeAbsolutePath(value)) && !targetSet.has(String(value || "")));
  return { value: next, changed: next.length !== values.length };
}

function removeProjectPathMapValues(map, targetSet) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && (targetSet.has(normalizeAbsolutePath(value)) || targetSet.has(value))) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return { value: next, changed };
}

function removeProjectPathMapKeys(map, targetSet) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (targetSet.has(normalizeAbsolutePath(key)) || targetSet.has(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return { value: next, changed };
}

async function removeCodexProjectGlobalStateFile(filePath, project) {
  if (!(await exists(filePath))) return { changed: false, reason: "missing-global-state" };
  const state = JSON.parse(await readFile(filePath, "utf8"));
  const targetSet = new Set(pathMatchVariants(project).map(normalizeAbsolutePath));
  let changed = false;

  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    const result = removeProjectPathArray(state[key], targetSet);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  for (const key of ["thread-workspace-root-hints"]) {
    const result = removeProjectPathMapValues(state[key], targetSet);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  for (const key of ["electron-workspace-root-labels"]) {
    const result = removeProjectPathMapKeys(state[key], targetSet);
    state[key] = result.value;
    changed = changed || result.changed;
  }

  if (changed) await writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
  return { changed, project: normalizeAbsolutePath(project) };
}

async function removeCodexProjectGlobalState(project) {
  const primary = await removeCodexProjectGlobalStateFile(CODEX_GLOBAL_STATE, project);
  const backup = await removeCodexProjectGlobalStateFile(CODEX_GLOBAL_STATE_BAK, project);
  return {
    changed: primary.changed || backup.changed,
    project: normalizeAbsolutePath(project),
    files: {
      globalState: primary,
      globalStateBackup: backup,
    },
  };
}

function titleFromMessage(message, fallback) {
  const textValue = cleanUserMessageCandidate(message).replace(/\s+/g, " ").trim();
  if (shouldReplaceStoredTitle(textValue)) return fallback;
  if (!textValue) return fallback;
  return textValue.length > 120 ? `${textValue.slice(0, 117)}...` : textValue;
}

function isoFromMs(ms) {
  return new Date(ms || Date.now()).toISOString();
}

async function appendMissingIndexRows(records) {
  if (records.length === 0) return [];
  const existing = new Set((await loadIndex()).map((row) => row.id));
  const rows = [];
  for (const record of records) {
    if (!record.primaryFile || existing.has(record.id)) continue;
    const summary = await readSessionSummary(record.primaryFile.path);
    const updatedAt = record.thread?.updated_at_ms || record.primaryFile.mtimeMs || Date.now();
    rows.push({
      id: record.id,
      thread_name: titleFromMessage(summary.firstUserMessage, basename(record.primaryFile.path)),
      updated_at: isoFromMs(updatedAt),
    });
    existing.add(record.id);
  }
  if (rows.length > 0) {
    await mkdir(dirname(SESSION_INDEX), { recursive: true });
    const suffix = rows.map((row) => JSON.stringify(row)).join("\n");
    const prefix = (await exists(SESSION_INDEX)) && (await stat(SESSION_INDEX)).size > 0 ? "\n" : "";
    await writeFile(SESSION_INDEX, `${prefix}${suffix}\n`, { encoding: "utf8", flag: "a" });
  }
  return rows;
}

function sqlNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

async function insertMissingDbThreads(records) {
  if (records.length === 0 || !(await exists(STATE_DB))) return [];
  const inserted = [];
  const statements = [".timeout 5000", "begin immediate;"];
  for (const record of records) {
    if (!record.primaryFile || record.thread) continue;
    const summary = await readSessionSummary(record.primaryFile.path);
    const meta = summary.meta || {};
    const turnContext = summary.turnContext || {};
    const createdMs = Date.parse(meta.timestamp || "") || record.primaryFile.mtimeMs || Date.now();
    const updatedMs = record.primaryFile.mtimeMs || createdMs;
    const created = Math.floor(createdMs / 1000);
    const updated = Math.floor(updatedMs / 1000);
    const firstUserMessage = summary.firstUserMessage || "";
    const title = titleFromMessage(firstUserMessage, basename(record.primaryFile.path));
    const source = typeof meta.source === "string" ? meta.source : "vscode";
    const threadSource = meta.thread_source || turnContext.thread_source || "user";
    const gitBranch = meta.git?.branch || record.primaryFile.gitBranch || "";
    const values = [
      sqlString(record.id),
      sqlString(record.primaryFile.path),
      sqlNumber(created),
      sqlNumber(updated),
      sqlString(source),
      sqlString(meta.model_provider || "openai"),
      sqlString(meta.cwd || record.primaryFile.cwd || ""),
      sqlString(title),
      sqlString(JSON.stringify(turnContext.sandbox_policy || { type: "danger-full-access" })),
      sqlString(turnContext.approval_policy || "never"),
      sqlString(meta.cli_version || ""),
      sqlString(firstUserMessage),
      meta.agent_nickname ? sqlString(meta.agent_nickname) : "null",
      meta.agent_role ? sqlString(meta.agent_role) : "null",
      sqlString(gitBranch),
      sqlNumber(createdMs),
      sqlNumber(updatedMs),
      sqlString(threadSource),
      sqlString(firstUserMessage),
    ];
    statements.push(
      `insert or ignore into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, first_user_message, agent_nickname, agent_role, git_branch, created_at_ms, updated_at_ms, thread_source, preview) values (${values.join(",")});`,
    );
    statements.push("select changes();");
    inserted.push(record.id);
  }
  if (inserted.length === 0) return [];
  statements.push("commit;", "pragma integrity_check;");
  const output = await sqlite([STATE_DB], { input: statements.join("\n") });
  if (!output.trim().split("\n").includes("ok")) throw new Error(`sqlite integrity check failed: ${output}`);
  return inserted;
}

async function repairProjectChats(payload) {
  const project = String(payload.project || "");
  if (!project) throw new Error("project required");
  const summary = await buildSummary();
  const records = summary.records.filter((record) => (record.project || "(프로젝트 없음)") === project);
  const indexRecords = records.filter((record) => record.primaryFile && record.issues.includes("missing-session-index"));
  const dbRecords = records.filter((record) => record.primaryFile && record.issues.includes("missing-db-thread"));
  if (indexRecords.length === 0 && dbRecords.length === 0) {
    return { project, backupDir: null, indexRowsAdded: [], dbThreadsAdded: [], skipped: records.length };
  }

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_auto_repair_${timestampSlug()}`);
  await backupStateFiles(backupDir);
  await backupFileIfExists(SESSION_INDEX, join(backupDir, "session_index.jsonl"));

  const indexRowsAdded = await appendMissingIndexRows(indexRecords);
  const dbThreadsAdded = await insertMissingDbThreads(dbRecords);
  const manifest = {
    createdAt: new Date().toISOString(),
    project,
    repairedIssues: ["missing-session-index", "missing-db-thread"],
    indexRowsAdded: indexRowsAdded.map((row) => row.id),
    dbThreadsAdded,
    skippedIssueTypes: ["missing-session-file", "missing-project-path"],
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { project, backupDir, indexRowsAdded, dbThreadsAdded };
}

async function repairThreadChat(payload) {
  const id = String(payload.id || "");
  if (!new RegExp(`^${UUID_RE}$`).test(id)) {
    throw new Error("invalid thread id");
  }
  const summary = await buildSummary();
  const record = summary.records.find((candidate) => candidate.id === id);
  if (!record) throw new Error("thread not found");
  if (!record.primaryFile) throw new Error("session file required for repair");

  const indexRecords = record.issues.includes("missing-session-index") ? [record] : [];
  const dbRecords = record.issues.includes("missing-db-thread") ? [record] : [];
  if (indexRecords.length === 0 && dbRecords.length === 0) {
    return { id, backupDir: null, indexRowsAdded: [], dbThreadsAdded: [] };
  }

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_thread_repair_${timestampSlug()}_${id}`);
  await backupStateFiles(backupDir);
  await backupFileIfExists(SESSION_INDEX, join(backupDir, "session_index.jsonl"));

  const indexRowsAdded = await appendMissingIndexRows(indexRecords);
  const dbThreadsAdded = await insertMissingDbThreads(dbRecords);
  const manifest = {
    createdAt: new Date().toISOString(),
    id,
    project: record.project,
    repairedIssues: [
      ...(indexRowsAdded.length ? ["missing-session-index"] : []),
      ...(dbThreadsAdded.length ? ["missing-db-thread"] : []),
    ],
    indexRowsAdded: indexRowsAdded.map((row) => row.id),
    dbThreadsAdded,
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { id, backupDir, indexRowsAdded, dbThreadsAdded };
}

async function fixStoredTitles(options = {}) {
  const createBackup = options.createBackup !== false;
  const summary = await buildSummary();
  const fixes = new Map();
  for (const record of summary.records) {
    if (!record.primaryFile) continue;
    const needsIndexFix = record.index && shouldReplaceStoredTitle(record.index.thread_name);
    const needsDbFix = record.thread && shouldReplaceStoredTitle(record.thread.title || record.thread.first_user_message || record.thread.preview);
    if (!needsIndexFix && !needsDbFix) continue;
    const sessionSummary = await readSessionSummary(record.primaryFile.path);
    const cleanTitle = titleFromMessage(sessionSummary.firstUserMessage, "");
    if (!cleanTitle || shouldReplaceStoredTitle(cleanTitle)) continue;
    fixes.set(record.id, {
      id: record.id,
      title: cleanTitle,
      message: sessionSummary.firstUserMessage || cleanTitle,
      index: needsIndexFix,
      db: needsDbFix,
      previousIndexTitle: record.index?.thread_name || "",
      previousDbTitle: record.thread?.title || "",
    });
  }

  if (fixes.size === 0) return { backupDir: null, fixedIndexRows: [], fixedDbThreads: [] };

  let backupDir = null;
  if (createBackup) {
    backupDir = join(BACKUPS_ROOT, `codex_session_manager_fix_titles_${timestampSlug()}`);
    await backupStateFiles(backupDir);
    await backupFileIfExists(SESSION_INDEX, join(backupDir, "session_index.jsonl"));
  }

  const fixedIndexRows = [];
  if (await exists(SESSION_INDEX)) {
    const lines = (await readFile(SESSION_INDEX, "utf8")).split("\n");
    const nextLines = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const fix = fixes.get(row.id);
        if (fix?.index && shouldReplaceStoredTitle(row.thread_name)) {
          row.thread_name = fix.title;
          fixedIndexRows.push(row.id);
        }
        nextLines.push(JSON.stringify(row));
      } catch {
        nextLines.push(line);
      }
    }
    await writeFile(SESSION_INDEX, `${nextLines.join("\n")}${nextLines.length ? "\n" : ""}`, "utf8");
  }

  const dbFixes = [...fixes.values()].filter((fix) => fix.db);
  if (dbFixes.length > 0 && (await exists(STATE_DB))) {
    const statements = [".timeout 5000", "begin immediate;"];
    for (const fix of dbFixes) {
      statements.push(
        `update threads set title = ${sqlString(fix.title)}, first_user_message = ${sqlString(fix.message)}, preview = ${sqlString(fix.message)} where id = ${sqlString(fix.id)};`,
      );
    }
    statements.push("commit;", "pragma integrity_check;");
    const output = await sqlite([STATE_DB], { input: statements.join("\n") });
    if (!output.trim().split("\n").includes("ok")) throw new Error(`sqlite integrity check failed: ${output}`);
  }

  const fixedDbThreads = dbFixes.map((fix) => fix.id);
  if (backupDir) {
    await writeFile(
      join(backupDir, "manifest.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          reason: "fix context-only chat titles",
          fixedIndexRows,
          fixedDbThreads,
          fixes: [...fixes.values()],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return { backupDir, fixedIndexRows, fixedDbThreads };
}

async function repairCwd(payload) {
  await assertCodexClosed();
  const from = String(payload.from || "").trim();
  const to = normalizeAbsolutePath(payload.to);
  const fromValues = pathMatchVariants(from).filter((value) => value !== to);
  const includeDb = payload.includeDb !== false;
  const includeJsonl = payload.includeJsonl !== false;
  if (!from.startsWith("/") || !to.startsWith("/") || fromValues.length === 0) {
    throw new Error("from/to must be different absolute paths");
  }

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_cwd_${timestampSlug()}`);
  await backupStateFiles(backupDir);

  const changedFiles = [];
  if (includeJsonl) {
    for (const root of sessionFileRoots()) {
      for await (const path of walk(root)) {
        if (!path.endsWith(".jsonl")) continue;
        const textContent = await readFile(path, "utf8");
        let next = textContent;
        let replacements = 0;
        for (const value of fromValues) {
          const needle = `"cwd":"${value}"`;
          replacements += next.split(needle).length - 1;
          next = next.split(needle).join(`"cwd":"${to}"`);
        }
        if (next === textContent) continue;
        const backupPath = backupPathForSessionFile(backupDir, path);
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, textContent, "utf8");
        await writeFile(path, next, "utf8");
        changedFiles.push({ path, replacements });
      }
    }
  }

  let dbChanges = 0;
  if (includeDb && (await exists(STATE_DB))) {
    const sql = [
      ".timeout 5000",
      "begin immediate;",
      `update threads set cwd = ${sqlString(to)} where cwd in (${fromValues.map(sqlString).join(",")});`,
      "select changes();",
      "commit;",
      "pragma integrity_check;",
    ].join("\n");
    const output = await sqlite([STATE_DB], { input: sql });
    const lines = output.trim().split("\n");
    dbChanges = Number(lines[0] || 0);
    if (!lines.includes("ok")) throw new Error(`sqlite integrity check failed: ${output}`);
  }

  const configProject = await replaceCodexProjectConfig(fromValues, to);
  const shouldEnsureGlobalProject = changedFiles.length > 0 || dbChanges > 0 || configProject.changed;
  const globalProject = await replaceCodexProjectGlobalState(fromValues, to, { ensureProject: shouldEnsureGlobalProject });
  const chatProcesses = await replaceCodexChatProcesses(fromValues, to);

  await writeFile(
    join(backupDir, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        from,
        fromValues,
        to,
        includeDb,
        includeJsonl,
        dbChanges,
        changedFiles,
        configProject,
        globalProject,
        chatProcesses,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { backupDir, from, fromValues, to, includeDb, includeJsonl, dbChanges, changedFiles, configProject, globalProject };
}

function validateProjectDirectoryName(name) {
  const value = String(name || "").trim();
  if (!value) throw new Error("new project name required");
  if (value === "." || value === "..") throw new Error("invalid project name");
  if (value.includes("/") || value.includes("\\")) throw new Error("project name must not contain path separators");
  if (value.includes(":")) throw new Error("project name must not contain ':'");
  return value;
}

async function renameProject(payload) {
  await assertCodexClosed();
  const from = normalizeAbsolutePath(payload.project);
  const newName = validateProjectDirectoryName(payload.newName);
  if (!from.startsWith("/")) throw new Error("project must be an absolute path");
  const fromStat = await stat(from).catch(() => null);
  if (!fromStat?.isDirectory()) throw new Error("project directory not found");
  const to = join(dirname(from), newName);
  if (to === from) throw new Error("new project name is unchanged");
  if (await exists(to)) throw new Error("target project directory already exists");

  await rename(from, to);
  const repair = await repairCwd({ from, to, includeJsonl: true, includeDb: true });
  return { from, to, repair };
}

async function moveProject(payload) {
  await assertCodexClosed();
  const from = normalizeAbsolutePath(payload.project);
  const parent = normalizeAbsolutePath(payload.parent);
  if (!from.startsWith("/") || !parent.startsWith("/")) throw new Error("project and parent must be absolute paths");
  const fromStat = await stat(from).catch(() => null);
  if (!fromStat?.isDirectory()) throw new Error("project directory not found");
  const parentStat = await stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error("target parent directory not found");
  const to = join(parent, basename(from));
  if (to === from) throw new Error("project path is unchanged");
  if (resolve(to).startsWith(`${resolve(from)}/`)) throw new Error("target path must not be inside the project directory");
  if (await exists(to)) throw new Error("target project directory already exists");

  await movePath(from, to);
  try {
    const repair = await repairCwd({ from, to, includeJsonl: true, includeDb: true });
    return { from, parent, to, repair };
  } catch (error) {
    try {
      await movePath(to, from);
    } catch (rollbackError) {
      throw new Error(`project moved to ${to}, but Codex references were not updated and rollback failed: ${rollbackError.message}`);
    }
    throw error;
  }
}

async function repairProjectRegistration(payload) {
  await assertCodexClosed();
  const project = normalizeAbsolutePath(payload.project);
  if (!project.startsWith("/") || !(await exists(project))) throw new Error("valid existing project path required");

  const summary = await buildSummary();
  const hasRecords = summary.records.some((record) => recordMatchesProject(record, project));
  const configProjects = await loadConfigProjects();
  const hasConfig = configProjects.some((candidate) => normalizeAbsolutePath(candidate) === project);
  if (!hasRecords && !hasConfig) throw new Error("project has no Codex session/config evidence");

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_project_registration_${timestampSlug()}`);
  await backupStateFiles(backupDir);
  const globalProject = await replaceCodexProjectGlobalState([project], project, { ensureProject: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    project,
    reason: "repair missing Codex project registration",
    hasRecords,
    hasConfig,
    globalProject,
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { backupDir, ...manifest };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function isSafeBackupDeleteTarget(path, isDirectoryHint = null) {
  const resolved = resolve(path);
  if (isInside(resolved, BACKUPS_ROOT) && relative(resolve(BACKUPS_ROOT), resolved) !== "") return true;
  if (isInside(resolved, SESSIONS_ROOT) && basename(resolved).endsWith("_bak.jsonl")) return true;
  if (isDirectoryHint === false && basename(resolved).endsWith("_bak.jsonl")) return true;
  return false;
}

async function deleteBackup(payload) {
  const target = String(payload.path || "");
  const resolved = resolve(target);
  if (!isSafeBackupDeleteTarget(resolved)) {
    throw new Error("refusing to delete non-backup target");
  }
  if (!(await exists(resolved))) {
    return { deleted: false, path: resolved, reason: "not-found" };
  }
  await rm(resolved, { recursive: true, force: false });
  return { deleted: true, path: resolved };
}

async function deleteBackups(payload) {
  const paths = Array.isArray(payload.paths) ? payload.paths.map(String) : [];
  if (paths.length === 0) throw new Error("paths required");
  const deleted = [];
  const skipped = [];
  for (const path of paths) {
    try {
      const result = await deleteBackup({ path });
      if (result.deleted) deleted.push(result.path);
      else skipped.push({ path: result.path, reason: result.reason || "not-deleted" });
    } catch (error) {
      skipped.push({ path, reason: error.message });
    }
  }
  return { deleted, skipped };
}

async function restoreBackup(payload) {
  const target = resolve(String(payload.path || ""));
  const st = await stat(target).catch(() => null);
  if (!st) throw new Error("backup not found");
  if (!isSafeBackupDeleteTarget(target, st.isDirectory())) {
    throw new Error("refusing to restore non-backup target");
  }

  const safetyBackupDir = join(BACKUPS_ROOT, `codex_session_manager_before_restore_${timestampSlug()}`);
  await mkdir(safetyBackupDir, { recursive: true });

  if (st.isFile()) {
    if (!target.endsWith("_bak.jsonl")) throw new Error("unsupported backup file");
    const originalPath = target.replace(/_bak\.jsonl$/, ".jsonl");
    await backupFileIfExists(originalPath, join(safetyBackupDir, "sessions", relative(SESSIONS_ROOT, originalPath)));
    await mkdir(dirname(originalPath), { recursive: true });
    await cp(target, originalPath, { preserveTimestamps: true });
    await writeFile(
      join(safetyBackupDir, "manifest.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), restoreSource: target, restoredFiles: [originalPath] }, null, 2),
      "utf8",
    );
    const titleFix = await fixStoredTitles({ createBackup: false });
    return { restored: true, path: target, safetyBackupDir, restoredFiles: [originalPath], titleFix };
  }

  const restorable = await backupRestoreStatus(target, "backup-dir");
  if (!restorable.possible) throw new Error("backup has no restorable files");
  const sourceManifest = await readManifest(target);
  await backupStateFiles(safetyBackupDir);
  await backupFileIfExists(SESSION_INDEX, join(safetyBackupDir, "session_index.jsonl"));
  await removeSessionFilesAbsentFromBackupSnapshot(target, sourceManifest, safetyBackupDir);

  const restoredFiles = [];
  const backupStateDb = join(target, "state_5.sqlite");
  if (await exists(backupStateDb)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${STATE_DB}${suffix}`, { force: true });
      const backupPart = `${backupStateDb}${suffix}`;
      if (await exists(backupPart)) {
        await cp(backupPart, `${STATE_DB}${suffix}`, { preserveTimestamps: true });
      }
    }
    restoredFiles.push(STATE_DB);
  }

  const backupConfigToml = join(target, "config.toml");
  if (await exists(backupConfigToml)) {
    await cp(backupConfigToml, CODEX_CONFIG_TOML, { preserveTimestamps: true });
    restoredFiles.push(CODEX_CONFIG_TOML);
  }

  const backupGlobalState = join(target, ".codex-global-state.json");
  if (await exists(backupGlobalState)) {
    await cp(backupGlobalState, CODEX_GLOBAL_STATE, { preserveTimestamps: true });
    restoredFiles.push(CODEX_GLOBAL_STATE);
  }

  const backupGlobalStateBak = join(target, ".codex-global-state.json.bak");
  if (await exists(backupGlobalStateBak)) {
    await cp(backupGlobalStateBak, CODEX_GLOBAL_STATE_BAK, { preserveTimestamps: true });
    restoredFiles.push(CODEX_GLOBAL_STATE_BAK);
  }

  const backupIndex = join(target, "session_index.jsonl");
  if (await exists(backupIndex)) {
    await mkdir(dirname(SESSION_INDEX), { recursive: true });
    await cp(backupIndex, SESSION_INDEX, { preserveTimestamps: true });
    restoredFiles.push(SESSION_INDEX);
  }

  for (const sessionDirName of ["sessions", "archived_sessions"]) {
    const backupSessionsRoot = join(target, sessionDirName);
    if (await exists(backupSessionsRoot)) {
      for await (const backupFile of walk(backupSessionsRoot)) {
        const dest = join(CODEX_HOME, sessionDirName, relative(backupSessionsRoot, backupFile));
        await backupFileIfExists(dest, backupPathForSessionFile(safetyBackupDir, dest));
        await mkdir(dirname(dest), { recursive: true });
        await cp(backupFile, dest, { preserveTimestamps: true });
        restoredFiles.push(dest);
      }
    }
  }

  for (const backupFile of await looseBackupSessionFiles(target)) {
    const meta = await readSessionMetaIfExists(backupFile);
    const dest = sessionPathFromBackupFile(backupFile, meta);
    await backupFileIfExists(dest, backupPathForSessionFile(safetyBackupDir, dest));
    await mkdir(dirname(dest), { recursive: true });
    await cp(backupFile, dest, { preserveTimestamps: true });
    restoredFiles.push(dest);
  }

  const prunedMissingSessionThreads = await pruneDbThreadsWithMissingSessionFiles();
  await writeFile(
    join(safetyBackupDir, "manifest.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), restoreSource: target, restoredFiles, prunedMissingSessionThreads }, null, 2),
    "utf8",
  );
  const titleFix = await fixStoredTitles({ createBackup: false });
  return { restored: true, path: target, safetyBackupDir, restoredFiles, titleFix };
}

async function deleteAllBackups() {
  const backups = await loadBackups();
  const deleted = [];
  const skipped = [];
  for (const backup of backups) {
    if (!backup.deletable || !isSafeBackupDeleteTarget(backup.path)) {
      skipped.push(backup.path);
      continue;
    }
    if (!(await exists(backup.path))) continue;
    await rm(backup.path, { recursive: true, force: false });
    deleted.push(backup.path);
  }
  return { deleted, skipped };
}

async function deleteUnknownOriginalBackups() {
  const backups = await loadBackups();
  const deleted = [];
  const skipped = [];
  for (const backup of backups) {
    if (!isUnknownOriginalBackup(backup)) continue;
    if (!backup.deletable || !isSafeBackupDeleteTarget(backup.path)) {
      skipped.push(backup.path);
      continue;
    }
    if (!(await exists(backup.path))) continue;
    await rm(backup.path, { recursive: true, force: false });
    deleted.push(backup.path);
  }
  return { deleted, skipped };
}

function isUnknownOriginalBackup(backup) {
  const status = backup.originalStatus;
  return (!status || status.kind === "unknown" || status.total === 0) && !backup.restorable?.possible;
}

async function removeSessionFilesAbsentFromBackupSnapshot(backupDir, manifest, safetyBackupDir) {
  const restoredFiles = Array.isArray(manifest?.restoredFiles) ? manifest.restoredFiles : [];
  for (const file of restoredFiles) {
    const sessionFile = resolve(String(file || ""));
    if (!isManagedSessionFilePath(sessionFile) || !sessionFile.endsWith(".jsonl")) continue;
    const snapshotFile = backupPathForSessionFile(backupDir, sessionFile);
    if (await exists(snapshotFile)) continue;
    if (!(await exists(sessionFile))) continue;
    await backupFileIfExists(sessionFile, backupPathForSessionFile(safetyBackupDir, sessionFile));
    await rm(sessionFile, { force: true });
  }
}

async function pruneDbThreadsWithMissingSessionFiles() {
  if (!(await exists(STATE_DB))) return { ids: [], dbThreadChanges: 0, dbEdgeChanges: 0, removedIndexRows: 0 };
  const output = await sqlite([STATE_DB], { input: ".mode tabs\nselect id, rollout_path from threads;" });
  const ids = [];
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const [id, rolloutPath] = line.split("\t");
    if (!id || !rolloutPath) continue;
    if (!(await exists(resolve(rolloutPath)))) ids.push(id);
  }
  if (ids.length === 0) return { ids, dbThreadChanges: 0, dbEdgeChanges: 0, removedIndexRows: 0 };

  const idList = ids.map(sqlString).join(",");
  const sql = [
    ".timeout 5000",
    "begin immediate;",
    `delete from thread_spawn_edges where parent_thread_id in (${idList}) or child_thread_id in (${idList});`,
    "select changes();",
    `delete from threads where id in (${idList});`,
    "select changes();",
    "commit;",
    "pragma integrity_check;",
  ].join("\n");
  const dbOutput = await sqlite([STATE_DB], { input: sql });
  const lines = dbOutput.trim().split("\n");
  const dbEdgeChanges = Number(lines[0] || 0);
  const dbThreadChanges = Number(lines[1] || 0);
  if (!lines.includes("ok")) throw new Error(`sqlite integrity check failed: ${dbOutput}`);

  let removedIndexRows = 0;
  const idSet = new Set(ids);
  if (await exists(SESSION_INDEX)) {
    const indexLines = (await readFile(SESSION_INDEX, "utf8")).split("\n");
    const kept = [];
    for (const line of indexLines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (idSet.has(row.id)) {
          removedIndexRows += 1;
          continue;
        }
      } catch {
        // Keep malformed historical rows.
      }
      kept.push(line);
    }
    await writeFile(SESSION_INDEX, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  }

  return { ids, dbThreadChanges, dbEdgeChanges, removedIndexRows };
}

async function deleteThread(payload) {
  const id = String(payload.id || "");
  const includeChildren = payload.includeChildren !== false;
  if (!new RegExp(`^${UUID_RE}$`).test(id)) {
    throw new Error("invalid thread id");
  }

  const summary = await buildSummary();
  const recordById = new Map(summary.records.map((record) => [record.id, record]));
  const group = summary.groups.find((candidate) => candidate.parent?.id === id);
  const ids = new Set([id]);
  if (includeChildren && group) {
    for (const child of group.children) ids.add(child.id);
  }

  const records = [...ids].map((targetId) => recordById.get(targetId)).filter(Boolean);
  if (records.length === 0) {
    throw new Error("thread not found");
  }

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_delete_${timestampSlug()}_${id}`);
  await mkdir(backupDir, { recursive: true });
  await backupStateFiles(backupDir);
  await backupFileIfExists(SESSION_INDEX, join(backupDir, "session_index.jsonl"));

  const deletedFiles = [];
  for (const record of records) {
    for (const file of record.files || []) {
      const filePath = resolve(file.path);
      if (!isManagedSessionFilePath(filePath) || !filePath.endsWith(".jsonl")) {
        throw new Error(`refusing to delete unexpected session file: ${filePath}`);
      }
      const backupPath = backupPathForSessionFile(backupDir, filePath);
      await backupFileIfExists(filePath, backupPath);
      await rm(filePath, { force: true });
      deletedFiles.push(filePath);
    }
  }

  let removedIndexRows = 0;
  if (await exists(SESSION_INDEX)) {
    const lines = (await readFile(SESSION_INDEX, "utf8")).split("\n");
    const kept = [];
    for (const line of lines) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        kept.push(line);
        continue;
      }
      if (ids.has(row.id)) {
        removedIndexRows += 1;
      } else {
        kept.push(line);
      }
    }
    await writeFile(SESSION_INDEX, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  }

  let dbThreadChanges = 0;
  let dbEdgeChanges = 0;
  if (await exists(STATE_DB)) {
    const idList = [...ids].map(sqlString).join(",");
    const sql = [
      ".timeout 5000",
      "begin immediate;",
      `delete from thread_spawn_edges where parent_thread_id in (${idList}) or child_thread_id in (${idList});`,
      "select changes();",
      `delete from threads where id in (${idList});`,
      "select changes();",
      "commit;",
      "pragma integrity_check;",
    ].join("\n");
    const output = await sqlite([STATE_DB], { input: sql });
    const lines = output.trim().split("\n");
    dbEdgeChanges = Number(lines[0] || 0);
    dbThreadChanges = Number(lines[1] || 0);
    if (!lines.includes("ok")) throw new Error(`sqlite integrity check failed: ${output}`);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    requestedId: id,
    includeChildren,
    ids: [...ids],
    deletedFiles,
    removedIndexRows,
    dbThreadChanges,
    dbEdgeChanges,
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { backupDir, ...manifest };
}

async function deleteThreads(payload) {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
  if (ids.length === 0) throw new Error("ids required");
  const results = [];
  for (const id of ids) {
    results.push(await deleteThread({ id, includeChildren: payload.includeChildren !== false }));
  }
  return { deletedCount: results.length, results };
}

function recordMatchesProject(record, project) {
  return normalizeAbsolutePath(record?.project || "") === normalizeAbsolutePath(project);
}

async function removeProject(payload) {
  await assertCodexClosed();
  const project = normalizeAbsolutePath(payload.project);
  if (!project.startsWith("/") || project === "(프로젝트 없음)") throw new Error("valid project path required");

  const summary = await buildSummary();
  const deleteIds = new Set();
  let chatCount = 0;
  let agentCount = 0;

  for (const group of summary.groups) {
    const parentMatches = recordMatchesProject(group.parent, project);
    const matchingChildren = group.children.filter((child) => recordMatchesProject(child, project));
    if (parentMatches) {
      deleteIds.add(group.parent.id);
      chatCount += 1;
      agentCount += group.children.length;
      continue;
    }
    for (const child of matchingChildren) {
      deleteIds.add(child.id);
      agentCount += 1;
    }
  }

  const deleteResult = deleteIds.size
    ? await deleteThreads({ ids: [...deleteIds], includeChildren: true })
    : { deletedCount: 0, results: [] };

  const backupDir = join(BACKUPS_ROOT, `codex_session_manager_remove_project_${timestampSlug()}`);
  await backupStateFiles(backupDir);
  const configProject = await removeCodexProjectConfig(project);
  const globalProject = await removeCodexProjectGlobalState(project);
  const manifest = {
    createdAt: new Date().toISOString(),
    reason: "remove project",
    project,
    chatCount,
    agentCount,
    deleteIds: [...deleteIds],
    deleteResult,
    configProject,
    globalProject,
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { backupDir, ...manifest };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const path = resolve(PUBLIC_DIR, `.${requested}`);
  if (!isInside(path, PUBLIC_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  const stream = createReadStream(path);
  stream.on("open", () => {
    res.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    stream.pipe(res);
  });
  stream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    text(res, 404, "Not found");
  });
}

const server = createServer(async (req, res) => {
  activeRequests += 1;
  res.once("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, await getConfig());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      json(res, 200, await saveConfig(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/select-path") {
      json(res, 200, await selectPath(await readRequestBody(req)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summary") {
      json(res, 200, await buildSummary());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/codex-status") {
      json(res, 200, await getCodexProcessStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/update-status") {
      json(res, 200, await getUpdateStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/update-notice") {
      json(res, 200, await getUpdateNotice());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      noteHeartbeat();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/update") {
      json(res, 200, await installUpdate());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/update-notice/read") {
      json(res, 200, await markUpdateNoticeRead());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      }, 50).unref();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/repair-cwd") {
      json(res, 200, await repairCwd(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rename-project") {
      json(res, 200, await renameProject(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/move-project") {
      json(res, 200, await moveProject(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/repair-project-registration") {
      json(res, 200, await repairProjectRegistration(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/repair-project-chats") {
      json(res, 200, await repairProjectChats(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/repair-thread-chat") {
      json(res, 200, await repairThreadChat(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/fix-titles") {
      json(res, 200, await fixStoredTitles());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-backup") {
      json(res, 200, await deleteBackup(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-backups") {
      json(res, 200, await deleteBackups(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/restore-backup") {
      json(res, 200, await restoreBackup(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-all-backups") {
      json(res, 200, await deleteAllBackups());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-unknown-original-backups") {
      json(res, 200, await deleteUnknownOriginalBackups());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-thread") {
      json(res, 200, await deleteThread(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete-threads") {
      json(res, 200, await deleteThreads(await readRequestBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/remove-project") {
      json(res, 200, await removeProject(await readRequestBody(req)));
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    text(res, 405, "Method not allowed");
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Codex session manager: http://127.0.0.1:${PORT}`);
  console.log(`CODEX_HOME=${CODEX_HOME}`);
  if (AUTO_SHUTDOWN) console.log(`Auto shutdown enabled: heartbeat timeout ${HEARTBEAT_TIMEOUT_MS}ms`);
  writePidFile();
});

process.on("exit", () => {
  try {
    rmSync(PID_PATH, { force: true });
  } catch {
    // Best effort cleanup only.
  }
});
process.on("SIGINT", () => {
  removePidFile().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  removePidFile().finally(() => process.exit(143));
});

if (AUTO_SHUTDOWN) {
  setInterval(() => {
    if (!heartbeatStarted) return;
    if (activeRequests > 0) return;
    if (Date.now() - lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS) return;
    console.log("Heartbeat stopped. Shutting down Codex session manager.");
    server.close(() => process.exit(0));
  }, 1000).unref();
}
