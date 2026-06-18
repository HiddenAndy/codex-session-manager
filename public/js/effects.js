export function renderIcons(root = document) {
  window.lucide?.createIcons({ root });
}

export function createTooltipController() {
  let activeTooltipHost = null;

  function tooltipElement() {
    let tooltip = document.querySelector(".global-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "global-tooltip";
      tooltip.hidden = true;
      document.body.appendChild(tooltip);
    }
    return tooltip;
  }

  function showGlobalTooltip(host) {
    const text = host?.dataset?.disabledTooltip || host?.dataset?.tooltip || host?.getAttribute("title");
    if (!text) return;
    activeTooltipHost = host;
    const tooltip = tooltipElement();
    tooltip.textContent = text;
    tooltip.hidden = false;

    const rect = host.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    let left = rect.right - tooltipRect.width;
    let top = rect.bottom + gap;

    left = Math.max(12, Math.min(left, window.innerWidth - tooltipRect.width - 12));
    if (top + tooltipRect.height > window.innerHeight - 12) top = rect.top - tooltipRect.height - gap;
    top = Math.max(12, top);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideGlobalTooltip(host = null) {
    if (host && host !== activeTooltipHost) return;
    activeTooltipHost = null;
    const tooltip = document.querySelector(".global-tooltip");
    if (tooltip) tooltip.hidden = true;
  }

  return { hideGlobalTooltip, showGlobalTooltip };
}

export function showFanfare($) {
  const overlay = $("#fanfareOverlay");
  if (!overlay) return;
  const colors = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"];
  const halfWidth = window.innerWidth / 2;
  const halfHeight = window.innerHeight / 2;
  const targetX = 0;
  const targetY = Math.round(window.innerHeight * 0.4 - halfHeight);
  const pieces = Array.from({ length: 42 }, (_, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const sideIndex = Math.floor(index / 2);
    const originX = Math.round(side * (halfWidth - 8));
    const originY = Math.round(halfHeight - 8);
    const targetAngle = Math.atan2(targetY - originY, targetX - originX);
    const spread = (-18 + (sideIndex % 7) * 6 + (Math.floor(sideIndex / 7) - 1) * 4) * (Math.PI / 180);
    const targetDistance = Math.hypot(targetX - originX, targetY - originY);
    const distanceRatio = 0.28 + ((sideIndex * 5) % 13) * 0.065;
    const distance = targetDistance * distanceRatio;
    const x = Math.round(originX + Math.cos(targetAngle + spread) * distance);
    const y = Math.round(originY + Math.sin(targetAngle + spread) * distance);
    const color = colors[index % colors.length];
    const rotation = (index * 37) % 180;
    return `<span class="fanfare-confetti" style="--confetti-origin-x: ${originX}px; --confetti-origin-y: ${originY}px; --confetti-x: ${x}px; --confetti-y: ${y}px; --confetti-color: ${color}; --confetti-rotation: ${rotation}deg;"></span>`;
  }).join("");
  overlay.innerHTML = `<div class="fanfare-burst" role="presentation">
    ${pieces}
  </div>`;
  overlay.hidden = false;
  window.setTimeout(() => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }, 1650);
}

export function createGuideFanfareRecorder({ $, sequence = ["1", "5", "2", "4", "3"] } = {}) {
  let progress = [];
  return function recordGuideFanfareStep(order) {
    if (!order) return;
    progress.push(order);
    progress = progress.slice(-sequence.length);
    const matched = sequence.every((value, index) => progress[index] === value);
    if (!matched) return;
    progress = [];
    showFanfare($);
  };
}
