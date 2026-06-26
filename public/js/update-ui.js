export function createUpdateController({ $, api, formatDate, showAlert, showConfirm }) {
  let updateInfo = null;

  async function maybeShowUpdateNotice() {
    const notice = await api("/api/update-notice");
    if (!notice.show) return;
    const updatedAtMs = Date.parse(notice.updatedAt || "");
    const updatedAtText = Number.isFinite(updatedAtMs) ? `업데이트 일시: ${formatDate(updatedAtMs)}` : "";
    const title = `${notice.currentVersion ? `${notice.currentVersion} ` : ""}업데이트 내용`;
    await showAlert(notice.patchNotes || "표시할 패치노트가 없습니다.", title, {
      variant: "patch-notes",
      meta: updatedAtText,
    });
    await api("/api/update-notice/read", { method: "POST", body: JSON.stringify({}) });
  }

  function updateVersionPair(info) {
    const current = info?.currentVersion || "";
    const latest = info?.latestVersion || info?.label || "";
    return [current, latest].filter(Boolean).join(" / ");
  }

  function currentVersionText(info) {
    return info?.currentVersion ? `현재 ${info.currentVersion}` : "현재 버전 확인 불가";
  }

  function manualUpdateUrl(info = updateInfo) {
    if (info?.releaseUrl) return info.releaseUrl;
    if (info?.repo) return `https://github.com/${info.repo}/releases/latest`;
    return "";
  }

  async function showManualUpdateGuide(error, info = updateInfo) {
    const message = error?.message || String(error || info?.error || info?.reason || "자동 업데이트를 완료하지 못했습니다.");
    const url = manualUpdateUrl(info);
    await showAlert(
      [
        "자동 업데이트를 완료하지 못했습니다.",
        "",
        `오류: ${message}`,
        "",
        "구버전의 자동 업데이트 스크립트가 현재 파일 구조와 맞지 않거나, 압축 해제/재시작 단계에서 실패할 수 있습니다. 아래 순서로 수동 업데이트를 진행하세요.",
        "",
        "1. 이 프로그램을 종료합니다.",
        "2. GitHub Release에서 codex-session-manager.zip을 다운로드합니다.",
        "3. 현재 앱 폴더를 통째로 백업합니다.",
        "4. zip 안의 codex-session-manager 폴더 내용을 현재 앱 폴더에 덮어씁니다.",
        "5. 로컬 설정 파일, backups, logs 폴더는 삭제하지 않습니다.",
        "6. Windows는 start.ps1, macOS는 start.command를 실행합니다.",
        "7. 의존성 오류가 나면 앱 폴더에서 npm install 후 다시 실행합니다.",
      ].join("\n"),
      "수동 업데이트 안내",
      {
        secondaryText: url ? "릴리스 열기" : "",
        onSecondary: url ? () => window.open(url, "_blank", "noopener") : null,
      },
    );
  }

  async function showPatchNotes() {
    const data = await api("/api/patch-notes?limit=3");
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const markdown = notes
      .map((note, index) => {
        const body = String(note.markdown || "").trim();
        if (!body) return "";
        const baseTitle = note.title || (note.version ? `${note.version} 업데이트 내용` : "업데이트 내용");
        const title = index === 0 ? `🌟 ${baseTitle}` : baseTitle;
        return body.match(/^##\s+/) ? body.replace(/^##\s+.+$/m, `## ${title}`) : `## ${title}\n\n${body}`;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
    await showAlert(markdown || "표시할 패치노트가 없습니다.", "패치노트", { variant: "patch-notes" });
  }

  function renderUpdateStatus(info = updateInfo) {
    const statusText = $("#updateStatusText");
    const updateButton = $("#updateButton");
    if (!statusText || !updateButton) return;
    const setButton = (action, label, icon) => {
      updateButton.dataset.updateAction = action;
      updateButton.innerHTML = `<span class="button-icon" data-lucide="${icon}" aria-hidden="true"></span>${label}`;
      updateButton.disabled = false;
      window.lucide?.createIcons();
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
      const pair = updateVersionPair(info);
      statusText.textContent = `업데이트 가능: ${pair || "새 버전"}`;
      setButton("install", "업데이트", "download");
      return;
    }
    statusText.textContent = `최신 버전입니다. (${currentVersionText(info)})`;
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
      if (!options.silent && updateInfo.error) await showManualUpdateGuide(updateInfo.error, updateInfo);
    } catch (error) {
      updateInfo = { ...(updateInfo || {}), error: error?.message || String(error) };
      renderUpdateStatus();
      if (!options.silent) await showManualUpdateGuide(error, updateInfo);
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
    try {
      await api("/api/update", { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      $("#updateStatusText").textContent = "자동 업데이트 실패";
      $("#updateButton").disabled = false;
      await showManualUpdateGuide(error, updateInfo);
      return;
    }
    document.body.innerHTML = `<main class="shutdown-screen">
      <section class="panel">
        <h1>업데이트 설치 중</h1>
        <p>서버가 종료된 뒤 새 버전으로 다시 시작됩니다.</p>
      </section>
    </main>`;
  }

  return {
    checkUpdateStatus,
    installAvailableUpdate,
    maybeShowUpdateNotice,
    renderUpdateStatus,
    showPatchNotes,
  };
}
