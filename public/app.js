import { api, startHeartbeat } from "./js/api.js";
import { setupAppEvents } from "./js/app-events.js";
import { createBackupActions } from "./js/backup-actions.js";
import { createBackupRenderer } from "./js/backup-render.js";
import { createCodexStatusController } from "./js/codex-status.js";
import { createTooltipController, createGuideFanfareRecorder, renderIcons } from "./js/effects.js";
import { chatSizeAdvice, escapeHtml, formatBytes, formatDate } from "./js/format.js";
import { issueLabels } from "./js/labels.js";
import { clearLoadingOverlay, setLoading as setLoadingTargets, setLoadingOverlay } from "./js/loading.js";
import { renderPatchNotesMarkdown } from "./js/markdown.js";
import { createModalController } from "./js/modal.js";
import { createProjectActions } from "./js/project-actions.js";
import { createSideColumnLayout } from "./js/side-column.js";
import { createThreadRenderer } from "./js/thread-render.js";
import { createThreadSelection } from "./js/thread-selection.js";
import { createUpdateController } from "./js/update-ui.js";

let state = null;
const expandedGroups = new Set();
const expandedProjects = new Set();
const autoExpandedGroups = new Set();
const autoExpandedProjects = new Set();
const selectedThreads = new Set();
const selectedBackups = new Set();
let threadSelectionMode = false;
const GENERAL_CHAT_LABEL = "일반 채팅";
const $ = (selector) => document.querySelector(selector);
const { hideGlobalTooltip, showGlobalTooltip } = createTooltipController();
const recordGuideFanfareStep = createGuideFanfareRecorder({ $ });
const { closeModal, runModalSecondaryAction, showAlert, showConfirm, showError, showPrompt } = createModalController({ $, renderPatchNotesMarkdown });
const { queueSideColumnLayout, updateSideColumnLayout } = createSideColumnLayout();
const {
  checkUpdateStatus,
  installAvailableUpdate,
  maybeShowUpdateNotice,
  renderUpdateStatus,
  showPatchNotes,
} = createUpdateController({ $, api, formatDate, showAlert, showConfirm });
const {
  isUnknownOriginalBackup,
  renderBackups,
  updateBackupSelectionButton,
} = createBackupRenderer({
  $,
  selectedBackups,
  getBackups: () => state?.backups || [],
  escapeHtml,
  formatBytes,
  formatDate,
  renderIcons,
});
let deleteAllBackups;
let deleteBackup;
let deleteSelectedBackups;
let deleteUnknownOriginalBackups;
let restoreBackup;
const codexStatusController = createCodexStatusController({
  $,
  api,
  onStatusChanged: () => {
    if (state) renderGroups();
  },
});
const threadRenderer = createThreadRenderer({
  $,
  getState: () => state,
  expandedGroups,
  expandedProjects,
  selectedThreads,
  GENERAL_CHAT_LABEL,
  getThreadSelectionMode: () => threadSelectionMode,
  codexStatusController,
  chatSizeAdvice,
  escapeHtml,
  formatBytes,
  formatDate,
  renderIcons,
  setLoading,
  setLoadingOverlay,
  updateSelectionBar: () => updateSelectionBar(),
  normalizeSelectedThreads: () => normalizeSelectedThreads(),
});
const {
  buildProjectMap,
  filteredGroups,
  groupProject,
  groupRecords,
  projectKey,
  projectSetForThreadDelete,
  projectSetForThreadIds,
  projectSetForBackup,
  renderGroups,
  setProjectSectionLoading,
  toggleProjectSection,
  updateProjectSections,
  updateProjectSubset,
} = threadRenderer;
const {
  clearSelectedThreads,
  deleteSelectedThreads,
  normalizeSelectedThreads,
  setProjectSelected,
  setThreadSelected,
  updateSelectionBar,
} = createThreadSelection({
  $,
  selectedThreads,
  getState: () => state,
  getThreadSelectionMode: () => threadSelectionMode,
  groupRecords,
  groupProject,
  renderGroups,
  showConfirm,
  api,
  projectSetForThreadIds,
  setProjectSectionLoading,
  reloadProjectSubset,
});

function setThreadSelectionMode(enabled) {
  threadSelectionMode = Boolean(enabled);
  $("#chatBackupModeButton").classList.toggle("active", threadSelectionMode);
  $("#chatBackupModeButton").innerHTML = threadSelectionMode
    ? `<span class="button-icon" data-lucide="x" aria-hidden="true"></span>선택 닫기`
    : `<span class="button-icon" data-lucide="archive" aria-hidden="true"></span>채팅 내보내기`;
  if (!threadSelectionMode) selectedThreads.clear();
  renderGroups();
  renderIcons($("#chatBackupModeButton"));
}

function toggleThreadSelectionMode() {
  setThreadSelectionMode(!threadSelectionMode);
}

async function exportSelectedChats() {
  const ids = [...selectedThreads];
  if (ids.length === 0) return;
  const ok = await showConfirm(
    `선택한 채팅 ${ids.length}개를 내보낼까요?\n\n세션 파일, 세션 인덱스, DB 스레드 참조가 함께 내보내집니다.`,
    { confirmText: "내보내기" },
  );
  if (!ok) return;
  setLoading({ backups: true });
  const result = await api("/api/export-chat-backup", {
    method: "POST",
    body: JSON.stringify({ ids, includeChildren: true }),
  });
  await reloadSections({ backups: true, loading: false });
  const exportPath = result.archivePath || result.exportPath || result.exportDir;
  await showAlert(`압축 파일로 내보내기가 완료되었습니다.\n\n${exportPath}`, "채팅 내보내기", {
    secondaryText: "폴더 열기",
    onSecondary: () =>
      api("/api/open-folder", {
        method: "POST",
        body: JSON.stringify({ path: result.openPath || exportPath }),
      }),
  });
}

async function importChatBackup() {
  const selected = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({ kind: "file", currentPath: state?.backupsRoot || "", prompt: "채팅 내보내기 .tgz 파일을 선택하세요.", filter: "chat-backup" }),
  });
  if (selected.canceled) return;
  const inspected = await api("/api/inspect-chat-backup", {
    method: "POST",
    body: JSON.stringify({ path: selected.path }),
  });
  const projects = inspected.manifest?.projects || [];
  const pathMappings = await resolveImportProjectMappings(projects);
  if (pathMappings === null) return;
  const ok = await showConfirm(
    `채팅 내보내기 파일을 가져올까요?\n\n채팅 ${inspected.manifest.counts?.threads || 0}개 · 파일 ${inspected.manifest.counts?.files || 0}개`,
    { confirmText: "가져오기" },
  );
  if (!ok) return;
  setLoading({ threads: true, backups: true });
  const result = await api("/api/import-chat-backup", {
    method: "POST",
    body: JSON.stringify({ path: selected.path, pathMappings }),
  });
  selectedThreads.clear();
  threadSelectionMode = false;
  await reloadSections({ threads: true, backups: true, codexHome: true, loading: false });
  await showAlert(
    `가져오기가 완료되었습니다.\n\n세션 파일 ${result.copiedFiles?.length || 0}개`,
    "채팅 가져오기",
  );
}

async function resolveImportProjectMappings(projects) {
  const mappings = {};
  const currentProjects = currentProjectPaths();
  for (const project of projects) {
    const target = inferImportProjectPath(project, currentProjects);
    if (target) {
      mappings[project] = target;
      continue;
    }
    const selected = await api("/api/select-path", {
      method: "POST",
      body: JSON.stringify({
        kind: "directory",
        currentPath: currentProjects[0] || state?.codexHome || "",
        prompt: "가져올 채팅의 프로젝트 폴더를 선택하세요.",
      }),
    });
    if (selected.canceled) return null;
    mappings[project] = selected.path;
  }
  return mappings;
}

function currentProjectPaths() {
  const paths = [];
  const add = (project) => {
    const value = String(project || "").trim();
    if (!value || value === GENERAL_CHAT_LABEL || value === "(프로젝트 없음)") return;
    if (!paths.includes(value)) paths.push(value);
  };
  for (const group of state?.groups || []) {
    add(group.project);
    add(group.parent?.project);
    for (const child of group.children || []) add(child.project);
  }
  for (const record of state?.records || []) add(record.project);
  return paths;
}

function inferImportProjectPath(sourceProject, currentProjects) {
  const source = String(sourceProject || "").trim();
  if (!source) return "";
  if (currentProjects.includes(source)) return source;
  const sourceName = pathBaseName(source);
  if (!sourceName) return "";
  const candidates = currentProjects.filter((project) => pathBaseName(project) === sourceName);
  return candidates.length === 1 ? candidates[0] : "";
}

function pathBaseName(path) {
  return String(path || "").split(/[\\/]+/).filter(Boolean).at(-1) || "";
}

function setLoading({ threads = false, backups = false } = {}) {
  setLoadingTargets($, { threads, backups });
}

function updateSearchClearButton() {
  $("#clearSearchButton").disabled = $("#searchInput").value.length === 0;
}

function renderSubtitle() {
  const counts = state?.counts || {};
  const issueTotal = Object.values(state?.issueCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
  const issueText = issueTotal > 0 ? `진단 ${issueTotal}건` : "문제 없음";
  $("#subtitle").textContent = `채팅 ${counts.records || 0}개 · 프로젝트 ${counts.projects || 0}개 · 백업 ${counts.backups || 0}개 · ${issueText}`;
}

async function refresh(options = {}) {
  const loading = options.loading || { threads: true, backups: true };
  $("#subtitle").textContent = "로컬 세션 상태를 불러오는 중...";
  setLoading(loading);
  state = await api("/api/summary");
  renderSubtitle();
  renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  normalizeSelectedThreads();
  renderGroups();
  renderBackups();
  renderIcons();
  queueSideColumnLayout();
}

async function reloadSections({ threads = false, backups = false, codexHome = false, loading = true } = {}) {
  if (loading) setLoading({ threads, backups });
  state = await api("/api/summary");
  renderSubtitle();
  if (codexHome) renderCodexHome();
  if (threads) {
    renderFilters();
    updateSearchClearButton();
    normalizeSelectedThreads();
    renderGroups();
  }
  if (backups) renderBackups();
  renderIcons();
  queueSideColumnLayout();
}

function renderCodexHome() {
  $("#codexHomeInput").value = state.codexHome || "";
  $("#sessionsRootInput").value = state.sessionsRoot || "";
  $("#stateDbInput").value = state.stateDb || "";
  $("#backupsRootInput").value = state.backupsRoot || state.defaultBackupsRoot || "";
  renderConfigStatus();
}

function renderConfigStatus() {
  const missing = [
    state.codexHomeExists ? null : "Codex 홈",
    state.sessionsRootExists ? null : "세션 폴더",
    state.stateDbExists ? null : "SQLite DB",
  ].filter(Boolean);
  $("#codexHomeStatus").textContent =
    missing.length === 0 ? `설정 파일: ${state.configPath}` : `${missing.join(", ")} 경로를 찾을 수 없습니다.`;
}

function renderFilters() {
  const issueFilter = $("#issueFilter");
  const currentIssue = issueFilter.value;
  const issues = Object.keys(state.issueCounts).sort();
  issueFilter.innerHTML = `<option value="">모든 진단</option>${issues
    .map((issue) => `<option value="${escapeHtml(issue)}">${escapeHtml(issueLabels[issue] || issue)} (${state.issueCounts[issue]})</option>`)
    .join("")}`;
  issueFilter.value = currentIssue;

  const projectFilter = $("#projectFilter");
  const currentProject = projectFilter.value;
  const projects = new Set();
  for (const group of state.groups) {
    projects.add(groupProject(group));
  }
  projectFilter.innerHTML = `<option value="">모든 프로젝트</option>${[...projects]
    .sort()
    .map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)
    .join("")}`;
  projectFilter.value = currentProject;
}

async function reloadProjectSubset(projects, options = {}) {
  if (!projects.size) {
    await reloadSections({ threads: true, backups: true, codexHome: options.codexHome === true });
    return;
  }
  state = await api("/api/summary");
  renderSubtitle();
  if (options.codexHome) renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  updateProjectSubset(projects);
  renderBackups();
}

({
  deleteAllBackups,
  deleteBackup,
  deleteSelectedBackups,
  deleteUnknownOriginalBackups,
  restoreBackup,
} = createBackupActions({
  api,
  getState: () => state,
  isUnknownOriginalBackup,
  projectSetForBackup,
  reloadProjectSubset,
  reloadSections,
  selectedBackups,
  setLoading,
  setProjectSectionLoading,
  showAlert,
  showConfirm,
}));

const {
  deleteProjectless,
  deleteThread,
  filterThread,
  moveProjectPath,
  removeProject,
  renameProjectPath,
  repairProjectChats,
  repairProjectPath,
  repairProjectRegistration,
  repairThreadChat,
  syncFilteredResultExpansions,
} = createProjectActions({
  $,
  api,
  autoExpandedGroups,
  autoExpandedProjects,
  codexStatusController,
  expandedGroups,
  expandedProjects,
  getState: () => state,
  filteredGroups,
  groupProject,
  groupRecords,
  normalizeSelectedThreads,
  projectKey,
  projectSetForThreadDelete,
  projectSetForThreadIds,
  reloadProjectSubset,
  reloadSections,
  renderBackups,
  renderCodexHome,
  renderFilters,
  renderGroups,
  renderSubtitle,
  selectedThreads,
  setProjectSectionLoading,
  setState: (nextState) => {
    state = nextState;
  },
  showAlert,
  showConfirm,
  showPrompt,
  updateProjectSections,
  updateSearchClearButton,
});

async function runRepair(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    from: form.get("from"),
    to: form.get("to"),
    includeJsonl: form.get("includeJsonl") === "on",
    includeDb: form.get("includeDb") === "on",
  };
  const output = $("#repairOutput");
  output.hidden = false;
  output.textContent = "복구 실행 중...";
  try {
    const result = await api("/api/repair-cwd", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    output.textContent = JSON.stringify(result, null, 2);
    await reloadSections({ threads: true, backups: true, codexHome: true });
  } catch (error) {
    output.textContent = error.message;
  }
}

async function saveCodexHome(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    codexHome: form.get("codexHome"),
    sessionsRoot: form.get("sessionsRoot"),
    stateDb: form.get("stateDb"),
    backupsRoot: form.get("backupsRoot"),
  };
  $("#codexHomeStatus").textContent = "경로 저장 중...";
  setLoading({ threads: true, backups: true });
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expandedGroups.clear();
    expandedProjects.clear();
    autoExpandedGroups.clear();
    autoExpandedProjects.clear();
    await reloadSections({ threads: true, backups: true, codexHome: true });
  } catch (error) {
    $("#codexHomeStatus").textContent = error.message;
    throw error;
  }
}

async function choosePath(button) {
  const input = document.getElementById(button.dataset.selectPath);
  if (!input) return;
  $("#codexHomeStatus").textContent = "경로 선택 대기 중...";
  const result = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({
      kind: button.dataset.pathKind,
      currentPath: input.value,
    }),
  });
  if (result.canceled) {
    renderConfigStatus();
    return;
  }
  input.value = button.dataset.selectPath === "backupsRootInput" ? backupPathFromSelectedParent(result.path) : result.path;
  $("#codexHomeStatus").textContent = "경로를 선택했습니다. 저장하려면 경로 저장을 누르세요.";
}

function backupPathFromSelectedParent(path) {
  const value = String(path || "").replace(/\/+$/, "");
  if (!value) return "";
  return value.split("/").at(-1) === "backups" ? value : `${value}/backups`;
}

async function shutdownProgram() {
  if (!(await showConfirm("프로그램을 종료할까요?\n\n서버를 먼저 종료한 뒤 이 화면을 닫습니다.", { danger: true, confirmText: "종료" }))) return;
  try {
    await fetch("/api/shutdown", { method: "POST", keepalive: true });
  } catch {
    // The server may close the connection before fetch resolves.
  }
  document.body.classList.remove("modal-open");
  document.body.innerHTML = `<main class="shutdown-screen">
    <section class="panel">
      <h1>프로그램이 종료되었습니다.</h1>
      <p>이 창을 닫아도 됩니다.</p>
    </section>
  </main>`;
  window.close();
}

setupAppEvents({
  $,
  checkUpdateStatus,
  choosePath,
  clearSelectedThreads,
  closeModal,
  runModalSecondaryAction,
  codexStatusController,
  deleteAllBackups,
  deleteBackup,
  deleteProjectless,
  deleteSelectedBackups,
  deleteSelectedThreads,
  deleteThread,
  deleteUnknownOriginalBackups,
  exportSelectedChats,
  expandedGroups,
  filterThread,
  hideGlobalTooltip,
  importChatBackup,
  installAvailableUpdate,
  maybeShowUpdateNotice,
  moveProjectPath,
  queueSideColumnLayout,
  recordGuideFanfareStep,
  refresh,
  removeProject,
  renameProjectPath,
  renderConfigStatus,
  renderGroups,
  renderUpdateStatus,
  repairProjectChats,
  repairProjectPath,
  repairProjectRegistration,
  repairThreadChat,
  restoreBackup,
  runRepair,
  saveCodexHome,
  selectedBackups,
  setProjectSelected,
  setThreadSelected,
  showError,
  showGlobalTooltip,
  showPatchNotes,
  shutdownProgram,
  startHeartbeat,
  syncFilteredResultExpansions,
  toggleProjectSection,
  toggleThreadSelectionMode,
  updateBackupSelectionButton,
  updateSearchClearButton,
});
