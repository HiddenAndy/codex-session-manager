export function setupAppEvents(deps) {
  const {
    $,
    checkUpdateStatus,
    choosePath,
    clearSelectedThreads,
    closeModal,
    codexStatusController,
    deleteAllBackups,
    deleteBackup,
    deleteProjectless,
    deleteSelectedBackups,
    deleteSelectedThreads,
    deleteThread,
    deleteUnknownOriginalBackups,
    expandedGroups,
    filterThread,
    hideGlobalTooltip,
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
    setThreadSelected,
    showError,
    showGlobalTooltip,
    showPatchNotes,
    shutdownProgram,
    startHeartbeat,
    syncFilteredResultExpansions,
    updateBackupSelectionButton,
    updateSearchClearButton,
  } = deps;

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
  $("#patchNotesButton").addEventListener("click", () => {
    showPatchNotes().catch(showError);
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
      deps.toggleProjectSection(projectButton.dataset.projectToggle);
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
    deps.toggleProjectSection(projectHeader.dataset.projectToggle);
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
  codexStatusController.startCodexProcessPolling();

  refresh()
    .then(() => maybeShowUpdateNotice())
    .catch((error) => {
      $("#subtitle").textContent = error.message;
    });
  checkUpdateStatus({ silent: true }).catch(() => {
    renderUpdateStatus({ error: "업데이트 상태를 확인하지 못했습니다." });
  });
}
