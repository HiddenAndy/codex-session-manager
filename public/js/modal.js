export function createModalController({ $, renderPatchNotesMarkdown }) {
  let modalResolve = null;
  let modalPreviousFocus = null;
  let modalInputMode = false;
  let modalSecondaryAction = null;

  function showPatchNoteStarBurst(origin) {
    const rect = origin.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const baseAngle = Math.random() * Math.PI * 2;
    const bursts = Array.from({ length: 3 }, (_, index) => {
      const angle = baseAngle + index * ((Math.PI * 2) / 3) + (Math.random() - 0.5) * 0.9;
      const distance = 42 + Math.random() * 10;
      const curve = (Math.random() > 0.5 ? 1 : -1) * (3 + Math.random() * 4);
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      return {
        x,
        y,
        cx: Math.cos(angle) * distance * 0.45 + Math.cos(angle + Math.PI / 2) * curve,
        cy: Math.sin(angle) * distance * 0.45 + Math.sin(angle + Math.PI / 2) * curve,
        rotate: (Math.random() > 0.5 ? 1 : -1) * (24 + Math.random() * 70),
      };
    });

    for (const burst of bursts) {
      const star = document.createElement("span");
      star.className = "patch-note-star-burst";
      star.textContent = "🌟";
      star.style.left = `${centerX}px`;
      star.style.top = `${centerY}px`;
      document.body.appendChild(star);
      const animation = star.animate(
        [
          { transform: "translate(-50%, -50%) translate(0, 0) scale(0.72) rotate(0deg)", opacity: 1, offset: 0 },
          { transform: `translate(-50%, -50%) translate(${burst.cx}px, ${burst.cy}px) scale(1) rotate(${burst.rotate / 2}deg)`, opacity: 1, offset: 0.58 },
          { transform: `translate(-50%, -50%) translate(${burst.x * 0.92}px, ${burst.y * 0.92}px) scale(0.86) rotate(${burst.rotate}deg)`, opacity: 1, offset: 0.88 },
          { transform: `translate(-50%, -50%) translate(${burst.x}px, ${burst.y}px) scale(0.55) rotate(${burst.rotate * 1.25}deg)`, opacity: 0, offset: 1 },
        ],
        { duration: 640, easing: "cubic-bezier(.18,.72,.2,1)", fill: "forwards" },
      );
      animation.finished.finally(() => star.remove());
    }
  }

  $("#appModalMessage")?.addEventListener("click", (event) => {
    const star = event.target.closest(".patch-note-star");
    if (!star) return;
    showPatchNoteStarBurst(star);
  });

  function closeModal(result) {
    const modal = $("#appModal");
    if (!modal || modal.hidden) return;
    const metaEl = $("#appModalMeta");
    const inputWrap = $("#appModalInputWrap");
    const input = $("#appModalInput");
    const secondaryButton = $("#appModalSecondary");
    if (result === true && modalInputMode) result = input.value;
    modal.hidden = true;
    delete modal.dataset.variant;
    metaEl.hidden = true;
    metaEl.textContent = "";
    inputWrap.hidden = true;
    input.value = "";
    secondaryButton.hidden = true;
    secondaryButton.textContent = "";
    secondaryButton.className = "";
    modalSecondaryAction = null;
    modalInputMode = false;
    document.body.classList.remove("modal-open");
    if (modalResolve) modalResolve(result);
    modalResolve = null;
    modalPreviousFocus?.focus?.();
    modalPreviousFocus = null;
  }

  function showModal({ title = "확인", message = "", confirmText = "확인", cancelText = null, danger = false, variant = "", meta = "", secondaryText = "", onSecondary = null } = {}) {
    const modal = $("#appModal");
    const titleEl = $("#appModalTitle");
    const metaEl = $("#appModalMeta");
    const messageEl = $("#appModalMessage");
    const confirmButton = $("#appModalConfirm");
    const cancelButton = $("#appModalCancel");
    const secondaryButton = $("#appModalSecondary");
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
    secondaryButton.textContent = secondaryText || "";
    secondaryButton.className = "";
    secondaryButton.hidden = !secondaryText;
    modalSecondaryAction = typeof onSecondary === "function" ? onSecondary : null;
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
    const secondaryButton = $("#appModalSecondary");
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
    secondaryButton.hidden = true;
    secondaryButton.textContent = "";
    secondaryButton.className = "";
    modalSecondaryAction = null;
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
      secondaryText: options.secondaryText || "",
      onSecondary: options.onSecondary || null,
    });
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

  async function runModalSecondaryAction() {
    if (!modalSecondaryAction) return;
    await modalSecondaryAction();
  }

  return { closeModal, runModalSecondaryAction, showAlert, showConfirm, showError, showModal, showPrompt };
}
