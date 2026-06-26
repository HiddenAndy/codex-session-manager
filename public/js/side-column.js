export function createSideColumnLayout() {
  let sideColumnLayoutFrame = null;

  function updateSideColumnLayout() {
    sideColumnLayoutFrame = null;
    const layout = document.querySelector(".app-layout");
    const sideColumn = document.querySelector(".side-column");
    if (!sideColumn) return;
    if (window.matchMedia("(max-width: 1200px)").matches) {
      sideColumn.style.removeProperty("--side-max-height");
      sideColumn.style.removeProperty("--side-sticky-top");
      layout?.style.removeProperty("--layout-visible-height");
      sideColumn.classList.remove("is-scrollable");
      return;
    }
    const topbar = document.querySelector(".topbar");
    const topbarBottom = topbar?.getBoundingClientRect().bottom || 0;
    const top = Math.max(24, Math.ceil(topbarBottom + 24));
    const visibleHeight = Math.max(320, window.innerHeight - top - 24);
    sideColumn.style.setProperty("--side-sticky-top", `${top}px`);
    sideColumn.style.setProperty("--side-max-height", `${visibleHeight}px`);
    layout?.style.setProperty("--layout-visible-height", `${visibleHeight}px`);
    sideColumn.classList.toggle("is-scrollable", sideColumn.scrollHeight > sideColumn.clientHeight + 1);
  }

  function queueSideColumnLayout() {
    if (sideColumnLayoutFrame !== null) return;
    sideColumnLayoutFrame = window.requestAnimationFrame(updateSideColumnLayout);
  }

  return { queueSideColumnLayout, updateSideColumnLayout };
}
