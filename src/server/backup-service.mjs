import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export function createBackupService(deps) {
  const {
    backupFileIfExists,
    backupPathForSessionFile,
    backupRestoreStatus,
    backupStateFiles,
    exists,
    fixStoredTitles,
    getPaths,
    isManagedSessionFilePath,
    isSafeBackupDeleteTarget,
    loadBackups,
    looseBackupSessionFiles,
    readManifest,
    readSessionMetaIfExists,
    sessionPathFromBackupFile,
    sqlite,
    timestampSlug,
    walk,
  } = deps;
  const paths = getPaths;

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

  const safetyBackupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_before_restore_${timestampSlug()}`);
  await mkdir(safetyBackupDir, { recursive: true });

  if (st.isFile()) {
    if (!target.endsWith("_bak.jsonl")) throw new Error("unsupported backup file");
    const originalPath = target.replace(/_bak\.jsonl$/, ".jsonl");
    await backupFileIfExists(originalPath, join(safetyBackupDir, "sessions", relative(paths().SESSIONS_ROOT, originalPath)));
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
  await backupFileIfExists(paths().SESSION_INDEX, join(safetyBackupDir, "session_index.jsonl"));
  await removeSessionFilesAbsentFromBackupSnapshot(target, sourceManifest, safetyBackupDir);

  const restoredFiles = [];
  const backupStateDb = join(target, "state_5.sqlite");
  if (await exists(backupStateDb)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${paths().STATE_DB}${suffix}`, { force: true });
      const backupPart = `${backupStateDb}${suffix}`;
      if (await exists(backupPart)) {
        await cp(backupPart, `${paths().STATE_DB}${suffix}`, { preserveTimestamps: true });
      }
    }
    restoredFiles.push(paths().STATE_DB);
  }

  const backupConfigToml = join(target, "config.toml");
  if (await exists(backupConfigToml)) {
    await cp(backupConfigToml, paths().CODEX_CONFIG_TOML, { preserveTimestamps: true });
    restoredFiles.push(paths().CODEX_CONFIG_TOML);
  }

  const backupGlobalState = join(target, ".codex-global-state.json");
  if (await exists(backupGlobalState)) {
    await cp(backupGlobalState, paths().CODEX_GLOBAL_STATE, { preserveTimestamps: true });
    restoredFiles.push(paths().CODEX_GLOBAL_STATE);
  }

  const backupGlobalStateBak = join(target, ".codex-global-state.json.bak");
  if (await exists(backupGlobalStateBak)) {
    await cp(backupGlobalStateBak, paths().paths().CODEX_GLOBAL_STATE_BAK, { preserveTimestamps: true });
    restoredFiles.push(paths().paths().CODEX_GLOBAL_STATE_BAK);
  }

  const backupIndex = join(target, "session_index.jsonl");
  if (await exists(backupIndex)) {
    await mkdir(dirname(paths().SESSION_INDEX), { recursive: true });
    await cp(backupIndex, paths().SESSION_INDEX, { preserveTimestamps: true });
    restoredFiles.push(paths().SESSION_INDEX);
  }

  for (const sessionDirName of ["sessions", "archived_sessions"]) {
    const backupSessionsRoot = join(target, sessionDirName);
    if (await exists(backupSessionsRoot)) {
      for await (const backupFile of walk(backupSessionsRoot)) {
        const dest = join(paths().CODEX_HOME, sessionDirName, relative(backupSessionsRoot, backupFile));
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
  if (!(await exists(paths().STATE_DB))) return { ids: [], dbThreadChanges: 0, dbEdgeChanges: 0, removedIndexRows: 0 };
  const output = await sqlite([paths().STATE_DB], { input: ".mode tabs\nselect id, rollout_path from threads;" });
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
  const dbOutput = await sqlite([paths().STATE_DB], { input: sql });
  const lines = dbOutput.trim().split("\n");
  const dbEdgeChanges = Number(lines[0] || 0);
  const dbThreadChanges = Number(lines[1] || 0);
  if (!lines.includes("ok")) throw new Error(`sqlite integrity check failed: ${dbOutput}`);

  let removedIndexRows = 0;
  const idSet = new Set(ids);
  if (await exists(paths().SESSION_INDEX)) {
    const indexLines = (await readFile(paths().SESSION_INDEX, "utf8")).split("\n");
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
    await writeFile(paths().SESSION_INDEX, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  }

  return { ids, dbThreadChanges, dbEdgeChanges, removedIndexRows };
}


  function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  return {
    deleteAllBackups,
    deleteBackup,
    deleteBackups,
    deleteUnknownOriginalBackups,
    isUnknownOriginalBackup,
    pruneDbThreadsWithMissingSessionFiles,
    removeSessionFilesAbsentFromBackupSnapshot,
    restoreBackup,
  };
}
