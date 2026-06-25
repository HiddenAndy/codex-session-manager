import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

const TRANSFER_KIND = "codex-session-manager-chat-transfer";
const TRANSFER_VERSION = 1;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function createChatTransferService(deps) {
  const {
    buildSummary,
    ensureCodexProjectConfig,
    exists,
    getPaths,
    loadIndex,
    replaceCodexProjectGlobalState,
    sqlite,
    timestampSlug,
  } = deps;
  const paths = getPaths;

  async function exportChatBackup(payload) {
    const ids = new Set(Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : []);
    if (ids.size === 0) throw new Error("ids required");

    const summary = await buildSummary();
    const records = flattenSelectedRecords(summary.groups || [], ids, payload.includeChildren !== false);
    if (records.length === 0) throw new Error("selected chats not found");

    const slug = timestampSlug();
    const exportDir = join(paths().BACKUPS_ROOT, `codex_session_manager_transfer_${slug}`);
    await mkdir(exportDir, { recursive: true });

    const selectedIds = new Set(records.map((record) => record.id));
    const files = [];
    for (const record of records) {
      for (const file of record.files || []) {
        if (!file.path || !(await exists(file.path))) continue;
        const relativePath = managedSessionRelativePath(file.path);
        const dest = joinPortable(exportDir, "files", relativePath);
        await mkdir(dirname(dest), { recursive: true });
        await cp(file.path, dest, { preserveTimestamps: true });
        const st = await stat(file.path);
        files.push({
          threadId: record.id,
          originalPath: file.path,
          relativePath,
          size: st.size,
          cwd: file.cwd || null,
        });
      }
    }

    const indexRows = (await loadIndex()).filter((row) => selectedIds.has(String(row.id || "")));
    const db = await exportDbRows(selectedIds);
    const projects = [...new Set(records.map((record) => record.project).filter(isRealProject))].sort();
    const manifest = {
      kind: TRANSFER_KIND,
      version: TRANSFER_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        codexHome: paths().CODEX_HOME,
        sessionsRoot: paths().SESSIONS_ROOT,
        stateDb: paths().STATE_DB,
      },
      projects,
      threadIds: [...selectedIds],
      files,
      counts: {
        threads: selectedIds.size,
        files: files.length,
        projects: projects.length,
        indexRows: indexRows.length,
        dbThreads: db.threads.length,
        dbEdges: db.thread_spawn_edges.length,
      },
    };

    await writeFile(join(exportDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(exportDir, "session_index.jsonl"), `${indexRows.map((row) => JSON.stringify(row)).join("\n")}${indexRows.length ? "\n" : ""}`, "utf8");
    await writeFile(join(exportDir, "db.json"), `${JSON.stringify(db, null, 2)}\n`, "utf8");

    const archiveName = `${chatBackupFileName({ slug, count: selectedIds.size })}.tgz`;
    const archivePath = join(paths().BACKUPS_ROOT, archiveName);
    await writeTarGz(exportDir, archivePath);
    await rm(exportDir, { recursive: true, force: true });

    return { archivePath, exportPath: archivePath, openPath: paths().BACKUPS_ROOT, manifest };
  }

  async function inspectChatBackup(payload) {
    const source = await prepareImportSource(payload.path);
    try {
      const manifest = await readTransferManifest(source.dir);
      return { path: source.originalPath, extractedPath: source.extracted ? source.dir : null, manifest };
    } finally {
      await source.cleanup();
    }
  }

  async function importChatBackup(payload) {
    const source = await prepareImportSource(payload.path);
    const importDir = source.dir;
    try {
      const manifest = await readTransferManifest(importDir);
      const pathMappings = cleanPathMappings(payload.pathMappings);

      const filePathMap = new Map();
      const copiedFiles = [];
      for (const file of manifest.files || []) {
        const relativePath = String(file.relativePath || "");
        if (!relativePath || relativePath.includes("..")) continue;
        const source = joinPortable(importDir, "files", relativePath);
        if (!(await exists(source))) continue;
        const dest = joinPortable(paths().CODEX_HOME, relativePath);
        filePathMap.set(String(file.originalPath || ""), dest);
        await mkdir(dirname(dest), { recursive: true });
        const textContent = await readFile(source, "utf8");
        await writeFile(dest, rewriteJsonText(textContent, buildReplacements(manifest, pathMappings, filePathMap)), "utf8");
        copiedFiles.push(dest);
      }

      const replacements = buildReplacements(manifest, pathMappings, filePathMap);
      const importedIndexRows = await importIndexRows(importDir, replacements);
      const importedDb = await importDbRows(importDir, replacements, filePathMap, pathMappings);
      const ensuredProjects = [];
      for (const [from, to] of Object.entries(pathMappings)) {
        if (!to) continue;
        ensuredProjects.push({
          project: to,
          config: await ensureCodexProjectConfig(to),
          globalState: await replaceCodexProjectGlobalState([from], to, { ensureProject: true }),
        });
      }

      return { imported: true, path: source.originalPath, copiedFiles, importedIndexRows, importedDb, ensuredProjects };
    } finally {
      await source.cleanup();
    }
  }

  function flattenSelectedRecords(groups, ids, includeChildren) {
    const byId = new Map();
    for (const group of groups) {
      const records = [group.parent, ...(group.children || [])].filter(Boolean);
      for (const record of records) byId.set(record.id, record);
      if (includeChildren && group.parent?.id && ids.has(group.parent.id)) {
        for (const child of group.children || []) ids.add(child.id);
      }
    }
    return [...ids].map((id) => byId.get(id)).filter(Boolean);
  }

  async function exportDbRows(selectedIds) {
    if (!(await exists(paths().STATE_DB))) return { threads: [], thread_spawn_edges: [] };
    const idList = [...selectedIds].map(sqlString).join(",");
    const threads = JSON.parse(await sqlite(["-json", paths().STATE_DB, `select * from threads where id in (${idList})`]) || "[]");
    const edges = await readTableRows(
      "thread_spawn_edges",
      `select * from thread_spawn_edges where parent_thread_id in (${idList}) or child_thread_id in (${idList})`,
    );
    return { threads, thread_spawn_edges: edges };
  }

  async function readTableRows(table, sql) {
    if (!(await exists(paths().STATE_DB))) return [];
    try {
      return JSON.parse(await sqlite(["-json", paths().STATE_DB, sql]) || "[]");
    } catch {
      return [];
    }
  }

  async function readTransferManifest(importDir) {
    const manifestPath = join(importDir, "manifest.json");
    if (!(await exists(manifestPath))) throw new Error("manifest.json not found");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.kind !== TRANSFER_KIND) throw new Error("unsupported chat backup folder");
    if (Number(manifest.version || 0) > TRANSFER_VERSION) throw new Error("chat backup was created by a newer version");
    return manifest;
  }

  async function prepareImportSource(value) {
    const originalPath = resolve(String(value || ""));
    const st = await stat(originalPath).catch(() => null);
    if (!st) throw new Error("chat backup not found");
    if (st.isDirectory()) return { originalPath, dir: originalPath, extracted: false, cleanup: async () => {} };
    if (!st.isFile() || !originalPath.endsWith(".tgz")) throw new Error("unsupported chat backup file");
    const dir = await mkdtemp(join(tmpdir(), "codex-chat-backup-"));
    try {
      await extractTarGz(originalPath, dir);
      return {
        originalPath,
        dir,
        extracted: true,
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async function importIndexRows(importDir, replacements) {
    const indexPath = join(importDir, "session_index.jsonl");
    if (!(await exists(indexPath))) return { added: 0, replaced: 0 };
    const importedRows = [];
    for (const line of (await readFile(indexPath, "utf8")).split("\n")) {
      if (!line) continue;
      importedRows.push(replaceValue(JSON.parse(line), replacements));
    }
    if (importedRows.length === 0) return { added: 0, replaced: 0 };
    const existingRows = [];
    const existingById = new Map();
    if (await exists(paths().SESSION_INDEX)) {
      for (const line of (await readFile(paths().SESSION_INDEX, "utf8")).split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          existingRows.push(row);
          if (row.id) existingById.set(String(row.id), row);
        } catch {
          existingRows.push(line);
        }
      }
    }
    let added = 0;
    let replaced = 0;
    for (const row of importedRows) {
      if (row.id && existingById.has(String(row.id))) replaced += 1;
      else added += 1;
      existingById.set(String(row.id), row);
    }
    const importedIds = new Set(importedRows.map((row) => String(row.id || "")));
    const nextRows = existingRows.filter((row) => typeof row === "string" || !importedIds.has(String(row.id || "")));
    nextRows.push(...importedRows);
    await mkdir(dirname(paths().SESSION_INDEX), { recursive: true });
    await writeFile(
      paths().SESSION_INDEX,
      `${nextRows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`,
      "utf8",
    );
    return { added, replaced };
  }

  async function importDbRows(importDir, replacements, filePathMap, pathMappings) {
    if (!(await exists(paths().STATE_DB))) throw new Error("SQLite DB not found");
    const dbPath = join(importDir, "db.json");
    if (!(await exists(dbPath))) return { threads: 0, thread_spawn_edges: 0 };
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    const threadColumns = await tableColumns("threads");
    const edgeColumns = await tableColumns("thread_spawn_edges");
    const threadRows = (db.threads || []).map((row) => rewriteThreadRow(row, replacements, filePathMap, pathMappings));
    const edgeRows = (db.thread_spawn_edges || []).map((row) => replaceValue(row, replacements));
    const statements = [".timeout 5000", "begin immediate;"];
    for (const row of threadRows) statements.push(insertOrReplaceSql("threads", row, threadColumns));
    for (const row of edgeRows) statements.push(insertOrReplaceSql("thread_spawn_edges", row, edgeColumns));
    statements.push("commit;", "pragma integrity_check;");
    const output = await sqlite([paths().STATE_DB], { input: statements.filter(Boolean).join("\n") });
    if (!output.trim().split("\n").includes("ok")) throw new Error(`sqlite integrity check failed: ${output}`);
    return { threads: threadRows.length, thread_spawn_edges: edgeRows.length };
  }

  function rewriteThreadRow(row, replacements, filePathMap, pathMappings) {
    const next = replaceValue(row, replacements);
    if (row.rollout_path && filePathMap.has(String(row.rollout_path))) next.rollout_path = filePathMap.get(String(row.rollout_path));
    if (row.cwd && pathMappings[String(row.cwd)]) next.cwd = pathMappings[String(row.cwd)];
    return next;
  }

  async function tableColumns(table) {
    const rows = JSON.parse(await sqlite(["-json", paths().STATE_DB, `pragma table_info(${table})`]) || "[]");
    return new Set(rows.map((row) => row.name).filter(Boolean));
  }

  function insertOrReplaceSql(table, row, columns) {
    const keys = Object.keys(row).filter((key) => columns.has(key));
    if (keys.length === 0) return "";
    return `insert or replace into ${quoteIdent(table)} (${keys.map(quoteIdent).join(",")}) values (${keys.map((key) => sqlValue(row[key])).join(",")});`;
  }

  function buildReplacements(manifest, pathMappings, filePathMap) {
    const replacements = [];
    if (manifest.source?.codexHome) replacements.push([manifest.source.codexHome, paths().CODEX_HOME]);
    for (const [from, to] of Object.entries(pathMappings)) replacements.push([from, to]);
    for (const [from, to] of filePathMap.entries()) replacements.push([from, to]);
    return replacements
      .filter(([from, to]) => from && to && from !== to)
      .sort((a, b) => String(b[0]).length - String(a[0]).length)
      .flatMap(([from, to]) => pathReplacementVariants(from, to));
  }

  function replaceValue(value, replacements) {
    if (typeof value === "string") return replaceString(value, replacements);
    if (Array.isArray(value)) return value.map((item) => replaceValue(item, replacements));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValue(item, replacements)]));
  }

  function rewriteJsonText(text, replacements) {
    return `${text
      .split("\n")
      .map((line) => {
        if (!line) return line;
        try {
          return JSON.stringify(replaceValue(JSON.parse(line), replacements));
        } catch {
          return replaceString(line, replacements);
        }
      })
      .join("\n")
      .replace(/\n*$/, "")}\n`;
  }

  return { exportChatBackup, importChatBackup, inspectChatBackup };

  function managedSessionRelativePath(filePath) {
    const resolvedFile = resolve(filePath);
    const roots = [
      ["sessions", paths().SESSIONS_ROOT],
      ["archived_sessions", paths().ARCHIVED_SESSIONS_ROOT],
      ["sessions", join(paths().CODEX_HOME, "sessions")],
      ["archived_sessions", join(paths().CODEX_HOME, "archived_sessions")],
    ];
    for (const [label, root] of roots) {
      if (isInsidePath(resolvedFile, root)) return `${label}/${portableRelative(root, resolvedFile)}`;
    }
    if (isInsidePath(resolvedFile, paths().CODEX_HOME)) return portableRelative(paths().CODEX_HOME, resolvedFile);
    throw new Error(`session file is outside managed Codex roots: ${filePath}`);
  }
}

function chatBackupFileName({ slug, count }) {
  return `codex-chats-${slug}-${count}`;
}

function isRealProject(project) {
  const value = String(project || "");
  return value && value !== "(프로젝트 없음)" && value !== "일반 채팅";
}

function cleanPathMappings(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([from, to]) => [String(from || "").trim(), String(to || "").trim()])
      .filter(([from, to]) => from && to),
  );
}

function replaceString(value, replacements) {
  let next = value;
  for (const [from, to] of replacements) next = next.split(from).join(to);
  return next;
}

function pathReplacementVariants(from, to) {
  const pairs = [[String(from), String(to)]];
  pairs.push([String(from).replaceAll("\\", "/"), String(to).replaceAll("\\", "/")]);
  pairs.push([String(from).replaceAll("/", "\\"), String(to).replaceAll("/", "\\")]);
  const unique = new Map();
  for (const [source, dest] of pairs) {
    if (source) unique.set(source, dest);
  }
  return [...unique.entries()];
}

function portableRelative(root, filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}

function isInsidePath(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

function joinPortable(root, ...parts) {
  return join(root, ...parts.flatMap((part) => String(part || "").split(/[\\/]+/).filter(Boolean)));
}

async function writeTarGz(sourceDir, archivePath) {
  const chunks = [];
  for (const file of await listFiles(sourceDir)) {
    const relativePath = portableRelative(sourceDir, file);
    const data = await readFile(file);
    const st = await stat(file);
    chunks.push(tarHeader(relativePath, data.length, Math.floor(st.mtimeMs / 1000)));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(archivePath, await gzipAsync(Buffer.concat(chunks)));
}

async function extractTarGz(archivePath, destDir) {
  const buffer = await gunzipAsync(await readFile(archivePath));
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
      throw new Error("unsafe path in chat backup archive");
    }
    const size = parseInt(parseTarString(header, 124, 12).trim() || "0", 8);
    const type = parseTarString(header, 156, 1) || "0";
    const outputPath = joinPortable(destDir, relativePath);
    if (type === "0" || type === "\0") {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, buffer.subarray(offset, offset + size));
    }
    offset += size + ((512 - (size % 512)) % 512);
  }
}

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512, 0);
  const { namePart, prefixPart } = splitTarName(name);
  writeTarString(header, namePart, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, mtime, 136, 12);
  header.fill(0x20, 148, 156);
  writeTarString(header, "0", 156, 1);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, prefixPart, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarOctal(header, checksum, 148, 8);
  return header;
}

function splitTarName(name) {
  const cleanName = String(name).replaceAll("\\", "/");
  if (Buffer.byteLength(cleanName) <= 100) return { namePart: cleanName, prefixPart: "" };
  const parts = cleanName.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefixPart = parts.slice(0, index).join("/");
    const namePart = parts.slice(index).join("/");
    if (Buffer.byteLength(prefixPart) <= 155 && Buffer.byteLength(namePart) <= 100) return { namePart, prefixPart };
  }
  throw new Error(`path is too long for portable tar archive: ${name}`);
}

function writeTarString(buffer, value, offset, length) {
  buffer.write(String(value || "").slice(0, length), offset, length, "utf8");
}

function writeTarOctal(buffer, value, offset, length) {
  const text = Math.trunc(Number(value) || 0).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function parseTarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlString(value);
}
