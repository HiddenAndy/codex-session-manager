export function createThreadSelection({
  $,
  selectedThreads,
  getState,
  groupRecords,
  renderGroups,
  showConfirm,
  api,
  projectSetForThreadIds,
  setProjectSectionLoading,
  reloadProjectSubset,
}) {
  function allRecords() {
    const state = getState();
    if (!state) return [];
    return state.groups.flatMap(groupRecords);
  }

  function childrenByParentId() {
    const map = new Map();
    const state = getState();
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
    const state = getState();
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

  return {
    clearSelectedThreads,
    deleteSelectedThreads,
    normalizeSelectedThreads,
    setThreadSelected,
    updateSelectionBar,
  };
}
