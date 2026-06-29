import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function windowsUpdateLauncherScript({ scriptPath, launchLogPath }) {
  return `@echo off
setlocal
>> ${cmdQuote(launchLogPath)} echo Codex Session Manager update launcher start: %DATE% %TIME%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${cmdQuote(scriptPath)} >> ${cmdQuote(launchLogPath)} 2>&1
set UPDATE_EXIT_CODE=%ERRORLEVEL%
>> ${cmdQuote(launchLogPath)} echo Codex Session Manager update launcher exit: %UPDATE_EXIT_CODE%
del "%~f0"
exit /b %UPDATE_EXIT_CODE%
`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

export function createUpdateService({
  appDir,
  packageMetadata,
  patchNotesDir,
  updateStatePath,
  updateWorkDir,
  updateRepo,
  updateAssetName,
  updateBranch,
  updateRequestTimeoutMs,
  testCurrentVersion = "",
  port,
}) {
  function currentAppVersion() {
    return normalizeVersion(testCurrentVersion || packageMetadata.version);
  }

  function currentLocalVersion() {
    return currentAppVersion();
  }

  async function readUpdateState() {
    try {
      return JSON.parse(await readFile(updateStatePath, "utf8"));
    } catch {
      return {};
    }
  }

  async function writeUpdateState(state) {
    await writeFile(updateStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  function releaseSortValue(fileName) {
    return normalizeVersion(fileName.replace(/\.md$/i, ""));
  }

  async function readPatchNotes(limit = 3) {
    const entries = await readdir(patchNotesDir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => compareVersions(releaseSortValue(b), releaseSortValue(a)));
    const selected = files.slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));
    return Promise.all(selected.map(async (fileName) => {
      const version = releaseSortValue(fileName);
      return {
        version,
        title: `${version} 업데이트 내용`,
        markdown: await readFile(join(patchNotesDir, fileName), "utf8"),
      };
    }));
  }

  async function getUpdateNotice() {
    const state = await readUpdateState();
    const currentVersion = await currentLocalVersion();
    if (!state.updatedAt) return { show: false, currentVersion };
    const stateVersion = normalizeVersion(state.version || "");
    const sameInstalledVersion = !stateVersion || stateVersion === currentVersion || state.source === "branch";
    const alreadyShown = state.noticeShownFor === currentVersion;
    const notes = currentVersion ? await readPatchNotes(10) : [];
    const currentNotes = notes.find((entry) => entry.version === currentVersion) || notes[0] || null;
    return {
      show: sameInstalledVersion && !alreadyShown,
      currentVersion,
      label: state.label || `v${currentVersion}`,
      source: state.source || "",
      updatedAt: state.updatedAt || "",
      patchNotes: currentNotes?.markdown || "",
    };
  }

  async function markUpdateNoticeRead() {
    const state = await readUpdateState();
    if (!state.updatedAt) return { ok: true, changed: false };
    await writeUpdateState({
      ...state,
      noticeShownFor: await currentLocalVersion(),
      noticeShownAt: new Date().toISOString(),
    });
    return { ok: true, changed: true };
  }

  function updateHeaders() {
    const headers = {
      "accept": "application/vnd.github+json",
      "user-agent": `${packageMetadata.name}/${packageMetadata.version}`,
    };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return headers;
  }

  async function githubJson(path) {
    const response = await fetch(`https://api.github.com/repos/${updateRepo}${path}`, {
      headers: updateHeaders(),
      signal: AbortSignal.timeout(updateRequestTimeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  }

  function releaseAsset(release) {
    return (release?.assets || []).find((asset) => asset.name === updateAssetName) || null;
  }

  async function releaseUpdateCandidate() {
    const release = await githubJson("/releases/latest");
    if (!release || release.draft || release.prerelease) return null;
    const asset = releaseAsset(release);
    if (!asset) {
      return {
        source: "release",
        available: false,
        reason: `${updateAssetName} 릴리스 asset을 찾을 수 없습니다.`,
        latestVersion: normalizeVersion(release.tag_name),
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
      };
    }
    const latestVersion = normalizeVersion(release.tag_name);
    const currentVersion = await currentLocalVersion();
    const available = compareVersions(latestVersion, currentVersion) > 0;
    return {
      source: "release",
      available,
      currentVersion,
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
    const latestUrl = `https://github.com/${updateRepo}/releases/latest`;
    const response = await fetch(latestUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(updateRequestTimeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return null;
    const location = response.headers.get("location") || "";
    const match = location.match(/\/releases\/tag\/([^/?#]+)/);
    if (!match) return null;
    const tagName = decodeURIComponent(match[1]);
    const latestVersion = normalizeVersion(tagName);
    const downloadUrl = `https://github.com/${updateRepo}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(updateAssetName)}`;
    const assetResponse = await fetch(downloadUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(updateRequestTimeoutMs),
    });
    if (assetResponse.status === 404) {
      return {
        source: "release",
        available: false,
        reason: `${updateAssetName} 릴리스 asset을 찾을 수 없습니다.`,
        latestVersion,
        releaseUrl: location,
      };
    }
    if (!assetResponse.ok && ![301, 302, 303, 307, 308].includes(assetResponse.status)) return null;
    const currentVersion = await currentLocalVersion();
    const available = compareVersions(latestVersion, currentVersion) > 0;
    return {
      source: "release",
      available,
      currentVersion,
      latestVersion,
      label: tagName.startsWith("v") ? tagName : `v${latestVersion}`,
      downloadUrl,
      releaseUrl: location,
      publishedAt: null,
      assetName: updateAssetName,
      reason: available ? "" : "현재 버전이 최신 릴리스와 같거나 더 높습니다.",
    };
  }

  async function branchUpdateCandidate() {
    const repo = await githubJson("");
    if (!repo) return null;
    const branchName = updateBranch || repo.default_branch || "main";
    const branch = await githubJson(`/branches/${encodeURIComponent(branchName)}`);
    if (!branch?.commit?.sha) return null;
    const updateState = await readUpdateState();
    const latestRevision = branch.commit.sha;
    const currentRevision = updateState.revision || "";
    const available = currentRevision !== latestRevision;
    return {
      source: "branch",
      available,
      currentVersion: await currentLocalVersion(),
      currentRevision,
      latestRevision,
      label: `${branchName}@${latestRevision.slice(0, 7)}`,
      downloadUrl: `https://github.com/${updateRepo}/archive/refs/heads/${encodeURIComponent(branchName)}.zip`,
      releaseUrl: `https://github.com/${updateRepo}/tree/${encodeURIComponent(branchName)}`,
      publishedAt: branch.commit.commit?.committer?.date || null,
      assetName: `${branchName}.zip`,
      reason: available ? "" : "현재 브랜치 리비전이 최신입니다.",
    };
  }

  async function getUpdateStatus() {
    const currentVersion = await currentLocalVersion();
    const base = {
      repo: updateRepo,
      assetName: updateAssetName,
      currentVersion,
      packageVersion: packageMetadata.version,
      testVersion: testCurrentVersion || "",
    };
    if (!updateRepo) {
      return {
        ...base,
        available: false,
        reason: "업데이트 저장소가 설정되어 있지 않습니다.",
      };
    }
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

  async function downloadUpdateZip(candidate) {
    await mkdir(updateWorkDir, { recursive: true });
    const zipPath = join(updateWorkDir, `codex-session-manager-update-${timestampSlug()}.zip`);
    const response = await fetch(candidate.downloadUrl, {
      headers: updateHeaders(),
      signal: AbortSignal.timeout(updateRequestTimeoutMs),
    });
    if (!response.ok) throw new Error(`업데이트 다운로드 실패 ${response.status}`);
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
    return zipPath;
  }

  function getRuntimeInfo() {
    return {
      cwd: appDir,
      packageVersion: packageMetadata.version,
      currentVersion: currentAppVersion(),
      testVersion: testCurrentVersion || "",
      updateRepo,
      updateAssetName,
      pid: process.pid,
      port,
    };
  }

  function updateRunnerScript({ zipPath, candidate }) {
    const updateState = {
      source: candidate.source,
      label: candidate.label,
      version: candidate.latestVersion || packageMetadata.version,
      revision: candidate.latestRevision || "",
      updatedAt: new Date().toISOString(),
    };
    return `#!/bin/sh
set -eu
APP_DIR=${shellQuote(appDir)}
ZIP_PATH=${shellQuote(zipPath)}
SERVER_PID=${shellQuote(process.pid)}
PORT=${shellQuote(port)}
UPDATE_STATE=${shellQuote(updateStatePath)}
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
  PACKAGE_NAME="$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.name || "");' "$SRC_DIR/package.json" 2>/dev/null || true)"
  if [ "$PACKAGE_NAME" != "codex-session-manager" ]; then
    echo "Unexpected package name in update archive: $PACKAGE_NAME"
    exit 1
  fi
  BACKUP_DIR="$APP_DIR/updates/backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  is_protected_update_item() {
    case "$1" in
      .git|node_modules|dist|logs|updates|backups|.codex-session-manager.json) return 0 ;;
      *) return 1 ;;
    esac
  }
  for item_path in "$APP_DIR"/* "$APP_DIR"/.[!.]* "$APP_DIR"/..?*; do
    [ -e "$item_path" ] || continue
    item="$(basename "$item_path")"
    if is_protected_update_item "$item"; then
      continue
    fi
    mv "$item_path" "$BACKUP_DIR/$item"
  done
  for item_path in "$SRC_DIR"/* "$SRC_DIR"/.[!.]* "$SRC_DIR"/..?*; do
    [ -e "$item_path" ] || continue
    item="$(basename "$item_path")"
    if is_protected_update_item "$item"; then
      continue
    fi
    if [ -d "$item_path" ]; then
      cp -R "$item_path" "$APP_DIR/$item"
    else
      cp "$item_path" "$APP_DIR/$item"
    fi
  done
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

  function updateRunnerScriptWindows({ zipPath, candidate }) {
    const updateState = {
      source: candidate.source,
      label: candidate.label,
      version: candidate.latestVersion || packageMetadata.version,
      revision: candidate.latestRevision || "",
      updatedAt: new Date().toISOString(),
    };
    return `$ErrorActionPreference = 'Stop'
$APP_DIR = ${powershellQuote(appDir)}
$ZIP_PATH = ${powershellQuote(zipPath)}
$SERVER_PID = ${Number(process.pid)}
$PORT = ${powershellQuote(port)}
$UPDATE_STATE = ${powershellQuote(updateStatePath)}
$LOG_DIR = Join-Path $APP_DIR 'logs'
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LOG_FILE = Join-Path $LOG_DIR ('update-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$PROTECTED_ITEMS = @('.git', 'node_modules', 'dist', 'logs', 'updates', 'backups', '.codex-session-manager.json')

function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $LOG_FILE -Encoding UTF8 -Value $Message
}

function Remove-UpdatePath([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-ProtectedUpdateItem([string]$Name) {
  return $PROTECTED_ITEMS -contains $Name
}

function Cleanup-UpdateWork {
  Remove-UpdatePath $ZIP_PATH
  Remove-UpdatePath $MyInvocation.ScriptName
  Get-ChildItem -LiteralPath (Join-Path $APP_DIR 'updates') -Directory -Filter 'extract.*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Join-Path $APP_DIR 'updates') -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Join-Path $APP_DIR 'updates') -File -Filter 'codex-session-manager-update-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Join-Path $APP_DIR 'updates') -File -Filter 'run-update-*.ps1' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

try {
  Write-UpdateLog ('Codex Session Manager update start: ' + (Get-Date -Format o))
  Write-UpdateLog ${powershellQuote(`Source: ${candidate.source} ${candidate.label || ""}`)}

  for ($index = 0; $index -lt 20; $index += 1) {
    if (Get-Process -Id $SERVER_PID -ErrorAction SilentlyContinue) {
      Start-Sleep -Milliseconds 250
    } else {
      break
    }
  }

  $TMP_DIR = Join-Path (Join-Path $APP_DIR 'updates') ('extract.' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $TMP_DIR | Out-Null
  Expand-Archive -LiteralPath $ZIP_PATH -DestinationPath $TMP_DIR -Force

  $SRC_DIR = Get-ChildItem -LiteralPath $TMP_DIR -Recurse -File -Filter 'package.json' |
    ForEach-Object {
      $candidateDir = $_.DirectoryName
      if ((Test-Path -LiteralPath (Join-Path $candidateDir 'server.mjs') -PathType Leaf) -and
          (Test-Path -LiteralPath (Join-Path $candidateDir 'public') -PathType Container)) {
        $candidateDir
      }
    } |
    Select-Object -First 1

  if (-not $SRC_DIR) {
    throw 'No application root found in update archive.'
  }

  $package = Get-Content -LiteralPath (Join-Path $SRC_DIR 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'codex-session-manager') {
    throw ('Unexpected package name in update archive: ' + $package.name)
  }

  $BACKUP_DIR = Join-Path (Join-Path $APP_DIR 'updates') ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $BACKUP_DIR | Out-Null

  foreach ($entry in Get-ChildItem -LiteralPath $APP_DIR -Force) {
    if (Test-ProtectedUpdateItem $entry.Name) {
      continue
    }
    Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $BACKUP_DIR $entry.Name) -Force
  }

  foreach ($entry in Get-ChildItem -LiteralPath $SRC_DIR -Force) {
    if (Test-ProtectedUpdateItem $entry.Name) {
      continue
    }
    Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $APP_DIR $entry.Name) -Recurse -Force
  }

  @'
${JSON.stringify(updateState, null, 2)}
'@ | Set-Content -LiteralPath $UPDATE_STATE -Encoding UTF8

  Cleanup-UpdateWork
  Write-UpdateLog 'Update complete. Update work files cleaned.'

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm --prefix $APP_DIR install 2>&1 | ForEach-Object { Write-UpdateLog ([string]$_) }
    $startScript = Join-Path $APP_DIR 'start.ps1'
    if (Test-Path -LiteralPath $startScript -PathType Leaf) {
      Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript) -WindowStyle Hidden
    } else {
      Write-UpdateLog 'Update installed. Run start.ps1 to restart the server.'
    }
  } else {
    Write-UpdateLog 'npm command not found; update installed but server was not restarted.'
  }
} catch {
  Write-UpdateLog ('Update failed: ' + $_.Exception.Message)
  throw
}
`;
  }

  async function installUpdate() {
    const candidate = await getUpdateStatus();
    if (!candidate.available || !candidate.downloadUrl) {
      throw new Error(candidate.error || candidate.reason || "설치할 업데이트가 없습니다.");
    }
    const zipPath = await downloadUpdateZip(candidate);
    await mkdir(updateWorkDir, { recursive: true });
    await mkdir(join(appDir, "logs"), { recursive: true });
    const isWindows = process.platform === "win32";
    const scriptPath = join(updateWorkDir, `run-update-${timestampSlug()}${isWindows ? ".ps1" : ".sh"}`);
    const launcherPath = join(updateWorkDir, `launch-update-${timestampSlug()}.cmd`);
    const launchLogPath = join(appDir, "logs", `update-launch-${timestampSlug()}.log`);
    await writeFile(
      scriptPath,
      isWindows ? updateRunnerScriptWindows({ zipPath, candidate }) : updateRunnerScript({ zipPath, candidate }),
      "utf8",
    );
    if (isWindows) {
      await writeFile(launcherPath, windowsUpdateLauncherScript({ scriptPath, launchLogPath }), "utf8");
    }
    const child = spawn(isWindows ? "cmd.exe" : "sh", isWindows
      ? ["/d", "/c", launcherPath]
      : [scriptPath], {
      cwd: appDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      source: candidate.source,
      label: candidate.label,
      message: "업데이트를 설치합니다. 서버가 종료된 뒤 자동으로 다시 시작됩니다.",
    };
  }

  return {
    getRuntimeInfo,
    getUpdateNotice,
    getUpdateStatus,
    installUpdate,
    markUpdateNoticeRead,
    readPatchNotes,
  };
}
