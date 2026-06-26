export function createBackupRenderer({ $, selectedBackups, getBackups, escapeHtml, formatBytes, formatDate, renderIcons }) {
  function backupByPath(path) {
    return getBackups().find((backup) => backup.path === path);
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

  function backupTypeLabel(type) {
    return {
      "backup-dir": "백업 디렉터리",
      "backup-file": "백업 파일",
      "session-bak": "세션 bak",
    }[type] || type;
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
    const deletablePaths = new Set(getBackups().filter((backup) => backup.deletable).map((backup) => backup.path));
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

  function backupSourceDetail(backup) {
    const description = backup.description || {};
    if (description.detail) return description.detail;
    return description.label || "";
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

  function renderBackups() {
    const backups = getBackups();
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
            <div class="backup-kind">
              <span class="pill">${escapeHtml(backupTypeLabel(backup.type))}</span>
              <span class="backup-size">${formatBytes(backup.size)}</span>
            </div>
            <div>
              <div class="mono path">${escapeHtml(backup.relativePath)}</div>
              ${renderBackupDescription(backup)}
              <div>${escapeHtml(formatDate(backup.mtimeMs))}</div>
            </div>
            ${renderBackupOriginalStatus(backup)}
            <span class="backup-actions">
              <button data-restore-backup="${escapeHtml(backup.path)}" ${backup.restorable?.possible ? "" : "disabled"}>되돌리기</button>
              <button class="danger" data-delete="${escapeHtml(backup.path)}" ${backup.deletable ? "" : "disabled"}>삭제</button>
            </span>
          </div>`,
        )
        .join("") || renderEmptyBackups();
    renderIcons($("#backupsList"));
  }

  return { isUnknownOriginalBackup, renderBackups, updateBackupSelectionButton };
}
