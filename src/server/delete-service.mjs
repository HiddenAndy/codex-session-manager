import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function createDeleteService(deps) {
  const {
    assertCodexClosed,
    backupFileIfExists,
    backupPathForSessionFile,
    backupStateFiles,
    buildSummary,
    exists,
    getPaths,
    isManagedSessionFilePath,
    normalizeAbsolutePath,
    recordMatchesProject,
    removeCodexProjectConfig,
    removeCodexProjectGlobalState,
    sqlite,
    timestampSlug,
    uuidRe,
  } = deps;
  const paths = getPaths;

async function deleteThread(payload) {
  const id = String(payload.id || "");
  const includeChildren = payload.includeChildren !== false;
  if (!new RegExp(`^${uuidRe}$`).test(id)) {
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

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_delete_${timestampSlug()}_${id}`);
  await mkdir(backupDir, { recursive: true });
  await backupStateFiles(backupDir);
  await backupFileIfExists(paths().SESSION_INDEX, join(backupDir, "session_index.jsonl"));

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
  if (await exists(paths().SESSION_INDEX)) {
    const lines = (await readFile(paths().SESSION_INDEX, "utf8")).split("\n");
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
    await writeFile(paths().SESSION_INDEX, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
  }

  let dbThreadChanges = 0;
  let dbEdgeChanges = 0;
  if (await exists(paths().STATE_DB)) {
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
    const output = await sqlite([paths().STATE_DB], { input: sql });
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

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_remove_project_${timestampSlug()}`);
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


  function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  return { deleteThread, deleteThreads, removeProject };
}
