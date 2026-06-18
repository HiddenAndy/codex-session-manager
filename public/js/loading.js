import { escapeHtml } from "./format.js";

export function renderLoadingOverlay(label) {
  return `<div class="loading-overlay" data-loading-overlay role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span>${escapeHtml(label)}</span>
  </div>`;
}

export function setLoadingOverlay(target, label) {
  if (!target) return;
  target.dataset.loadingHost = "true";
  target.setAttribute("aria-busy", "true");
  target.querySelector("[data-loading-overlay]")?.remove();
  target.insertAdjacentHTML("beforeend", renderLoadingOverlay(label));
}

export function clearLoadingOverlay(target) {
  if (!target) return;
  target.querySelector("[data-loading-overlay]")?.remove();
  target.removeAttribute("data-loading-host");
  target.removeAttribute("aria-busy");
}

export function setLoading($, { threads = false, backups = false } = {}) {
  if (threads) setLoadingOverlay($("#threadGroups"), "채팅 목록을 불러오는 중...");
  if (backups) setLoadingOverlay($("#backupsList"), "백업 목록을 불러오는 중...");
}
