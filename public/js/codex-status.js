export function createCodexStatusController({ $, api, onStatusChanged }) {
  let codexStatus = { open: true, unknown: true };

  function status() {
    return codexStatus;
  }

  function renderCodexProcessStatus() {
    const el = $("#codexProcessStatus");
    if (!el) return;
    const indicator = document.querySelector(".settings-header-separator");
    const runningNote = $("#codexRunningNote");
    el.classList.toggle("open", !!codexStatus.open);
    el.classList.toggle("closed", codexStatus.open === false);
    indicator?.classList.toggle("open", !!codexStatus.open);
    indicator?.classList.toggle("closed", codexStatus.open === false);
    if (runningNote) runningNote.hidden = codexStatus.unknown || !codexStatus.open;
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
      if (rerender && changed) onStatusChanged?.();
    } catch {
      codexStatus = { open: true, unknown: true };
      renderCodexProcessStatus();
      if (rerender) onStatusChanged?.();
    }
  }

  function startCodexProcessPolling() {
    refreshCodexProcessStatus({ rerender: true }).catch(() => {});
    setInterval(() => {
      refreshCodexProcessStatus({ rerender: true }).catch(() => {});
    }, 1000);
  }

  return { refreshCodexProcessStatus, renderCodexProcessStatus, startCodexProcessPolling, status };
}
