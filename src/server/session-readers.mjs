import { open, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join, normalize, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

export function createSessionReaders(deps) {
  const { canonicalRolloutRe, exists, getPaths, isInside, sqlite, walk } = deps;
  const paths = getPaths;

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
  if (!(await exists(paths().STATE_DB))) return [];
  const stdout = await sqlite([
    "-json",
    paths().STATE_DB,
    `select id, rollout_path, created_at_ms, updated_at_ms, source, cwd, title, archived, git_sha, git_branch, first_user_message, thread_source, agent_nickname, agent_role, preview from threads order by updated_at_ms desc`,
  ]);
  return JSON.parse(stdout || "[]");
}

async function loadSpawnEdges() {
  if (!(await exists(paths().STATE_DB))) return [];
  try {
    const stdout = await sqlite([
      "-json",
      paths().STATE_DB,
      `select parent_thread_id as parentId, child_thread_id as childId, status from thread_spawn_edges`,
    ]);
    return JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
}

async function loadIndex() {
  if (!(await exists(paths().SESSION_INDEX))) return [];
  const rows = [];
  for (const line of (await readFile(paths().SESSION_INDEX, "utf8")).split("\n")) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function sessionFileRoots() {
  return [...new Set([paths().SESSIONS_ROOT, paths().ARCHIVED_SESSIONS_ROOT].map((path) => resolve(path)))];
}

function isManagedSessionFilePath(filePath) {
  const resolved = resolve(filePath);
  return sessionFileRoots().some((root) => isInside(resolved, root));
}

function backupPathForSessionFile(backupDir, filePath) {
  return join(backupDir, relative(paths().CODEX_HOME, filePath));
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
        relativePath: relative(paths().CODEX_HOME, path),
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        canonicalName: canonicalRolloutRe.test(name),
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
  const startsWithPathContext = /^In (?:\/Users\/|[a-zA-Z]:[\\/]|\/\/[^/\\]+[\\/][^/\\]+[\\/])/.test(textValue);
  return (
    (startsWithPathContext && textValue.includes("Do not edit files")) ||
    (startsWithPathContext && textValue.includes("Produce only")) ||
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

function titleFromMessage(message, fallback) {
  const textValue = cleanUserMessageCandidate(message).replace(/\s+/g, " ").trim();
  if (shouldReplaceStoredTitle(textValue)) return fallback;
  if (!textValue) return fallback;
  return textValue.length > 120 ? `${textValue.slice(0, 117)}...` : textValue;
}


  return {
    backupPathForSessionFile,
    byId,
    cleanUserMessageCandidate,
    isContextOnlyMessage,
    isManagedSessionFilePath,
    loadIndex,
    loadSessionFiles,
    loadSpawnEdges,
    loadThreads,
    readJsonlMeta,
    readSessionMetaIfExists,
    readSessionSummary,
    rowUpdatedAtMs,
    sessionFileRoots,
    shouldReplaceStoredTitle,
    titleFromMessage,
  };
}
