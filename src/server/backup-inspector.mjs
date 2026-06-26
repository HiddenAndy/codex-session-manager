import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export function createBackupInspector(deps) {
  const {
    backupPathForSessionFile,
    byId,
    exists,
    getPaths,
    isContextOnlyMessage,
    isInside,
    isSafeBackupDeleteTarget,
    loadIndex,
    loadThreads,
    readJsonlMeta,
    readSessionMetaIfExists,
    titleFromMessage,
    walk,
  } = deps;
  const paths = getPaths;

function backupRelativePath(path) {
  const resolved = resolve(path);
  const resolvedBackupsRoot = resolve(paths().BACKUPS_ROOT);
  if (isInside(resolved, resolvedBackupsRoot)) {
    const relativeToBackups = relative(resolvedBackupsRoot, resolved);
    return relativeToBackups ? `backups/${relativeToBackups}` : "backups";
  }
  return relative(paths().CODEX_HOME, path);
}

async function loadBackups() {
  const entries = [];
  const backupContext = {
    indexMap: byId(await loadIndex()),
    threadMap: byId(await loadThreads()),
  };
  if (await exists(paths().BACKUPS_ROOT)) {
    for (const entry of await readdir(paths().BACKUPS_ROOT, { withFileTypes: true })) {
      const path = join(paths().BACKUPS_ROOT, entry.name);
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
  for await (const path of walk(paths().SESSIONS_ROOT)) {
    if (!path.endsWith("_bak.jsonl")) continue;
    const st = await stat(path);
    entries.push({
      type: "session-bak",
      name: basename(path),
      path,
      relativePath: relative(paths().CODEX_HOME, path),
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
    const sourceName = source ? relative(paths().CODEX_HOME, source) : "";
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
    return join(paths().SESSIONS_ROOT, year, month, day, basename(filePath));
  }
  const match = basename(filePath).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (match) return join(paths().SESSIONS_ROOT, match[1], match[2], match[3], basename(filePath));
  return join(paths().SESSIONS_ROOT, basename(filePath));
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
        existing: (await exists(paths().CODEX_CONFIG_TOML)) ? 1 : 0,
        missing: (await exists(paths().CODEX_CONFIG_TOML)) ? 0 : 1,
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
      const backupCopy = join(path, relative(paths().CODEX_HOME, original));
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


  return {
    backupOriginalStatus,
    backupRestoreStatus,
    loadBackups,
    looseBackupSessionFiles,
    readManifest,
    sessionPathFromBackupFile,
  };
}
