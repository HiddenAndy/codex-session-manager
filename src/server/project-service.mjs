import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export function createProjectService(deps) {
  const {
    assertCodexClosed,
    backupFileIfExists,
    backupPathForSessionFile,
    backupStateFiles,
    buildSummary,
    exists,
    getPaths,
    isAbsolutePath,
    isInside,
    loadConfigProjects,
    movePath,
    normalizeAbsolutePath,
    pathCompareKey,
    pathMatchVariants,
    replaceCodexChatProcesses,
    replaceCodexProjectConfig,
    replaceCodexProjectGlobalState,
    sessionFileRoots,
    sqlite,
    timestampSlug,
    walk,
  } = deps;
  const paths = getPaths;

async function repairCwd(payload) {
  await assertCodexClosed();
  const from = String(payload.from || "").trim();
  const to = normalizeAbsolutePath(payload.to);
  const fromValues = pathMatchVariants(from).filter((value) => value !== to);
  const includeDb = payload.includeDb !== false;
  const includeJsonl = payload.includeJsonl !== false;
  if (!isAbsolutePath(from) || !isAbsolutePath(to) || fromValues.length === 0) {
    throw new Error("from/to must be different absolute paths");
  }

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_cwd_${timestampSlug()}`);
  await backupStateFiles(backupDir);

  const changedFiles = [];
  if (includeJsonl) {
    for (const root of sessionFileRoots()) {
      for await (const path of walk(root)) {
        if (!path.endsWith(".jsonl")) continue;
        const textContent = await readFile(path, "utf8");
        const { content: next, replacements } = replaceJsonlCwd(textContent, fromValues, to);
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
  if (includeDb && (await exists(paths().STATE_DB))) {
    const sql = [
      ".timeout 5000",
      "begin immediate;",
      `update threads set cwd = ${sqlString(to)} where cwd in (${fromValues.map(sqlString).join(",")});`,
      "select changes();",
      "commit;",
      "pragma integrity_check;",
    ].join("\n");
    const output = await sqlite([paths().STATE_DB], { input: sql });
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
  if (!isAbsolutePath(from)) throw new Error("project must be an absolute path");
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
  if (!isAbsolutePath(from) || !isAbsolutePath(parent)) throw new Error("project and parent must be absolute paths");
  const fromStat = await stat(from).catch(() => null);
  if (!fromStat?.isDirectory()) throw new Error("project directory not found");
  const parentStat = await stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error("target parent directory not found");
  const to = join(parent, basename(from));
  if (to === from) throw new Error("project path is unchanged");
  if (isInside(to, from) && resolve(to) !== resolve(from)) throw new Error("target path must not be inside the project directory");
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
  if (!isAbsolutePath(project) || !(await exists(project))) throw new Error("valid existing project path required");

  const summary = await buildSummary();
  const hasRecords = summary.records.some((record) => recordMatchesProject(record, project));
  const configProjects = await loadConfigProjects();
  const hasConfig = configProjects.some((candidate) => pathCompareKey(candidate) === pathCompareKey(project));
  if (!hasRecords && !hasConfig) throw new Error("project has no Codex session/config evidence");

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_project_registration_${timestampSlug()}`);
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


  function recordMatchesProject(record, project) {
    return pathCompareKey(record?.project || "") === pathCompareKey(project);
  }

  function replaceJsonlCwd(content, fromValues, to) {
    const fromKeys = new Set(fromValues.map(pathCompareKey));
    let replacements = 0;
    const lines = content.split("\n");
    const nextLines = lines.map((line) => {
      if (!line.includes('"cwd"')) return line;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return line;
      }
      const current = row?.payload?.cwd;
      if (typeof current !== "string" || !fromKeys.has(pathCompareKey(current))) return line;
      row.payload.cwd = to;
      replacements += 1;
      return JSON.stringify(row);
    });
    return { content: nextLines.join("\n"), replacements };
  }

  function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  return {
    moveProject,
    recordMatchesProject,
    renameProject,
    repairCwd,
    repairProjectRegistration,
  };
}
