export function createProjectActions(deps) {
  const {
    $,
    api,
    autoExpandedGroups,
    autoExpandedProjects,
    codexStatusController,
    expandedGroups,
    expandedProjects,
    filteredGroups,
    getState,
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
    setState,
    showAlert,
    showConfirm,
    showPrompt,
    updateProjectSections,
    updateSearchClearButton,
  } = deps;

async function ensureCodexClosedForProjectChange() {
  await codexStatusController.refreshCodexProcessStatus({ rerender: true });
  if (codexStatusController.status().open !== false) {
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
  return String(project || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function projectParentPath(project) {
  const value = String(project || "");
  const name = projectBaseName(value);
  return name ? value.slice(0, value.length - name.length).replace(/[\\/]$/, "") || "/" : value;
}

async function repairProjectPath(from) {
  if (!(await ensureCodexClosedForProjectChange())) return;
  const selected = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({
      kind: "directory",
      currentPath: from,
      prompt: "새 프로젝트 폴더를 선택하세요.",
    }),
  });
  if (selected.canceled) return;
  const to = String(selected.path || "").trim();
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
  setState(await api("/api/summary"));
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
  const selected = await api("/api/select-path", {
    method: "POST",
    body: JSON.stringify({
      kind: "directory",
      currentPath: project,
      prompt: "새 프로젝트 폴더를 선택하세요.",
    }),
  });
  if (selected.canceled) return;
  const to = String(selected.path || "").trim();
  if (!to) return;
  if (to === project) return;
  if (
    !(await showConfirm(
      `프로젝트 참조 경로를 변경할까요?\n\n기존 경로: ${project}\n새 경로: ${to}\n\n세션 JSONL과 SQLite threads가 함께 변경되고 백업이 생성됩니다.`,
      { confirmText: "변경" },
    ))
  ) {
    return;
  }
  setProjectSectionLoading(project, "프로젝트 경로를 변경하는 중...");
  await api("/api/repair-cwd", {
    method: "POST",
    body: JSON.stringify({ from: project, to, includeJsonl: true, includeDb: true }),
  });
  expandedProjects.delete(projectKey(project));
  expandedProjects.add(projectKey(to));
  if ($("#projectFilter").value === project) $("#projectFilter").value = to;
  setState(await api("/api/summary"));
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
  setState(await api("/api/summary"));
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
  const groups = getState().groups.filter((group) => groupProject(group) === project);
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
  setState(await api("/api/summary"));
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


  return {
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
  };
}
