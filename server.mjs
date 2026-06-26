import { createServer } from "node:http";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { assertCodexClosed, getCodexProcessStatus } from "./src/server/codex-process.mjs";
import { createChatTransferService } from "./src/server/chat-transfer-service.mjs";
import { createCodexGlobalStateService } from "./src/server/codex-global-state.mjs";
import { createCodexProjectConfigService } from "./src/server/codex-project-config.mjs";
import { createBackupInspector } from "./src/server/backup-inspector.mjs";
import { createBackupService } from "./src/server/backup-service.mjs";
import { createDeleteService } from "./src/server/delete-service.mjs";
import { backupFileIfExists, createPathNormalizer, exists, isAbsolutePath, isInside, movePath, timestampSlug, walk } from "./src/server/fs-utils.mjs";
import { createPathPicker } from "./src/server/path-picker.mjs";
import { createProjectService } from "./src/server/project-service.mjs";
import { createRepairService } from "./src/server/repair-service.mjs";
import { createRequestHandler } from "./src/server/routes.mjs";
import { createSessionReaders } from "./src/server/session-readers.mjs";
import { createSummaryService } from "./src/server/summary-service.mjs";
import { sqlite } from "./src/server/sqlite-client.mjs";
import { createUpdateService } from "./src/server/update-service.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PACKAGE_JSON_PATH = join(__dirname, "package.json");
const PATCH_NOTES_DIR = join(__dirname, "docs", "patch-notes", "releases");
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const DEFAULT_BACKUPS_ROOT = join(__dirname, "backups");
const CONFIG_PATH = join(__dirname, ".codex-session-manager.json");
const PID_PATH = join(__dirname, ".codex-session-manager.pid");
const UPDATE_STATE_PATH = join(__dirname, ".codex-session-manager-update.json");
const UPDATE_WORK_DIR = join(__dirname, "updates");
const UPDATE_REPO = process.env.CODEX_SESSION_MANAGER_UPDATE_REPO || inferGitHubRepoFromOrigin(__dirname);
const UPDATE_ASSET_NAME = process.env.CODEX_SESSION_MANAGER_UPDATE_ASSET || "codex-session-manager.zip";
const UPDATE_BRANCH = process.env.CODEX_SESSION_MANAGER_UPDATE_BRANCH || "";
const UPDATE_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_SESSION_MANAGER_UPDATE_TIMEOUT_MS || 8000);
const TEST_CURRENT_VERSION = process.env.CODEX_SESSION_MANAGER_TEST_VERSION || "";
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

function inferGitHubRepoFromOrigin(cwd) {
  try {
    const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remoteUrl.match(/github\.com[:/](?<repo>[^/]+\/[^/.]+)(?:\.git)?$/i);
    return match?.groups?.repo || "";
  } catch {
    return "";
  }
}

const APP_PACKAGE = await readPackageMetadata();
const updateService = createUpdateService({
  appDir: __dirname,
  packageMetadata: APP_PACKAGE,
  patchNotesDir: PATCH_NOTES_DIR,
  updateStatePath: UPDATE_STATE_PATH,
  updateWorkDir: UPDATE_WORK_DIR,
  updateRepo: UPDATE_REPO,
  updateAssetName: UPDATE_ASSET_NAME,
  updateBranch: UPDATE_BRANCH,
  updateRequestTimeoutMs: UPDATE_REQUEST_TIMEOUT_MS,
  testCurrentVersion: TEST_CURRENT_VERSION,
  port: PORT,
});

function expandHomePath(value) {
  const textValue = String(value || "").trim();
  if (textValue === "~") return homedir();
  if (textValue.startsWith("~/") || textValue.startsWith("~\\")) return join(homedir(), textValue.slice(2));
  return textValue;
}

const { normalizeAbsolutePath, pathCompareKey, pathMatchVariants } = createPathNormalizer(expandHomePath);
const pathPicker = createPathPicker({
  expandHomePath,
  getCodexHome: () => CODEX_HOME,
  normalizeAbsolutePath,
  pathCompareKey,
});
const codexProjectConfig = createCodexProjectConfigService({
  getConfigToml: () => CODEX_CONFIG_TOML,
  normalizeAbsolutePath,
  pathCompareKey,
  pathMatchVariants,
});
const codexGlobalState = createCodexGlobalStateService({
  getGlobalStatePath: () => CODEX_GLOBAL_STATE,
  getGlobalStateBackupPath: () => CODEX_GLOBAL_STATE_BAK,
  getChatProcessesPath: () => CODEX_CHAT_PROCESSES,
  normalizeAbsolutePath,
  pathMatchVariants,
});
const {
  ensureCodexProjectConfig,
  loadConfigProjects,
  removeCodexProjectConfig,
  replaceCodexProjectConfig,
} = codexProjectConfig;
const {
  loadCodexGlobalState,
  loadGlobalProjects,
  removeCodexProjectGlobalState,
  replaceCodexChatProcesses,
  replaceCodexProjectGlobalState,
} = codexGlobalState;

const sessionReaders = createSessionReaders({
  canonicalRolloutRe: CANONICAL_ROLLOUT_RE,
  exists,
  getPaths: () => ({
    ARCHIVED_SESSIONS_ROOT,
    CODEX_HOME,
    SESSION_INDEX,
    SESSIONS_ROOT,
    STATE_DB,
  }),
  isInside,
  sqlite,
  walk,
});
const {
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
} = sessionReaders;

const backupInspector = createBackupInspector({
  getPaths: () => ({
    ARCHIVED_SESSIONS_ROOT,
    BACKUPS_ROOT,
    CODEX_CONFIG_TOML,
    CODEX_HOME,
    SESSIONS_ROOT,
  }),
  backupPathForSessionFile,
  byId,
  exists,
  isContextOnlyMessage,
  isInside,
  isSafeBackupDeleteTarget: (...args) => isSafeBackupDeleteTarget(...args),
  loadIndex,
  loadThreads,
  readJsonlMeta,
  readSessionMetaIfExists,
  titleFromMessage,
  walk,
});
const {
  backupOriginalStatus,
  backupRestoreStatus,
  loadBackups,
  looseBackupSessionFiles,
  readManifest,
  sessionPathFromBackupFile,
} = backupInspector;

const summaryService = createSummaryService({
  byId,
  exists,
  getPaths: () => ({
    BACKUPS_ROOT,
    CODEX_HOME,
    CONFIG_PATH,
    DEFAULT_CODEX_HOME,
    SESSIONS_ROOT,
    STATE_DB,
  }),
  loadBackups,
  loadCodexGlobalState,
  loadConfigProjects,
  loadGlobalProjects,
  loadIndex,
  loadSessionFiles,
  loadSpawnEdges,
  loadThreads,
  normalizeAbsolutePath,
  pathCompareKey,
});
const { buildSummary } = summaryService;

function resolveConfigPath(value, fallback) {
  return resolve(expandHomePath(value || fallback));
}

function stateDbCandidates(codexHome) {
  return [
    join(codexHome, "state_5.sqlite"),
    join(codexHome, "sqlite", "state_5.sqlite"),
  ];
}

function stateDbFreshness(path) {
  if (!existsSync(path)) return -1;
  return Math.max(
    ...[path, `${path}-wal`, `${path}-shm`].map((candidate) => {
      try {
        return statSync(candidate).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
}

function defaultStateDbPath(codexHome) {
  const existing = stateDbCandidates(codexHome).filter((candidate) => existsSync(candidate));
  if (existing.length === 0) return join(codexHome, "state_5.sqlite");
  return existing.sort((a, b) => stateDbFreshness(b) - stateDbFreshness(a))[0];
}

function resolveStateDbPath(value, codexHome) {
  const fallback = defaultStateDbPath(codexHome);
  const resolved = resolveConfigPath(value, fallback);
  const knownDefaultPaths = new Set(stateDbCandidates(codexHome).map((candidate) => resolve(candidate)));
  return knownDefaultPaths.has(resolved) ? fallback : resolved;
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
  STATE_DB = resolveStateDbPath(config.stateDb, CODEX_HOME);
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
  if (!isAbsolutePath(expanded)) throw new Error("absolute codexHome required");
  const codexHome = resolve(expanded);
  const sessionsRoot = resolveConfigPath(payload.sessionsRoot, join(codexHome, "sessions"));
  const backupsRoot = normalizeBackupsRoot(payload.backupsRoot, DEFAULT_BACKUPS_ROOT);
  const stateDb = resolveStateDbPath(payload.stateDb, codexHome);
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
    if (isInside(dest, src) && resolve(dest) !== resolve(src)) {
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

const repairService = createRepairService({
  backupFileIfExists,
  backupStateFiles,
  buildSummary,
  exists,
  getPaths: () => ({
    BACKUPS_ROOT,
    SESSION_INDEX,
    STATE_DB,
  }),
  readSessionSummary,
  shouldReplaceStoredTitle,
  sqlite,
  timestampSlug,
  titleFromMessage,
});
const {
  appendMissingIndexRows,
  fixStoredTitles,
  insertMissingDbThreads,
  repairProjectChats,
  repairThreadChat,
} = repairService;

const projectService = createProjectService({
  assertCodexClosed,
  backupFileIfExists,
  backupPathForSessionFile,
  backupStateFiles,
  buildSummary,
  exists,
  getPaths: () => ({
    BACKUPS_ROOT,
    STATE_DB,
  }),
  loadConfigProjects,
  movePath,
  isAbsolutePath,
  isInside,
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
});
const {
  moveProject,
  recordMatchesProject,
  renameProject,
  repairCwd,
  repairProjectRegistration,
} = projectService;

function isSafeBackupDeleteTarget(path, isDirectoryHint = null) {
  const resolved = resolve(path);
  if (isInside(resolved, BACKUPS_ROOT) && relative(resolve(BACKUPS_ROOT), resolved) !== "") return true;
  if (isInside(resolved, SESSIONS_ROOT) && basename(resolved).endsWith("_bak.jsonl")) return true;
  if (isDirectoryHint === false && basename(resolved).endsWith("_bak.jsonl")) return true;
  return false;
}

async function openFolder(payload) {
  const target = resolve(expandHomePath(payload.path || ""));
  const st = await stat(target).catch(() => null);
  if (!st?.isDirectory()) throw new Error("folder not found");
  const allowedRoots = [BACKUPS_ROOT, CODEX_HOME, __dirname].map((path) => resolve(path));
  if (!allowedRoots.some((root) => isInside(target, root))) throw new Error("refusing to open folder outside managed roots");
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [target], { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: true, path: target };
}

const backupService = createBackupService({
  backupFileIfExists,
  backupPathForSessionFile,
  backupRestoreStatus,
  backupStateFiles,
  exists,
  fixStoredTitles,
  getPaths: () => ({
    ARCHIVED_SESSIONS_ROOT,
    BACKUPS_ROOT,
    CODEX_CONFIG_TOML,
    CODEX_GLOBAL_STATE,
    CODEX_GLOBAL_STATE_BAK,
    CODEX_HOME,
    SESSION_INDEX,
    SESSIONS_ROOT,
    STATE_DB,
  }),
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
});
const {
  deleteAllBackups,
  deleteBackup,
  deleteBackups,
  deleteUnknownOriginalBackups,
  isUnknownOriginalBackup,
  pruneDbThreadsWithMissingSessionFiles,
  removeSessionFilesAbsentFromBackupSnapshot,
  restoreBackup,
} = backupService;

const chatTransferService = createChatTransferService({
  buildSummary,
  ensureCodexProjectConfig,
  exists,
  getPaths: () => ({
    ARCHIVED_SESSIONS_ROOT,
    BACKUPS_ROOT,
    CODEX_CONFIG_TOML,
    CODEX_GLOBAL_STATE,
    CODEX_GLOBAL_STATE_BAK,
    CODEX_HOME,
    SESSION_INDEX,
    SESSIONS_ROOT,
    STATE_DB,
  }),
  loadIndex,
  replaceCodexProjectGlobalState,
  sqlite,
  timestampSlug,
});
const { exportChatBackup, importChatBackup, inspectChatBackup } = chatTransferService;

const deleteService = createDeleteService({
  assertCodexClosed,
  backupFileIfExists,
  backupPathForSessionFile,
  backupStateFiles,
  buildSummary,
  exists,
  getPaths: () => ({
    BACKUPS_ROOT,
    SESSION_INDEX,
    STATE_DB,
  }),
  isManagedSessionFilePath,
  isAbsolutePath,
  normalizeAbsolutePath,
  recordMatchesProject,
  removeCodexProjectConfig,
  removeCodexProjectGlobalState,
  sqlite,
  timestampSlug,
  uuidRe: UUID_RE,
});
const {
  deleteThread,
  deleteThreads,
  removeProject,
} = deleteService;

let server;

function shutdownSoon(delayMs) {
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }, delayMs).unref();
}

const handleRequest = createRequestHandler({
  publicDir: PUBLIC_DIR,
  getConfig,
  saveConfig,
  selectPath: pathPicker.selectPath,
  openFolder,
  buildSummary,
  getCodexProcessStatus,
  updateService,
  noteHeartbeat,
  shutdownSoon,
  repairCwd,
  renameProject,
  moveProject,
  repairProjectRegistration,
  repairProjectChats,
  repairThreadChat,
  fixStoredTitles,
  deleteBackup,
  deleteBackups,
  restoreBackup,
  deleteAllBackups,
  deleteUnknownOriginalBackups,
  exportChatBackup,
  importChatBackup,
  inspectChatBackup,
  deleteThread,
  deleteThreads,
  removeProject,
});

server = createServer(async (req, res) => {
  activeRequests += 1;
  res.once("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
  await handleRequest(req, res);
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
