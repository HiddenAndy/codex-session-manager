import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function createRepairService(deps) {
  const {
    backupFileIfExists,
    backupStateFiles,
    buildSummary,
    exists,
    getPaths,
    loadIndex,
    readSessionSummary,
    shouldReplaceStoredTitle,
    sqlite,
    timestampSlug,
    titleFromMessage,
  } = deps;
  const paths = getPaths;

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
    await mkdir(dirname(paths().SESSION_INDEX), { recursive: true });
    const suffix = rows.map((row) => JSON.stringify(row)).join("\n");
    const prefix = (await exists(paths().SESSION_INDEX)) && (await stat(paths().SESSION_INDEX)).size > 0 ? "\n" : "";
    await writeFile(paths().SESSION_INDEX, `${prefix}${suffix}\n`, { encoding: "utf8", flag: "a" });
  }
  return rows;
}

function sqlNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

async function insertMissingDbThreads(records) {
  if (records.length === 0 || !(await exists(paths().STATE_DB))) return [];
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
  const output = await sqlite([paths().STATE_DB], { input: statements.join("\n") });
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

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_auto_repair_${timestampSlug()}`);
  await backupStateFiles(backupDir);
  await backupFileIfExists(paths().SESSION_INDEX, join(backupDir, "session_index.jsonl"));

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

  const backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_thread_repair_${timestampSlug()}_${id}`);
  await backupStateFiles(backupDir);
  await backupFileIfExists(paths().SESSION_INDEX, join(backupDir, "session_index.jsonl"));

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
    backupDir = join(paths().BACKUPS_ROOT, `codex_session_manager_fix_titles_${timestampSlug()}`);
    await backupStateFiles(backupDir);
    await backupFileIfExists(paths().SESSION_INDEX, join(backupDir, "session_index.jsonl"));
  }

  const fixedIndexRows = [];
  if (await exists(paths().SESSION_INDEX)) {
    const lines = (await readFile(paths().SESSION_INDEX, "utf8")).split("\n");
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
    await writeFile(paths().SESSION_INDEX, `${nextLines.join("\n")}${nextLines.length ? "\n" : ""}`, "utf8");
  }

  const dbFixes = [...fixes.values()].filter((fix) => fix.db);
  if (dbFixes.length > 0 && (await exists(paths().STATE_DB))) {
    const statements = [".timeout 5000", "begin immediate;"];
    for (const fix of dbFixes) {
      statements.push(
        `update threads set title = ${sqlString(fix.title)}, first_user_message = ${sqlString(fix.message)}, preview = ${sqlString(fix.message)} where id = ${sqlString(fix.id)};`,
      );
    }
    statements.push("commit;", "pragma integrity_check;");
    const output = await sqlite([paths().STATE_DB], { input: statements.join("\n") });
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


  function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  return {
    appendMissingIndexRows,
    fixStoredTitles,
    insertMissingDbThreads,
    repairProjectChats,
    repairThreadChat,
  };
}
