let state = null;
const expandedGroups = new Set();
const expandedProjects = new Set();
const autoExpandedGroups = new Set();
const autoExpandedProjects = new Set();
const selectedThreads = new Set();
const selectedBackups = new Set();
let codexStatus = { open: true, unknown: true };
const GENERAL_CHAT_LABEL = "일반 채팅";
const PATCH_NOTES_PREVIEW = `## 이번 업데이트

헷갈리던 표시와 삭제 후 다시 보이던 문제들을 정리했습니다.

### 정리한 것
- **프로젝트 경로 변경/재설정** 흐름을 안정화했습니다.
- 삭제한 채팅이 다시 보이던 문제를 수정했습니다.
- 백업/복원 후 남는 깨진 DB 기록을 정리하도록 했습니다.
- 상단 문구를 **채팅/프로젝트/백업/진단 요약**으로 바꿨습니다.

### 사용성 개선
- 검색어를 입력하면 결과 프로젝트가 자동으로 펼쳐집니다.
- **압축 고려** 뱃지는 제거하고 새 채팅 권장 기준만 남겼습니다.
- 새 채팅 권장 뱃지에 설명 툴팁을 추가했습니다.
- 보조 패널은 화면을 넘지 않고 내부에서 스크롤됩니다.
- 사용 가이드에 작은 **이스터에그**를 넣었습니다.`;

const $ = (selector) => document.querySelector(selector);

let modalResolve = null;
let modalPreviousFocus = null;
let modalInputMode = false;
let activeTooltipHost = null;
let updateInfo = null;
const FANFARE_GUIDE_SEQUENCE = ["1", "5", "2", "4", "3"];
let fanfareGuideProgress = [];

const issueLabels = {
  "missing-db-thread": "DB 스레드 없음",
  "missing-session-file": "세션 파일 없음",
  "cwd-mismatch": "CWD 불일치",
  "non-canonical-session-file": "비정규 파일명",
  "duplicate-session-files": "중복 세션 파일",
  "rollout-path-differs": "파일 경로 불일치",
  "missing-session-index": "세션 인덱스 없음",
  "missing-project-path": "프로젝트 경로 없음",
  "missing-codex-project-registration": "Codex 목록 참조 없음",
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

function chatSizeAdvice(size) {
  const mb = size / 1024 / 1024;
  if (mb >= 50) return { level: "danger", label: "새 채팅 강력 권장", detail: "파일 용량은 정확한 토큰 기준은 아니지만, 이 정도면 핵심 상태만 요약해 새 채팅으로 옮기는 편이 안정적입니다." };
  if (mb >= 30) return { level: "danger", label: "새 채팅 권장", detail: "오래된 로그와 결정이 섞일 수 있습니다. 특별한 이유가 없으면 요약 후 새 채팅을 권장합니다." };
  if (mb >= 15) return { level: "warning", label: "새 채팅 고려", detail: "아직 계속 쓸 수 있지만, 작업 단위가 바뀌었거나 답변이 산만해지면 새 채팅이 낫습니다." };
  return null;
}

function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("ko-KR");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIcons(root = document) {
  window.lucide?.createIcons({ root });
}

function tooltipElement() {
  let tooltip = document.querySelector(".global-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "global-tooltip";
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function showGlobalTooltip(host) {
  const text = host?.dataset?.disabledTooltip || host?.dataset?.tooltip || host?.getAttribute("title");
  if (!text) return;
  activeTooltipHost = host;
  const tooltip = tooltipElement();
  tooltip.textContent = text;
  tooltip.hidden = false;

  const rect = host.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 8;
  let left = rect.right - tooltipRect.width;
  let top = rect.bottom + gap;

  left = Math.max(12, Math.min(left, window.innerWidth - tooltipRect.width - 12));
  if (top + tooltipRect.height > window.innerHeight - 12) top = rect.top - tooltipRect.height - gap;
  top = Math.max(12, top);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderPatchNotesMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;

  const closeList = () => {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = /^(#{2,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^-\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (!listOpen) {
        html.push('<ul class="patch-notes-list">');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  return html.join("");
}

function hideGlobalTooltip(host = null) {
  if (host && host !== activeTooltipHost) return;
  activeTooltipHost = null;
  const tooltip = document.querySelector(".global-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function showFanfare() {
  const overlay = $("#fanfareOverlay");
  if (!overlay) return;
  const colors = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"];
  const halfWidth = window.innerWidth / 2;
  const halfHeight = window.innerHeight / 2;
  const targetX = 0;
  const targetY = Math.round(window.innerHeight * 0.4 - halfHeight);
  const pieces = Array.from({ length: 42 }, (_, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const sideIndex = Math.floor(index / 2);
    const originX = Math.round(side * (halfWidth - 8));
    const originY = Math.round(halfHeight - 8);
    const targetAngle = Math.atan2(targetY - originY, targetX - originX);
    const spread = (-18 + (sideIndex % 7) * 6 + (Math.floor(sideIndex / 7) - 1) * 4) * (Math.PI / 180);
    const targetDistance = Math.hypot(targetX - originX, targetY - originY);
    const distanceRatio = 0.28 + ((sideIndex * 5) % 13) * 0.065;
    const distance = targetDistance * distanceRatio;
    const x = Math.round(originX + Math.cos(targetAngle + spread) * distance);
    const y = Math.round(originY + Math.sin(targetAngle + spread) * distance);
    const color = colors[index % colors.length];
    const rotation = (index * 37) % 180;
    return `<span class="fanfare-confetti" style="--confetti-origin-x: ${originX}px; --confetti-origin-y: ${originY}px; --confetti-x: ${x}px; --confetti-y: ${y}px; --confetti-color: ${color}; --confetti-rotation: ${rotation}deg;"></span>`;
  }).join("");
  overlay.innerHTML = `<div class="fanfare-burst" role="presentation">
    ${pieces}
  </div>`;
  overlay.hidden = false;
  window.setTimeout(() => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }, 1650);
}

function recordGuideFanfareStep(order) {
  if (!order) return;
  fanfareGuideProgress.push(order);
  fanfareGuideProgress = fanfareGuideProgress.slice(-FANFARE_GUIDE_SEQUENCE.length);
  const matched = FANFARE_GUIDE_SEQUENCE.every((value, index) => fanfareGuideProgress[index] === value);
  if (!matched) return;
  fanfareGuideProgress = [];
  showFanfare();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청 실패");
  return data;
}

function startHeartbeat() {
  const send = () => {
    fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
  };
  send();
  setInterval(send, 2000);
}

function renderCodexProcessStatus() {
  const el = $("#codexProcessStatus");
  if (!el) return;
  const indicator = document.querySelector(".settings-header-separator");
  el.classList.toggle("open", !!codexStatus.open);
  el.classList.toggle("closed", codexStatus.open === false);
  indicator?.classList.toggle("open", !!codexStatus.open);
  indicator?.classList.toggle("closed", codexStatus.open === false);
  if (codexStatus.unknown) {
    el.textContent = "확인 중...";
    return;
  }
  el.textContent = codexStatus.open ? "실행 중" : "종료됨";
}

async function refreshCodexProcessStatus({ rerender = false } = {}) {
  try {
    const next = await api("/api/codex-status");
    const changed = codexStatus.open !== next.open || codexStatus.unknown;
    codexStatus = { ...next, unknown: false };
    renderCodexProcessStatus();
    if (rerender && changed && state) renderGroups();
  } catch {
    codexStatus = { open: true, unknown: true };
    renderCodexProcessStatus();
    if (rerender && state) renderGroups();
  }
}

function startCodexProcessPolling() {
  refreshCodexProcessStatus({ rerender: true }).catch(() => {});
  setInterval(() => {
    refreshCodexProcessStatus({ rerender: true }).catch(() => {});
  }, 1000);
}

function closeModal(result) {
  const modal = $("#appModal");
  if (!modal || modal.hidden) return;
  const metaEl = $("#appModalMeta");
  const inputWrap = $("#appModalInputWrap");
  const input = $("#appModalInput");
  if (result === true && modalInputMode) result = input.value;
  modal.hidden = true;
  delete modal.dataset.variant;
  metaEl.hidden = true;
  metaEl.textContent = "";
  inputWrap.hidden = true;
  input.value = "";
  modalInputMode = false;
  document.body.classList.remove("modal-open");
  if (modalResolve) modalResolve(result);
  modalResolve = null;
  modalPreviousFocus?.focus?.();
  modalPreviousFocus = null;
}

function showModal({ title = "확인", message = "", confirmText = "확인", cancelText = null, danger = false, variant = "", meta = "" } = {}) {
  const modal = $("#appModal");
  const titleEl = $("#appModalTitle");
  const metaEl = $("#appModalMeta");
  const messageEl = $("#appModalMessage");
  const confirmButton = $("#appModalConfirm");
  const cancelButton = $("#appModalCancel");
  const inputWrap = $("#appModalInputWrap");
  const input = $("#appModalInput");
  if (modalResolve) closeModal(false);
  modalPreviousFocus = document.activeElement;
  modalInputMode = false;
  if (variant) modal.dataset.variant = variant;
  else delete modal.dataset.variant;
  titleEl.textContent = title;
  metaEl.textContent = meta;
  metaEl.hidden = !meta;
  if (variant === "patch-notes") messageEl.innerHTML = renderPatchNotesMarkdown(message);
  else messageEl.textContent = message;
  inputWrap.hidden = true;
  input.value = "";
  confirmButton.textContent = confirmText;
  confirmButton.className = danger ? "danger" : "primary";
  cancelButton.textContent = cancelText || "";
  cancelButton.hidden = !cancelText;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  confirmButton.focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function showPrompt(message, options = {}) {
  const modal = $("#appModal");
  const titleEl = $("#appModalTitle");
  const messageEl = $("#appModalMessage");
  const confirmButton = $("#appModalConfirm");
  const cancelButton = $("#appModalCancel");
  const inputWrap = $("#appModalInputWrap");
  const inputLabel = $("#appModalInputLabel");
  const input = $("#appModalInput");
  if (modalResolve) closeModal(false);
  modalPreviousFocus = document.activeElement;
  modalInputMode = true;
  delete modal.dataset.variant;
  $("#appModalMeta").hidden = true;
  $("#appModalMeta").textContent = "";
  titleEl.textContent = options.title || "입력";
  messageEl.textContent = String(message || "");
  inputLabel.textContent = options.label || "입력";
  input.value = options.value || "";
  input.placeholder = options.placeholder || "";
  inputWrap.hidden = false;
  confirmButton.textContent = options.confirmText || "확인";
  confirmButton.className = options.danger ? "danger" : "primary";
  cancelButton.textContent = options.cancelText || "취소";
  cancelButton.hidden = false;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  input.focus();
  input.select();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function showAlert(message, title = "알림", options = {}) {
  return showModal({
    title,
    message: String(message || ""),
    confirmText: "확인",
    variant: options.variant || "",
    meta: options.meta || "",
  });
}

async function maybeShowUpdateNotice() {
  const notice = await api("/api/update-notice");
  if (!notice.show) return;
  const updatedAtMs = Date.parse(notice.updatedAt || "");
  const updatedAtText = Number.isFinite(updatedAtMs) ? `업데이트 일시: ${formatDate(updatedAtMs)}` : "";
  const title = `${notice.currentVersion ? `${notice.currentVersion} ` : ""}업데이트 내용`;
  await showAlert(PATCH_NOTES_PREVIEW, title, {
    variant: "patch-notes",
    meta: updatedAtText,
  });
  await api("/api/update-notice/read", { method: "POST", body: JSON.stringify({}) });
}

function showConfirm(message, options = {}) {
  return showModal({
    title: options.title || "확인",
    message: String(message || ""),
    confirmText: options.confirmText || "확인",
    cancelText: options.cancelText || "취소",
    danger: options.danger || false,
  });
}

function showError(error) {
  return showAlert(error?.message || String(error), "오류");
}

function renderLoadingOverlay(label) {
  return `<div class="loading-overlay" data-loading-overlay role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span>${escapeHtml(label)}</span>
  </div>`;
}

function setLoadingOverlay(target, label) {
  if (!target) return;
  target.dataset.loadingHost = "true";
  target.setAttribute("aria-busy", "true");
  target.querySelector("[data-loading-overlay]")?.remove();
  target.insertAdjacentHTML("beforeend", renderLoadingOverlay(label));
}

function clearLoadingOverlay(target) {
  if (!target) return;
  target.querySelector("[data-loading-overlay]")?.remove();
  target.removeAttribute("data-loading-host");
  target.removeAttribute("aria-busy");
}

function setLoading({ threads = false, backups = false } = {}) {
  if (threads) setLoadingOverlay($("#threadGroups"), "채팅 목록을 불러오는 중...");
  if (backups) setLoadingOverlay($("#backupsList"), "백업 목록을 불러오는 중...");
}

function updateSearchClearButton() {
  $("#clearSearchButton").disabled = $("#searchInput").value.length === 0;
}

let sideColumnLayoutFrame = null;

function updateSideColumnLayout() {
  sideColumnLayoutFrame = null;
  const sideColumn = document.querySelector(".side-column");
  if (!sideColumn) return;
  if (window.matchMedia("(max-width: 1200px)").matches) {
    sideColumn.style.removeProperty("--side-max-height");
    return;
  }
  const top = Math.max(24, sideColumn.getBoundingClientRect().top);
  sideColumn.style.setProperty("--side-max-height", `${Math.max(320, window.innerHeight - top - 24)}px`);
}

function queueSideColumnLayout() {
  if (sideColumnLayoutFrame !== null) return;
  sideColumnLayoutFrame = window.requestAnimationFrame(updateSideColumnLayout);
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

function renderUpdateStatus(info = updateInfo) {
  const statusText = $("#updateStatusText");
  const updateButton = $("#updateButton");
  if (!statusText || !updateButton) return;
  const setButton = (action, label, icon) => {
    updateButton.dataset.updateAction = action;
    updateButton.innerHTML = `<span class="button-icon" data-lucide="${icon}" aria-hidden="true"></span>${label}`;
    updateButton.disabled = false;
    lucide.createIcons();
  };
  if (!info) {
    statusText.textContent = "업데이트 확인 전";
    setButton("check", "업데이트 확인", "refresh-cw");
    return;
  }
  if (info.error) {
    statusText.textContent = `확인 실패: ${info.error}`;
    setButton("check", "업데이트 확인", "refresh-cw");
    return;
  }
  if (info.available) {
    const label = info.label || info.latestVersion || "새 버전";
    statusText.textContent = `업데이트 가능: ${label}`;
    setButton("install", "업데이트", "download");
    return;
  }
  statusText.textContent = info.reason || "최신 상태입니다.";
  setButton("check", "업데이트 확인", "refresh-cw");
}

async function checkUpdateStatus(options = {}) {
  const statusText = $("#updateStatusText");
  const updateButton = $("#updateButton");
  if (statusText) statusText.textContent = "업데이트 확인 중...";
  if (updateButton) updateButton.disabled = true;
  try {
    updateInfo = await api("/api/update-status");
    renderUpdateStatus();
    if (!options.silent && updateInfo.error) await showAlert(updateInfo.error, "업데이트 확인 실패");
  } finally {
    if (updateButton) updateButton.disabled = false;
  }
}

async function installAvailableUpdate() {
  if (!updateInfo?.available) await checkUpdateStatus({ silent: true });
  if (!updateInfo?.available) {
    await showAlert(updateInfo?.error || updateInfo?.reason || "설치할 업데이트가 없습니다.", "업데이트");
    return;
  }
  const label = updateInfo.label || updateInfo.latestVersion || "새 버전";
  const ok = await showConfirm(
    `${label} 업데이트를 설치할까요?\n\n현재 앱 파일은 updates/backup-* 폴더에 백업되고, 설치 후 프로그램이 다시 시작됩니다.`,
    { confirmText: "설치" },
  );
  if (!ok) return;
  $("#updateStatusText").textContent = "업데이트 설치를 시작합니다...";
  $("#updateButton").disabled = true;
  await api("/api/update", { method: "POST", body: JSON.stringify({}) });
  document.body.innerHTML = `<main class="shutdown-screen">
    <section class="panel">
      <h1>업데이트 설치 중</h1>
      <p>서버가 종료된 뒤 새 버전으로 다시 시작됩니다.</p>
    </section>
  </main>`;
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

function recordTitle(record) {
  return record.index?.thread_name || record.thread?.title || record.thread?.first_user_message || "(채팅 이름 없음)";
}

function recordUpdatedAt(record) {
  return record.thread?.updated_at_ms || record.primaryFile?.mtimeMs || 0;
}

function recordText(record) {
  return [
    record.id,
    recordTitle(record),
    record.project,
    record.thread?.cwd,
    record.primaryFile?.cwd,
    record.thread?.rollout_path,
    record.primaryFile?.path,
    record.thread?.agent_nickname,
    record.primaryFile?.agentNickname,
    record.thread?.git_branch,
    record.primaryFile?.gitBranch,
    record.issues.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function groupRecords(group) {
  return [group.parent, ...group.children].filter(Boolean);
}

function isLikelyGeneralChatPath(path) {
  return /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(String(path || ""));
}

function isGeneralChatRecord(record) {
  return Boolean(record?.projectless || isLikelyGeneralChatPath(record?.project || record?.thread?.cwd || record?.primaryFile?.cwd));
}

function isGeneralChatGroup(group) {
  return Boolean(group?.projectless || isLikelyGeneralChatPath(group?.project) || groupRecords(group).some(isGeneralChatRecord));
}

function groupProject(group) {
  if (isGeneralChatGroup(group)) return GENERAL_CHAT_LABEL;
  return group.project || group.parent?.project || group.children[0]?.project || "(프로젝트 없음)";
}

function hasProjectSearchMatch(query) {
  if (!query) return false;
  return state.groups.some((group) => groupProject(group).toLowerCase().includes(query));
}

function groupMatches(group, options = {}) {
  const query = options.query ?? $("#searchInput").value.trim().toLowerCase();
  const issue = options.issue ?? $("#issueFilter").value;
  const project = options.project ?? $("#projectFilter").value;
  const projectSearch = options.projectSearch ?? false;
  const records = [group.parent, ...group.children].filter(Boolean);
  if (issue && !records.some((record) => record.issues.includes(issue))) return false;
  if (project && groupProject(group) !== project) return false;
  if (!query) return true;
  if (projectSearch) return groupProject(group).toLowerCase().includes(query);
  if (groupProject(group).toLowerCase().includes(query)) return true;
  return records.some((record) => recordText(record).includes(query));
}

function filteredGroups() {
  const query = $("#searchInput").value.trim().toLowerCase();
  const options = {
    query,
    issue: $("#issueFilter").value,
    project: $("#projectFilter").value,
    projectSearch: hasProjectSearchMatch(query),
  };
  return state.groups.filter((group) => groupMatches(group, options));
}

function renderGroups() {
  const groups = filteredGroups();
  $("#threadGroups").innerHTML = renderProjectSections(groups.slice(0, 300));
  updateSelectionBar();
  renderIcons($("#threadGroups"));
}

function renderProjectSections(groups) {
  if (groups.length === 0) return `<div class="empty">현재 필터와 일치하는 채팅이 없습니다.</div>`;
  const projectEntries = [...buildProjectMap(groups).entries()].filter(([project, projectGroups]) => {
    if (project !== "/Users/andy/Documents/Codex") return true;
    return projectGroups.some((group) => groupRecords(group).length > 0);
  });
  if (projectEntries.length === 0) return `<div class="empty">현재 필터와 일치하는 채팅이 없습니다.</div>`;
  projectEntries.sort(([a], [b]) => {
    if (a === GENERAL_CHAT_LABEL && b !== GENERAL_CHAT_LABEL) return -1;
    if (b === GENERAL_CHAT_LABEL && a !== GENERAL_CHAT_LABEL) return 1;
    return 0;
  });
  return projectEntries.map(([project, projectGroups]) => renderProjectSection(project, projectGroups)).join("");
}

function buildProjectMap(groups) {
  const projectMap = new Map();
  for (const group of groups) {
    const project = groupProject(group);
    if (!projectMap.has(project)) projectMap.set(project, []);
    projectMap.get(project).push(group);
  }
  return projectMap;
}

function renderProjectThreadList(projectGroups) {
  const agentCount = projectGroups.reduce((sum, group) => sum + group.children.length, 0);
  const chatCount = projectGroups.reduce((sum, group) => sum + (group.parent ? 1 : 0), 0);
  const renderedGroups = projectGroups.map((group) => renderGroup(group)).filter(Boolean);
  return `<div class="project-thread-list">${chatCount + agentCount === 0 || renderedGroups.length === 0 ? `<div class="empty">채팅 없음</div>` : renderedGroups.join("")}</div>`;
}

function renderProjectSection(project, projectGroups) {
  const agentCount = projectGroups.reduce((sum, group) => sum + group.children.length, 0);
  const chatCount = projectGroups.reduce((sum, group) => sum + (group.parent ? 1 : 0), 0);
  const projectId = projectKey(project);
  const isExpanded = expandedProjects.has(projectId);
  const isNoProject = project === "(프로젝트 없음)";
  const isGeneralChat = project === GENERAL_CHAT_LABEL;
  const deleteIds = projectGroups.map((group) => group.parent?.id).filter(Boolean);
  const statusTags = renderProjectStatusTags(projectGroups, { generalChat: isGeneralChat });
  const hasMissingProjectPath = projectGroups.some((group) =>
    groupRecords(group).some((record) => record.issues.includes("missing-project-path")),
  );
  const hasMissingCodexRegistration = projectGroups.some(
    (group) =>
      (group.projectIssues || []).includes("missing-codex-project-registration") ||
      groupRecords(group).some((record) => record.issues.includes("missing-codex-project-registration")),
  );
  const hasAutoRepairableChats = projectGroups.some((group) =>
    groupRecords(group).some(
      (record) => record.primaryFile && (record.issues.includes("missing-session-index") || record.issues.includes("missing-db-thread")),
    ),
  );
  const codexIsOpen = codexStatus.open !== false;
  const codexClosedTooltip = "Codex를 완전히 종료한 뒤 사용할 수 있습니다.";
  const codexClosedOnlyAttrs = codexIsOpen ? " disabled" : "";
  const renderCodexClosedOnlyButton = (buttonHtml) =>
    codexIsOpen ? `<span class="disabled-tooltip-host" data-disabled-tooltip="${escapeHtml(codexClosedTooltip)}">${buttonHtml}</span>` : buttonHtml;
  return `<section class="project-section" data-project-section="${escapeHtml(projectId)}">
    <div class="project-header" data-project-toggle="${escapeHtml(projectId)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
      <span class="project-toggle-indicator" aria-hidden="true"></span>
      <div class="project-summary">
        <h3>${escapeHtml(project)}</h3>
        <div class="project-meta">
          <span>${chatCount}개 채팅 · ${agentCount}개 agent</span>
          ${statusTags}
        </div>
      </div>
      <span class="project-actions">
        ${!isGeneralChat && hasAutoRepairableChats ? `<button class="small" type="button" data-repair-chats="${escapeHtml(project)}">채팅 자동 복구</button>` : ""}
        ${!isGeneralChat && !isNoProject && !hasMissingProjectPath && !hasMissingCodexRegistration ? renderCodexClosedOnlyButton(`<button class="small" type="button" data-move-project="${escapeHtml(project)}"${codexClosedOnlyAttrs}>프로젝트 경로 변경</button>`) : ""}
        ${!isGeneralChat && !isNoProject && !hasMissingProjectPath && !hasMissingCodexRegistration ? renderCodexClosedOnlyButton(`<button class="small" type="button" data-rename-project="${escapeHtml(project)}"${codexClosedOnlyAttrs}>프로젝트명 변경</button>`) : ""}
        ${!isGeneralChat && hasMissingProjectPath ? renderCodexClosedOnlyButton(`<button class="small" type="button" data-repair-project="${escapeHtml(project)}"${codexClosedOnlyAttrs}>경로 재설정</button>`) : ""}
        ${!isGeneralChat && hasMissingCodexRegistration && !hasMissingProjectPath ? renderCodexClosedOnlyButton(`<button class="small" type="button" data-repair-project-registration="${escapeHtml(project)}"${codexClosedOnlyAttrs}>참조 복구</button>`) : ""}
        ${!isGeneralChat && !isNoProject ? renderCodexClosedOnlyButton(`<button class="danger small" type="button" data-remove-project="${escapeHtml(project)}" data-project-chat-count="${chatCount}" data-project-agent-count="${agentCount}"${codexClosedOnlyAttrs}>프로젝트 제거</button>`) : ""}
        ${!isGeneralChat && isNoProject ? `<button class="danger small" type="button" data-delete-projectless="${escapeHtml(deleteIds.join(","))}" data-delete-count="${deleteIds.length}">전체 삭제</button>` : ""}
      </span>
    </div>
    ${isExpanded ? renderProjectThreadList(projectGroups) : ""}
  </section>`;
}

function renderProjectStatusTags(projectGroups, options = {}) {
  const issues = new Set();
  for (const group of projectGroups) {
    for (const issue of group.projectIssues || []) issues.add(issue);
    for (const record of groupRecords(group)) {
      for (const issue of record.issues) issues.add(issue);
    }
  }
  if (options.generalChat) {
    issues.delete("missing-project-path");
    issues.delete("missing-codex-project-registration");
  }
  if (issues.size === 0) return `<span class="pill ok">정상</span>`;
  return [...issues]
    .sort()
    .map((issue) => `<span class="pill issue">${escapeHtml(issueLabels[issue] || issue)}</span>`)
    .join("");
}

function projectKey(project) {
  return `project:${project}`;
}

function projectFromKey(projectId) {
  return String(projectId || "").startsWith("project:") ? projectId.slice("project:".length) : "";
}

function toggleProjectSection(projectId) {
  const section = [...document.querySelectorAll("[data-project-section]")].find((candidate) => candidate.dataset.projectSection === projectId);
  const header = section?.querySelector("[data-project-toggle]");
  if (!section || !header) return;
  const isExpanded = expandedProjects.has(projectId);
  if (isExpanded) {
    expandedProjects.delete(projectId);
    header.setAttribute("aria-expanded", "false");
    section.querySelector(".project-thread-list")?.remove();
    return;
  }

  expandedProjects.add(projectId);
  header.setAttribute("aria-expanded", "true");
  if (!section.querySelector(".project-thread-list")) {
    const projectGroups = buildProjectMap(filteredGroups().slice(0, 300)).get(projectFromKey(projectId)) || [];
    section.insertAdjacentHTML("beforeend", renderProjectThreadList(projectGroups));
  }
}

function findProjectSection(project) {
  const projectId = projectKey(project);
  return [...document.querySelectorAll("[data-project-section]")].find((section) => section.dataset.projectSection === projectId);
}

function setProjectSectionLoading(project, label) {
  const section = findProjectSection(project);
  if (!section) {
    setLoading({ threads: true });
    return;
  }
  setLoadingOverlay(section, label);
}

function updateProjectSections(from, to) {
  normalizeSelectedThreads();
  const groups = filteredGroups().slice(0, 300);
  if (groups.length === 0) {
    $("#threadGroups").innerHTML = renderProjectSections(groups);
    updateSelectionBar();
    renderIcons($("#threadGroups"));
    return;
  }

  const projectMap = buildProjectMap(groups);
  const fromSection = findProjectSection(from);
  const toSection = findProjectSection(to);
  const toGroups = projectMap.get(to);
  const fromGroups = projectMap.get(from);

  if (from === to) {
    if (fromSection && fromGroups) fromSection.outerHTML = renderProjectSection(from, fromGroups);
    else if (fromSection) fromSection.remove();
    else if (fromGroups) renderGroups();
    updateSelectionBar();
    renderIcons($("#threadGroups"));
    return;
  }

  if (toSection && toGroups) toSection.outerHTML = renderProjectSection(to, toGroups);

  if (fromSection) {
    if (fromGroups) fromSection.outerHTML = renderProjectSection(from, fromGroups);
    else if (!toSection && toGroups) fromSection.outerHTML = renderProjectSection(to, toGroups);
    else fromSection.remove();
    updateSelectionBar();
    renderIcons($("#threadGroups"));
    return;
  }

  if (!fromSection && !toSection && toGroups) renderGroups();
  updateSelectionBar();
  renderIcons($("#threadGroups"));
}

function updateProjectSubset(projects) {
  normalizeSelectedThreads();
  const visibleGroups = filteredGroups().slice(0, 300);
  if (visibleGroups.length === 0) {
    $("#threadGroups").innerHTML = renderProjectSections(visibleGroups);
    updateSelectionBar();
    renderIcons($("#threadGroups"));
    return;
  }

  const projectMap = buildProjectMap(visibleGroups);
  for (const project of projects) {
    const section = findProjectSection(project);
    const projectGroups = projectMap.get(project);
    if (section && projectGroups) section.outerHTML = renderProjectSection(project, projectGroups);
    else if (section) section.remove();
  }
  updateSelectionBar();
  renderIcons($("#threadGroups"));
}

function projectSetForThreadIds(ids) {
  const idSet = new Set(ids);
  const projects = new Set();
  for (const group of state.groups || []) {
    if (groupRecords(group).some((record) => idSet.has(record.id))) {
      projects.add(groupProject(group));
    }
  }
  return projects;
}

function projectSetForThreadDelete(id, includeChildren) {
  const projects = new Set();
  for (const group of state.groups || []) {
    const records = groupRecords(group);
    if (records.some((record) => record.id === id)) projects.add(groupProject(group));
    if (includeChildren && group.parent?.id === id) projects.add(groupProject(group));
  }
  return projects;
}

function backupByPath(path) {
  return (state.backups || []).find((backup) => backup.path === path);
}

function projectSetForBackup(path) {
  const backup = backupByPath(path);
  const projects = new Set();
  const status = backup?.originalStatus;
  for (const project of status?.projects || []) projects.add(project);
  if (status?.project) projects.add(status.project);
  const threadIds = status?.threadIds?.length ? status.threadIds : status?.threadId ? [status.threadId] : [];
  for (const project of projectSetForThreadIds(threadIds)) projects.add(project);
  return projects;
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

function renderGroup(group) {
  if (!group.parent && !group.missingParentId) return "";
  const parent = group.parent;
  const id = parent?.id || `missing:${group.missingParentId}`;
  const isExpanded = expandedGroups.has(id);
  const childCount = group.children.length;
  const parentHtml = parent
    ? renderRecord(parent, { isParent: true, childCount, isExpanded, groupId: id, children: group.children })
    : renderMissingParent(group.missingParentId, childCount, isExpanded, id);
  const childrenHtml = isExpanded
    ? `<div class="agent-list">${group.children.map((child) => renderRecord(child, { isAgent: true })).join("")}</div>`
    : "";
  return `<article class="thread-group" data-group-id="${escapeHtml(id)}">
    ${parentHtml}
    ${childrenHtml}
  </article>`;
}

function renderMissingParent(parentId, childCount, isExpanded, id) {
  return `<div class="thread-row parent missing-parent">
    <div class="thread-main">
      <div class="row-head">
        <span class="pill issue">부모 세션 없음</span>
        <span class="mono">${escapeHtml(parentId)}</span>
      </div>
      <div class="title">DB에는 agent 연결이 있지만 부모 세션 레코드를 찾지 못했습니다.</div>
      <div class="meta-line">${childCount}개 agent가 이 부모 ID를 참조합니다.</div>
    </div>
    <div class="thread-actions">
      ${renderAgentToggle(id, childCount, isExpanded)}
    </div>
  </div>`;
}

function renderRecord(record, options = {}) {
  const isAgent = options.isAgent || record.role === "agent";
  const roleLabel = isAgent ? "agent" : "user";
  const roleClass = isAgent ? "agent" : "user";
  const name = record.thread?.agent_nickname || record.primaryFile?.agentNickname || "";
  const agentRole = record.thread?.agent_role || record.primaryFile?.agentRole || "";
  const parentInfo = isAgent && record.parentId ? `<div class="meta-line">부모 세션: <span class="mono">${escapeHtml(record.parentId)}</span></div>` : "";
  const issues = renderIssues(record);
  const files = record.files.map(renderFile).join("");
  const deleteButton = renderDeleteButton(record, options.childCount || 0);
  const repairButton = renderThreadRepairButton(record);
  const selectCheckbox = renderThreadSelect(record, options);
  const ownSize = recordSize(record);
  const totalSize = options.children ? ownSize + options.children.reduce((sum, child) => sum + recordSize(child), 0) : ownSize;
  const sizeLabel = options.isParent && options.childCount > 0 ? `${formatBytes(ownSize)} · agent 포함 ${formatBytes(totalSize)}` : formatBytes(ownSize);
  const sizeAdvice = chatSizeAdvice(totalSize);
  const sizeAdvicePill = sizeAdvice
    ? `<span class="pill size-advice ${escapeHtml(sizeAdvice.level)}" data-tooltip="${escapeHtml(sizeAdvice.detail)}">${escapeHtml(sizeAdvice.label)}</span>`
    : "";
  const sizeAdviceDetail = sizeAdvice
    ? `<span class="size-advice-inline ${escapeHtml(sizeAdvice.level)}">${escapeHtml(sizeAdvice.label)}</span>`
    : "";
  return `<div class="thread-row ${options.isParent ? "parent" : ""} ${isAgent ? "agent" : ""}" data-thread-row="${escapeHtml(record.id)}">
    ${selectCheckbox}
    <div class="thread-main">
      <div class="row-head">
        ${isAgent ? `<span class="pill ${roleClass}">${roleLabel}</span>` : ""}
        ${name ? `<span class="pill">${escapeHtml(name)}</span>` : ""}
        ${agentRole ? `<span class="pill">${escapeHtml(agentRole)}</span>` : ""}
        ${issues}
        ${sizeAdvicePill}
      </div>
      <div class="title">${escapeHtml(recordTitle(record))}</div>
      <div class="meta-grid">
        <div><span>채팅 ID</span><strong class="mono">${escapeHtml(record.id)}</strong></div>
        <div><span>수정일</span><strong>${escapeHtml(formatDate(recordUpdatedAt(record)))}</strong></div>
        <div><span>브랜치</span><strong class="mono">${escapeHtml(record.thread?.git_branch || record.primaryFile?.gitBranch || "")}</strong></div>
        <div><span>파일 용량</span><strong>${escapeHtml(sizeLabel)}</strong>${sizeAdviceDetail}</div>
      </div>
      ${parentInfo}
      <details class="details">
        <summary>경로와 파일 상태</summary>
        <div class="detail-grid">
          <div><span>DB CWD</span><code>${escapeHtml(record.thread?.cwd || "")}</code></div>
          <div><span>JSONL CWD</span><code>${escapeHtml(record.primaryFile?.cwd || "")}</code></div>
          <div><span>DB rollout_path</span><code>${escapeHtml(record.thread?.rollout_path || "")}</code></div>
        </div>
        <div class="file-list">${files || "<p>연결된 세션 파일 없음</p>"}</div>
      </details>
    </div>
    <div class="thread-actions">
      ${deleteButton}
      ${repairButton}
      ${options.isParent ? renderAgentToggle(options.groupId, options.childCount, options.isExpanded) : ""}
    </div>
  </div>`;
}

function renderThreadSelect(record, options = {}) {
  const childIds = (options.children || []).map((child) => child.id);
  const label = record.role === "agent" ? "Agent 선택" : "채팅 선택";
  return `<label class="thread-select" title="${label}" aria-label="${label}">
    <input
      type="checkbox"
      data-select-thread="${escapeHtml(record.id)}"
      data-select-role="${escapeHtml(record.role)}"
      data-select-parent="${escapeHtml(record.parentId || "")}"
      data-select-children="${escapeHtml(childIds.join(","))}"
      ${selectedThreads.has(record.id) ? "checked" : ""}
    />
  </label>`;
}

function recordSize(record) {
  return (record.files || []).reduce((sum, file) => sum + Number(file.size || 0), 0);
}

function renderDeleteButton(record, childCount) {
  const label = record.role === "agent" ? "Agent 삭제" : "채팅 삭제";
  return `<button class="danger small" type="button" data-delete-thread="${escapeHtml(record.id)}" data-delete-title="${escapeHtml(recordTitle(record))}" data-delete-role="${escapeHtml(record.role)}" data-child-count="${childCount}">${label}</button>`;
}

function renderThreadRepairButton(record) {
  const canRepair =
    record.primaryFile && (record.issues.includes("missing-session-index") || record.issues.includes("missing-db-thread"));
  if (!canRepair) return "";
  return `<button class="small" type="button" data-repair-thread="${escapeHtml(record.id)}" data-repair-title="${escapeHtml(recordTitle(record))}">복구</button>`;
}

function renderAgentToggle(groupId, childCount, isExpanded) {
  if (!childCount) return "";
  return `<button class="agent-toggle" type="button" data-toggle="${escapeHtml(groupId)}" aria-expanded="${isExpanded}">
    ${isExpanded ? "Agent 숨기기" : `Agent ${childCount}개 보기`}
  </button>`;
}

function renderIssues(record) {
  const issues = isGeneralChatRecord(record)
    ? record.issues.filter((issue) => issue !== "missing-project-path" && issue !== "missing-codex-project-registration")
    : record.issues;
  if (issues.length === 0) return `<span class="pill ok">정상</span>`;
  return issues
    .map((issue) => `<span class="pill issue">${escapeHtml(issueLabels[issue] || issue)}</span>`)
    .join("");
}

function renderFile(file) {
  const deleteAction = file.isBak
    ? `<button class="danger small" type="button" data-delete="${escapeHtml(file.path)}">파일 삭제</button>`
    : `<span class="muted">-</span>`;
  return `<div class="file-item">
    <span class="mono">${escapeHtml(file.relativePath)}</span>
    <span>${formatBytes(file.size)}</span>
    <span>${file.canonicalName ? "정규 파일명" : "비정규 파일명"}</span>
    ${deleteAction}
  </div>`;
}

function renderBackups() {
  const backups = state.backups;
  normalizeSelectedBackups();
  const unknownOriginalCount = backups.filter(isUnknownOriginalBackup).length;
  $("#deleteUnknownBackupsButton").disabled = unknownOriginalCount === 0;
  $("#deleteUnknownBackupsButton").title =
    unknownOriginalCount === 0 ? "원본 확인 불가 백업이 없습니다." : `원본 확인 불가 백업 ${unknownOriginalCount}개 삭제`;
  updateBackupSelectionButton();
  $("#backupsList").innerHTML =
    backups
      .map(
        (backup) => `<div class="backup-row">
          ${renderBackupSelect(backup)}
          <span class="pill">${escapeHtml(backupTypeLabel(backup.type))}</span>
          <div>
            <div class="mono path">${escapeHtml(backup.relativePath)}</div>
            ${renderBackupDescription(backup)}
            <div>${escapeHtml(formatDate(backup.mtimeMs))}</div>
          </div>
          ${renderBackupOriginalStatus(backup)}
          <span>${formatBytes(backup.size)}</span>
          <span class="backup-actions">
            <button data-restore-backup="${escapeHtml(backup.path)}" ${backup.restorable?.possible ? "" : "disabled"}>되돌리기</button>
            <button class="danger" data-delete="${escapeHtml(backup.path)}" ${backup.deletable ? "" : "disabled"}>삭제</button>
          </span>
        </div>`,
      )
      .join("") || renderEmptyBackups();
  renderIcons($("#backupsList"));
}

function renderEmptyBackups() {
  return `<div class="backup-empty">
    <div class="backup-empty-icon" aria-hidden="true">
      <span data-lucide="folder-x"></span>
    </div>
    <h3>아직 생성된 백업이 없습니다</h3>
    <p>복구·수정·삭제 작업 전 자동 백업이 생성됩니다.<br />백업이 생기면 이곳에서 되돌리기와 삭제를 할 수 있습니다.</p>
  </div>`;
}

function renderBackupSelect(backup) {
  return `<label class="backup-select" title="백업 선택" aria-label="백업 선택">
    <input
      type="checkbox"
      data-select-backup="${escapeHtml(backup.path)}"
      ${selectedBackups.has(backup.path) ? "checked" : ""}
      ${backup.deletable ? "" : "disabled"}
    />
  </label>`;
}

function normalizeSelectedBackups() {
  const deletablePaths = new Set((state.backups || []).filter((backup) => backup.deletable).map((backup) => backup.path));
  for (const path of [...selectedBackups]) {
    if (!deletablePaths.has(path)) selectedBackups.delete(path);
  }
}

function updateBackupSelectionButton() {
  const button = $("#deleteSelectedBackupsButton");
  const count = selectedBackups.size;
  button.disabled = count === 0;
  button.textContent = count === 0 ? "선택 삭제" : `선택 삭제 (${count})`;
}

function isUnknownOriginalBackup(backup) {
  const status = backup.originalStatus;
  return (!status || status.kind === "unknown" || status.total === 0) && !backup.restorable?.possible;
}

function renderBackupDescription(backup) {
  const description = backup.description || {};
  const detail = backupDescriptionDetail(backup);
  const backupId = backup.id ? `#${backup.id}` : "";
  if (!backupId && !description.label && !detail) return "";
  return `<div class="backup-description">
    ${(backupId || description.label) ? `<div class="backup-description-tags">
      ${backupId ? `<span class="pill backup-id">${escapeHtml(backupId)}</span>` : ""}
      ${description.label ? `<span class="pill">${escapeHtml(description.label)}</span>` : ""}
    </div>` : ""}
    ${detail ? `<div class="backup-description-detail">${escapeHtml(detail)}</div>` : ""}
  </div>`;
}

function backupDescriptionDetail(backup) {
  const description = backup.description || {};
  if (description.label === "되돌리기 전 자동 백업" && description.sourcePath) {
    const sourceBackup = backupByPath(description.sourcePath);
    if (sourceBackup?.id) {
      const sourceDetail = backupSourceDetail(sourceBackup);
      return `#${sourceBackup.id}${sourceDetail ? ` ${sourceDetail}` : ""} 되돌리기 전 상태`;
    }
    if (description.sourceRelativePath) return `${description.sourceRelativePath} 되돌리기 전 상태`;
  }
  return description.detail || "";
}

function backupSourceDetail(backup) {
  const description = backup.description || {};
  if (description.detail) return description.detail;
  return description.label || "";
}

function renderBackupOriginalStatus(backup) {
  const status = backup.originalStatus;
  const projectText = backupOriginalProjectText(status);
  const inspectButton = backupOriginalInspectButton(status);
  if (status?.kind === "config-snapshot") {
    return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill ok">설정 스냅샷</span><span class="mono origin-project">config.toml</span></div></div>`;
  }
  if (!status || status.kind === "unknown" || status.total === 0) {
    if (backup.restorable?.possible) {
      return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill ok">스냅샷 복원 가능</span>${projectText}</div>${inspectButton}</div>`;
    }
    return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill">원본 확인 불가</span>${projectText}</div>${inspectButton}</div>`;
  }
  if (status.existing === 0) {
    return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill issue">원본 제거됨</span>${projectText}</div>${inspectButton}</div>`;
  }
  if (status.missing === 0) {
    return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill ok">원본 존재</span>${projectText}</div>${inspectButton}</div>`;
  }
  return `<div class="backup-origin"><div class="backup-origin-main"><span class="pill issue">일부 제거됨 ${status.missing}/${status.total}</span>${projectText}</div>${inspectButton}</div>`;
}

function backupOriginalProjectText(status) {
  const projects = status?.projects?.length ? status.projects : status?.project ? [status.project] : [];
  if (projects.length === 0) return "";
  if (projects.length === 1) return `<span class="mono origin-project">${escapeHtml(projects[0])}</span>`;
  return `<span class="mono origin-project">${projects.length}개 프로젝트</span>`;
}

function backupOriginalInspectButton(status) {
  const ids = status?.threadIds?.length ? status.threadIds : status?.threadId ? [status.threadId] : [];
  if (ids.length !== 1 || status.existing === 0) return "";
  return `<button class="small" type="button" data-filter-thread="${escapeHtml(ids[0])}">원본 확인</button>`;
}

function backupTypeLabel(type) {
  return {
    "backup-dir": "백업 디렉터리",
    "backup-file": "백업 파일",
    "session-bak": "세션 bak",
  }[type] || type;
}

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

async function deleteBackup(path) {
  if (!(await showConfirm(`백업을 삭제할까요?\n\n${path}`, { danger: true, confirmText: "삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-backup", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  selectedBackups.delete(path);
  await reloadSections({ backups: true });
}

async function deleteSelectedBackups() {
  const paths = [...selectedBackups];
  if (paths.length === 0) return;
  if (!(await showConfirm(`선택한 백업 ${paths.length}개를 삭제할까요?`, { danger: true, confirmText: "삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-backups", {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
  selectedBackups.clear();
  await reloadSections({ backups: true });
}

async function restoreBackup(path) {
  if (!(await showConfirm(`이 백업으로 되돌릴까요?\n\n${path}\n\n현재 상태도 before_restore 백업으로 먼저 저장됩니다.`, { confirmText: "되돌리기" }))) return;
  const affectedProjects = projectSetForBackup(path);
  if (affectedProjects.size) {
    for (const project of affectedProjects) setProjectSectionLoading(project, "백업을 되돌리는 중...");
  } else {
    setLoading({ threads: true, backups: true });
  }
  await api("/api/restore-backup", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  autoExpandedGroups.clear();
  autoExpandedProjects.clear();
  await reloadProjectSubset(affectedProjects, { codexHome: true });
}

async function deleteAllBackups() {
  if (!(await showConfirm("모든 백업 디렉터리와 _bak 세션 파일을 삭제할까요?", { danger: true, confirmText: "전체 삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-all-backups", { method: "POST", body: "{}" });
  await reloadSections({ backups: true });
}

async function deleteUnknownOriginalBackups() {
  const count = state.backups.filter(isUnknownOriginalBackup).length;
  if (count === 0) {
    await showAlert("원본 확인 불가 백업이 없습니다.");
    return;
  }
  if (!(await showConfirm(`원본 확인 불가 백업 ${count}개를 삭제할까요?`, { danger: true, confirmText: "삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-unknown-original-backups", { method: "POST", body: "{}" });
  await reloadSections({ backups: true });
}

async function ensureCodexClosedForProjectChange() {
  await refreshCodexProcessStatus({ rerender: true });
  if (codexStatus.open !== false) {
    await showAlert("Codex를 완전히 종료한 뒤 다시 시도하세요.\n\nCodex가 열린 상태에서 프로젝트 경로를 바꾸면 Codex가 메모리 상태로 다시 덮어써 링크가 깨질 수 있습니다.", "Codex 실행 중");
    return false;
  }
  return true;
}

function validateProjectNameInput(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (name === "." || name === "..") return "";
  if (name.includes("/") || name.includes("\\") || name.includes(":")) return "";
  return name;
}

function projectBaseName(project) {
  return String(project || "").split("/").filter(Boolean).at(-1) || "";
}

function projectParentPath(project) {
  const value = String(project || "");
  const name = projectBaseName(value);
  return name ? value.slice(0, value.length - name.length).replace(/\/$/, "") || "/" : value;
}

async function repairProjectPath(from) {
  if (!(await ensureCodexClosedForProjectChange())) return;
  const result = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({ kind: "directory", currentPath: from }),
  });
  if (result.canceled) return;
  const to = result.path;
  if (!to || to === from) return;
  if (!(await showConfirm(`프로젝트 경로를 변경할까요?\n\n기존: ${from}\n새 경로: ${to}\n\n세션 JSONL과 SQLite threads가 함께 변경되고 백업이 생성됩니다.`, { confirmText: "변경" }))) return;
  setProjectSectionLoading(from, "프로젝트 경로를 변경하는 중...");
  await api("/api/repair-cwd", {
    method: "POST",
    body: JSON.stringify({ from, to, includeJsonl: true, includeDb: true }),
  });
  expandedProjects.delete(projectKey(from));
  expandedProjects.add(projectKey(to));
  if ($("#projectFilter").value === from) $("#projectFilter").value = to;
  state = await api("/api/summary");
  renderSubtitle();
  normalizeSelectedThreads();
  renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  updateProjectSections(from, to);
  renderBackups();
}

async function moveProjectPath(project) {
  if (!(await ensureCodexClosedForProjectChange())) return;
  const result = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({ kind: "directory", currentPath: projectParentPath(project) }),
  });
  if (result.canceled) return;
  const parent = result.path;
  const name = projectBaseName(project);
  if (!parent) return;
  const to = `${parent.replace(/\/$/, "")}/${name}`;
  if (to === project) return;
  if (
    !(await showConfirm(
      `실제 프로젝트 폴더를 이동할까요?\n\n기존 경로: ${project}\n새 경로: ${to}\n\nCodex 세션/DB/프로젝트 목록 참조도 함께 갱신합니다.`,
      { confirmText: "변경" },
    ))
  ) {
    return;
  }
  setProjectSectionLoading(project, "프로젝트 경로를 변경하는 중...");
  await api("/api/move-project", {
    method: "POST",
    body: JSON.stringify({ project, parent }),
  });
  expandedProjects.delete(projectKey(project));
  expandedProjects.add(projectKey(to));
  if ($("#projectFilter").value === project) $("#projectFilter").value = to;
  state = await api("/api/summary");
  renderSubtitle();
  normalizeSelectedThreads();
  renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  updateProjectSections(project, to);
  renderBackups();
}

async function renameProjectPath(project) {
  if (!(await ensureCodexClosedForProjectChange())) return;
  const currentName = projectBaseName(project);
  const input = await showPrompt(`실제 프로젝트 폴더명을 변경하고 Codex 참조를 함께 갱신합니다.\n\n현재 경로: ${project}\n\n새 폴더명을 입력하세요.`, {
    title: "프로젝트명 변경",
    label: "새 폴더명",
    value: currentName,
    confirmText: "변경",
  });
  if (input === false) return;
  const newName = validateProjectNameInput(input);
  if (!newName) {
    await showAlert("사용할 수 없는 폴더명입니다.", "입력 오류");
    return;
  }
  if (newName === currentName) return;
  const to = `${project.slice(0, project.length - currentName.length)}${newName}`;
  if (!(await showConfirm(`실제 프로젝트 폴더명을 변경할까요?\n\n기존 경로: ${project}\n새 경로: ${to}\n\nCodex 세션/DB/프로젝트 목록 참조도 함께 갱신합니다.`, { confirmText: "변경" }))) return;
  setProjectSectionLoading(project, "프로젝트명을 변경하는 중...");
  await api("/api/rename-project", {
    method: "POST",
    body: JSON.stringify({ project, newName }),
  });
  expandedProjects.delete(projectKey(project));
  expandedProjects.add(projectKey(to));
  if ($("#projectFilter").value === project) $("#projectFilter").value = to;
  state = await api("/api/summary");
  renderSubtitle();
  normalizeSelectedThreads();
  renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  updateProjectSections(project, to);
  renderBackups();
}

async function repairProjectRegistration(project) {
  if (!(await ensureCodexClosedForProjectChange())) return;
  setProjectSectionLoading(project, "프로젝트 참조를 복구하는 중...");
  await api("/api/repair-project-registration", {
    method: "POST",
    body: JSON.stringify({ project }),
  });
  await reloadProjectSubset(new Set([project]), { codexHome: true });
}

async function repairProjectChats(project) {
  const groups = state.groups.filter((group) => groupProject(group) === project);
  const repairableCount = groups.reduce(
    (sum, group) =>
      sum +
      groupRecords(group).filter(
        (record) => record.primaryFile && (record.issues.includes("missing-session-index") || record.issues.includes("missing-db-thread")),
      ).length,
    0,
  );
  if (repairableCount === 0) return;
  if (!(await showConfirm(`${project}\n\n복구 가능한 채팅 ${repairableCount}개를 자동 복구할까요?\n\n세션 인덱스 없음과 DB 스레드 없음만 처리하고, 작업 전 백업이 생성됩니다.`, { confirmText: "복구" }))) return;
  setProjectSectionLoading(project, "채팅을 자동 복구하는 중...");
  await api("/api/repair-project-chats", {
    method: "POST",
    body: JSON.stringify({ project }),
  });
  state = await api("/api/summary");
  renderSubtitle();
  normalizeSelectedThreads();
  renderCodexHome();
  renderFilters();
  updateSearchClearButton();
  updateProjectSections(project, project);
  renderBackups();
}

async function repairThreadChat(id, title) {
  if (!(await showConfirm(`이 채팅을 복구할까요?\n\n${title}\n${id}\n\n세션 인덱스 없음과 DB 스레드 없음만 처리하고, 작업 전 백업이 생성됩니다.`, { confirmText: "복구" }))) return;
  const affectedProjects = projectSetForThreadIds([id]);
  for (const project of affectedProjects) setProjectSectionLoading(project, "채팅을 복구하는 중...");
  await api("/api/repair-thread-chat", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  await reloadProjectSubset(affectedProjects);
}

function restoreAutoExpansions() {
  for (const id of autoExpandedProjects) expandedProjects.delete(id);
  for (const id of autoExpandedGroups) expandedGroups.delete(id);
  autoExpandedProjects.clear();
  autoExpandedGroups.clear();
}

function hasActiveResultFilter() {
  return Boolean($("#searchInput").value.trim());
}

function syncFilteredResultExpansions() {
  restoreAutoExpansions();
  if (!hasActiveResultFilter()) return;
  for (const group of filteredGroups().slice(0, 300)) {
    const projectId = projectKey(groupProject(group));
    if (!expandedProjects.has(projectId)) {
      expandedProjects.add(projectId);
      autoExpandedProjects.add(projectId);
    }
  }
}

function filterThread(threadId) {
  restoreAutoExpansions();
  $("#searchInput").value = threadId;
  $("#issueFilter").value = "";
  $("#projectFilter").value = "";
  updateSearchClearButton();
  for (const group of filteredGroups()) {
    const project = groupProject(group);
    const projectId = projectKey(project);
    if (!expandedProjects.has(projectId)) {
      expandedProjects.add(projectId);
      autoExpandedProjects.add(projectId);
    }
    const parentId = group.parent?.id;
    if (group.children.some((child) => child.id === threadId) && parentId && !expandedGroups.has(parentId)) {
      expandedGroups.add(parentId);
      autoExpandedGroups.add(parentId);
    }
  }
  renderGroups();
  $("#threadGroups").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteThread(id, title, role, childCount) {
  const includeChildren = role !== "agent";
  const childText = includeChildren && childCount > 0 ? `\n\n하위 agent ${childCount}개도 함께 삭제됩니다.` : "";
  const ok = await showConfirm(`정말 삭제할까요?\n\n${title}\n${id}${childText}\n\n삭제 전 백업이 생성됩니다.`, {
    danger: true,
    confirmText: "삭제",
  });
  if (!ok) return;
  const affectedProjects = projectSetForThreadDelete(id, includeChildren);
  for (const project of affectedProjects) setProjectSectionLoading(project, "채팅을 삭제하는 중...");
  await api("/api/delete-thread", {
    method: "POST",
    body: JSON.stringify({ id, includeChildren }),
  });
  expandedGroups.delete(id);
  selectedThreads.delete(id);
  await reloadProjectSubset(affectedProjects);
}

async function deleteProjectless(ids, count) {
  if (!ids.length) return;
  const ok = await showConfirm(`프로젝트가 없는 채팅 ${count}개를 모두 삭제할까요?\n\n삭제 전 각 항목의 백업이 생성됩니다.`, {
    danger: true,
    confirmText: "전체 삭제",
  });
  if (!ok) return;
  const affectedProjects = projectSetForThreadIds(ids);
  for (const project of affectedProjects) setProjectSectionLoading(project, "채팅을 삭제하는 중...");
  await api("/api/delete-threads", {
    method: "POST",
    body: JSON.stringify({ ids, includeChildren: true }),
  });
  for (const id of ids) selectedThreads.delete(id);
  await reloadProjectSubset(affectedProjects);
}

async function removeProject(project, chatCount, agentCount) {
  if (!project || project === "(프로젝트 없음)") return;
  if (!(await ensureCodexClosedForProjectChange())) return;
  const recordCount = chatCount + agentCount;
  if (recordCount > 0) {
    const firstOk = await showConfirm(
      `${project}\n\n이 프로젝트를 제거하면 채팅 ${chatCount}개와 하위 agent ${agentCount}개가 함께 삭제됩니다.\n계속할까요?`,
      { danger: true, confirmText: "계속" },
    );
    if (!firstOk) return;
    const secondOk = await showConfirm(
      `마지막 확인입니다.\n\n${project}\n\n프로젝트 등록과 연결된 채팅을 모두 삭제합니다. 삭제 전 백업이 생성됩니다.`,
      { danger: true, confirmText: "정말 삭제" },
    );
    if (!secondOk) return;
  }

  setProjectSectionLoading(project, recordCount > 0 ? "프로젝트와 채팅을 삭제하는 중..." : "프로젝트를 제거하는 중...");
  await api("/api/remove-project", {
    method: "POST",
    body: JSON.stringify({ project }),
  });
  expandedProjects.delete(projectKey(project));
  selectedThreads.clear();
  await reloadSections({ threads: true, backups: true });
}

function allRecords() {
  if (!state) return [];
  return state.groups.flatMap(groupRecords);
}

function childrenByParentId() {
  const map = new Map();
  if (!state) return map;
  for (const group of state.groups) {
    const parentId = group.parent?.id || group.missingParentId;
    if (!parentId) continue;
    map.set(
      parentId,
      group.children.map((child) => child.id),
    );
  }
  return map;
}

function parentByChildId() {
  const map = new Map();
  if (!state) return map;
  for (const group of state.groups) {
    const parentId = group.parent?.id || group.missingParentId;
    if (!parentId) continue;
    for (const child of group.children) map.set(child.id, parentId);
  }
  return map;
}

function normalizeSelectedThreads() {
  const ids = new Set(allRecords().map((record) => record.id));
  for (const id of [...selectedThreads]) {
    if (!ids.has(id)) selectedThreads.delete(id);
  }
}

function setThreadSelected(id, checked) {
  if (!id) return;
  const childMap = childrenByParentId();
  const parentMap = parentByChildId();
  if (checked) {
    selectedThreads.add(id);
    for (const childId of childMap.get(id) || []) selectedThreads.add(childId);
  } else {
    selectedThreads.delete(id);
    for (const childId of childMap.get(id) || []) selectedThreads.delete(childId);
    const parentId = parentMap.get(id);
    if (parentId) selectedThreads.delete(parentId);
  }
  renderGroups();
}

function selectedDeleteIds() {
  const parentMap = parentByChildId();
  return [...selectedThreads].filter((id) => !selectedThreads.has(parentMap.get(id)));
}

function updateSelectionBar() {
  const bar = $("#selectionBar");
  const count = selectedThreads.size;
  bar.hidden = count === 0;
  $("#selectionCount").textContent = `${count}개 선택됨`;
  $("#deleteSelectedButton").disabled = count === 0;
}

async function deleteSelectedThreads() {
  const ids = selectedDeleteIds();
  if (ids.length === 0) return;
  const selectedCount = selectedThreads.size;
  const ok = await showConfirm(
    `선택한 채팅 ${selectedCount}개를 삭제할까요?\n\n부모 채팅이 선택된 경우 하위 agent도 함께 삭제됩니다.\n삭제 전 백업이 생성됩니다.`,
    { danger: true, confirmText: "선택 삭제" },
  );
  if (!ok) return;
  const affectedProjects = projectSetForThreadIds([...selectedThreads]);
  for (const project of affectedProjects) setProjectSectionLoading(project, "선택한 채팅을 삭제하는 중...");
  await api("/api/delete-threads", {
    method: "POST",
    body: JSON.stringify({ ids, includeChildren: true }),
  });
  selectedThreads.clear();
  await reloadProjectSubset(affectedProjects);
}

function clearSelectedThreads() {
  selectedThreads.clear();
  renderGroups();
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

$("#refreshButton").addEventListener("click", () => {
  refresh().catch(showError);
});
$("#shutdownButton").addEventListener("click", () => {
  shutdownProgram().catch(showError);
});
$("#updateButton").addEventListener("click", () => {
  const action = $("#updateButton").dataset.updateAction;
  if (action === "install") {
    installAvailableUpdate().catch(showError);
    return;
  }
  checkUpdateStatus().catch(showError);
});
$("#codexHomeForm").addEventListener("submit", (event) => {
  saveCodexHome(event).catch(showError);
});
$("#codexHomeForm").addEventListener("click", (event) => {
  const button = event.target.closest("[data-select-path]");
  if (!button) return;
  choosePath(button).catch((error) => {
    $("#codexHomeStatus").textContent = error.message;
    showError(error);
  });
});
$("#helpPanel").addEventListener("click", (event) => {
  const card = event.target.closest(".guide-card");
  if (!card) return;
  const button = card.querySelector(".guide-card-toggle");
  if (!button) return;
  const body = document.getElementById(button.getAttribute("aria-controls"));
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  card?.classList.toggle("is-open", !expanded);
  if (body) body.hidden = expanded;
  if (!expanded) recordGuideFanfareStep(card.dataset.guideOrder);
  queueSideColumnLayout();
});
$("#helpPanel").addEventListener("pointermove", (event) => {
  const card = event.target.closest(".guide-card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--guide-hover-x", `${event.clientX - rect.left}px`);
  card.style.setProperty("--guide-hover-y", `${event.clientY - rect.top}px`);
});
$("#searchInput").addEventListener("input", () => {
  updateSearchClearButton();
  syncFilteredResultExpansions();
  renderGroups();
});
$("#clearSearchButton").addEventListener("click", () => {
  $("#searchInput").value = "";
  updateSearchClearButton();
  syncFilteredResultExpansions();
  renderGroups();
  $("#searchInput").focus();
});
$("#issueFilter").addEventListener("change", () => {
  renderGroups();
});
$("#projectFilter").addEventListener("change", () => {
  renderGroups();
});
$("#clearSelectionButton").addEventListener("click", clearSelectedThreads);
$("#deleteSelectedButton").addEventListener("click", () => {
  deleteSelectedThreads().catch(showError);
});
$("#threadGroups").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-select-thread]");
  if (!checkbox) return;
  setThreadSelected(checkbox.dataset.selectThread, checkbox.checked);
});
const globalTooltipSelector = "[data-disabled-tooltip], [data-tooltip]";

document.addEventListener("mouseover", (event) => {
  const host = event.target.closest(globalTooltipSelector);
  if (host) showGlobalTooltip(host);
});
document.addEventListener("mouseout", (event) => {
  const host = event.target.closest(globalTooltipSelector);
  if (host && !host.contains(event.relatedTarget)) hideGlobalTooltip(host);
});
document.addEventListener("focusin", (event) => {
  const host = event.target.closest(globalTooltipSelector);
  if (host) showGlobalTooltip(host);
});
document.addEventListener("focusout", (event) => {
  const host = event.target.closest(globalTooltipSelector);
  if (host) hideGlobalTooltip(host);
});
$("#threadGroups").addEventListener("click", (event) => {
  if (event.target.closest("[data-select-thread]")) {
    event.stopPropagation();
    return;
  }
  const repairChatsButton = event.target.closest("[data-repair-chats]");
  if (repairChatsButton) {
    event.stopPropagation();
    repairProjectChats(repairChatsButton.dataset.repairChats).catch(showError);
    return;
  }
  const repairProjectButton = event.target.closest("[data-repair-project]");
  if (repairProjectButton) {
    event.stopPropagation();
    repairProjectPath(repairProjectButton.dataset.repairProject).catch(showError);
    return;
  }
  const moveProjectButton = event.target.closest("[data-move-project]");
  if (moveProjectButton) {
    event.stopPropagation();
    moveProjectPath(moveProjectButton.dataset.moveProject).catch(showError);
    return;
  }
  const renameProjectButton = event.target.closest("[data-rename-project]");
  if (renameProjectButton) {
    event.stopPropagation();
    renameProjectPath(renameProjectButton.dataset.renameProject).catch(showError);
    return;
  }
  const repairProjectRegistrationButton = event.target.closest("[data-repair-project-registration]");
  if (repairProjectRegistrationButton) {
    event.stopPropagation();
    repairProjectRegistration(repairProjectRegistrationButton.dataset.repairProjectRegistration).catch(showError);
    return;
  }
  const deleteProjectlessButton = event.target.closest("[data-delete-projectless]");
  if (deleteProjectlessButton) {
    event.stopPropagation();
    const ids = deleteProjectlessButton.dataset.deleteProjectless.split(",").filter(Boolean);
    deleteProjectless(ids, Number(deleteProjectlessButton.dataset.deleteCount || ids.length)).catch(showError);
    return;
  }
  const removeProjectButton = event.target.closest("[data-remove-project]");
  if (removeProjectButton) {
    event.stopPropagation();
    removeProject(
      removeProjectButton.dataset.removeProject,
      Number(removeProjectButton.dataset.projectChatCount || 0),
      Number(removeProjectButton.dataset.projectAgentCount || 0),
    ).catch(showError);
    return;
  }
  const projectButton = event.target.closest("[data-project-toggle]");
  if (projectButton) {
    toggleProjectSection(projectButton.dataset.projectToggle);
    return;
  }
  const backupButton = event.target.closest("[data-delete]");
  if (backupButton) {
    deleteBackup(backupButton.dataset.delete).catch(showError);
    return;
  }
  const repairThreadButton = event.target.closest("[data-repair-thread]");
  if (repairThreadButton) {
    repairThreadChat(repairThreadButton.dataset.repairThread, repairThreadButton.dataset.repairTitle).catch(showError);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-thread]");
  if (deleteButton) {
    deleteThread(
      deleteButton.dataset.deleteThread,
      deleteButton.dataset.deleteTitle,
      deleteButton.dataset.deleteRole,
      Number(deleteButton.dataset.childCount || 0),
    ).catch(showError);
    return;
  }
  const button = event.target.closest("[data-toggle]");
  if (!button) return;
  const id = button.dataset.toggle;
  if (expandedGroups.has(id)) expandedGroups.delete(id);
  else expandedGroups.add(id);
  renderGroups();
});
$("#threadGroups").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const projectHeader = event.target.closest("[data-project-toggle]");
  if (!projectHeader || event.target.closest("button")) return;
  event.preventDefault();
  toggleProjectSection(projectHeader.dataset.projectToggle);
});
$("#backupsList").addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-filter-thread]");
  if (filterButton) {
    filterThread(filterButton.dataset.filterThread);
    return;
  }
  const restoreButton = event.target.closest("[data-restore-backup]");
  if (restoreButton) {
    restoreBackup(restoreButton.dataset.restoreBackup).catch(showError);
    return;
  }
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  deleteBackup(button.dataset.delete).catch(showError);
});
$("#backupsList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-select-backup]");
  if (!checkbox) return;
  if (checkbox.checked) selectedBackups.add(checkbox.dataset.selectBackup);
  else selectedBackups.delete(checkbox.dataset.selectBackup);
  updateBackupSelectionButton();
});
$("#deleteSelectedBackupsButton").addEventListener("click", () => {
  deleteSelectedBackups().catch(showError);
});
$("#deleteAllBackupsButton").addEventListener("click", () => {
  deleteAllBackups().catch(showError);
});
$("#deleteUnknownBackupsButton").addEventListener("click", () => {
  deleteUnknownOriginalBackups().catch(showError);
});

$("#appModalConfirm").addEventListener("click", () => closeModal(true));
$("#appModalCancel").addEventListener("click", () => closeModal(false));
$("#appModalInput").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  closeModal(true);
});
$("#appModal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget && !$("#appModalCancel").hidden) closeModal(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#appModal").hidden) {
    event.preventDefault();
    closeModal(false);
    return;
  }
});
window.addEventListener("scroll", () => {
  hideGlobalTooltip();
  queueSideColumnLayout();
}, true);
window.addEventListener("resize", () => {
  hideGlobalTooltip();
  queueSideColumnLayout();
});

startHeartbeat();
startCodexProcessPolling();

refresh()
  .then(() => maybeShowUpdateNotice())
  .catch((error) => {
    $("#subtitle").textContent = error.message;
  });
checkUpdateStatus({ silent: true }).catch(() => {
  renderUpdateStatus({ error: "업데이트 상태를 확인하지 못했습니다." });
});
