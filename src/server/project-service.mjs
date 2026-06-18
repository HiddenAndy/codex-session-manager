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
    loadConfigProjects,
    movePath,
    normalizeAbsolutePath,
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
  if (!from.startsWith("/") || !to.startsWith("/") || fromValues.length === 0) {
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
    return normalizeAbsolutePath(record?.project || "") === normalizeAbsolutePath(project);
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
