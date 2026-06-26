export function createBackupActions(deps) {
  const {
    api,
    getState,
    isUnknownOriginalBackup,
    projectSetForBackup,
    reloadProjectSubset,
    reloadSections,
    selectedBackups,
    setLoading,
    setProjectSectionLoading,
    showAlert,
    showConfirm,
  } = deps;

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
  await reloadProjectSubset(affectedProjects, { codexHome: true });
}

async function deleteAllBackups() {
  if (!(await showConfirm("모든 백업 디렉터리와 _bak 세션 파일을 삭제할까요?", { danger: true, confirmText: "전체 삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-all-backups", { method: "POST", body: "{}" });
  await reloadSections({ backups: true });
}

async function deleteUnknownOriginalBackups() {
  const count = getState().backups.filter(isUnknownOriginalBackup).length;
  if (count === 0) {
    await showAlert("원본 확인 불가 백업이 없습니다.");
    return;
  }
  if (!(await showConfirm(`원본 확인 불가 백업 ${count}개를 삭제할까요?`, { danger: true, confirmText: "삭제" }))) return;
  setLoading({ backups: true });
  await api("/api/delete-unknown-original-backups", { method: "POST", body: "{}" });
  await reloadSections({ backups: true });
}


  return {
    deleteAllBackups,
    deleteBackup,
    deleteSelectedBackups,
    deleteUnknownOriginalBackups,
    restoreBackup,
  };
}
