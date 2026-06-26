import { issueLabels } from "./labels.js";

export function createThreadRenderer(deps) {
  const {
    $,
    getState,
    expandedGroups,
    expandedProjects,
    selectedThreads,
    GENERAL_CHAT_LABEL,
    getThreadSelectionMode,
    codexStatusController,
    chatSizeAdvice,
    escapeHtml,
    formatBytes,
    formatDate,
    renderIcons,
    setLoading,
    setLoadingOverlay,
    updateSelectionBar,
    normalizeSelectedThreads,
  } = deps;

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
  return getState().groups.some((group) => groupProject(group).toLowerCase().includes(query));
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
  return getState().groups.filter((group) => groupMatches(group, options));
}

function renderGroups() {
  const groups = filteredGroups();
  $("#threadGroups").innerHTML = renderProjectSections(groups.slice(0, 300));
  updateSelectionBar();
  syncProjectSelectIndeterminate();
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
  const projectSelect = renderProjectSelect(project, projectGroups);
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
  const codexIsOpen = codexStatusController.status().open !== false;
  const codexClosedTooltip = "Codex를 완전히 종료한 뒤 사용할 수 있습니다.";
  const codexClosedOnlyAttrs = codexIsOpen ? " disabled" : "";
  const renderCodexClosedOnlyButton = (buttonHtml) =>
    codexIsOpen ? `<span class="disabled-tooltip-host" data-disabled-tooltip="${escapeHtml(codexClosedTooltip)}">${buttonHtml}</span>` : buttonHtml;
  return `<section class="project-section" data-project-section="${escapeHtml(projectId)}">
    <div class="project-header" data-project-toggle="${escapeHtml(projectId)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
      <span class="project-toggle-indicator" aria-hidden="true"></span>
      ${projectSelect}
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

function projectSelectableIds(projectGroups) {
  return projectGroups.flatMap(groupRecords).map((record) => record.id);
}

function renderProjectSelect(project, projectGroups) {
  if (!getThreadSelectionMode?.()) return "";
  const ids = projectSelectableIds(projectGroups);
  if (ids.length === 0) return "";
  const selectedCount = ids.filter((id) => selectedThreads.has(id)).length;
  const checked = selectedCount === ids.length;
  const indeterminate = selectedCount > 0 && selectedCount < ids.length;
  return `<label class="project-select" title="프로젝트 채팅 선택" aria-label="프로젝트 채팅 선택">
    <input
      type="checkbox"
      data-select-project="${escapeHtml(project)}"
      data-select-project-ids="${escapeHtml(ids.join(","))}"
      ${checked ? "checked" : ""}
      data-indeterminate="${indeterminate ? "true" : "false"}"
    />
  </label>`;
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
    syncProjectSelectIndeterminate();
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
    syncProjectSelectIndeterminate();
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
    syncProjectSelectIndeterminate();
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
  syncProjectSelectIndeterminate();
  renderIcons($("#threadGroups"));
}

function updateProjectSubset(projects) {
  normalizeSelectedThreads();
  const visibleGroups = filteredGroups().slice(0, 300);
  if (visibleGroups.length === 0) {
    $("#threadGroups").innerHTML = renderProjectSections(visibleGroups);
    updateSelectionBar();
    syncProjectSelectIndeterminate();
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
  syncProjectSelectIndeterminate();
  renderIcons($("#threadGroups"));
}

function syncProjectSelectIndeterminate() {
  document.querySelectorAll("[data-select-project]").forEach((input) => {
    input.indeterminate = input.dataset.indeterminate === "true";
  });
}

function projectSetForThreadIds(ids) {
  const idSet = new Set(ids);
  const projects = new Set();
  for (const group of getState().groups || []) {
    if (groupRecords(group).some((record) => idSet.has(record.id))) {
      projects.add(groupProject(group));
    }
  }
  return projects;
}

function projectSetForThreadDelete(id, includeChildren) {
  const projects = new Set();
  for (const group of getState().groups || []) {
    const records = groupRecords(group);
    if (records.some((record) => record.id === id)) projects.add(groupProject(group));
    if (includeChildren && group.parent?.id === id) projects.add(groupProject(group));
  }
  return projects;
}

function backupByPath(path) {
  return (getState().backups || []).find((backup) => backup.path === path);
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
  if (!getThreadSelectionMode?.()) return "";
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

  return {
    buildProjectMap,
    filteredGroups,
    groupProject,
    groupRecords,
    projectKey,
    projectSetForBackup,
    projectSetForThreadDelete,
    projectSetForThreadIds,
    renderGroups,
    renderProjectSections,
    renderProjectThreadList,
    setProjectSectionLoading,
    toggleProjectSection,
    updateProjectSections,
    updateProjectSubset,
  };
}
