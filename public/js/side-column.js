export function createSideColumnLayout() {
  let sideColumnLayoutFrame = null;

  function updateSideColumnLayout() {
    sideColumnLayoutFrame = null;
    const sideColumn = document.querySelector(".side-column");
    if (!sideColumn) return;
    if (window.matchMedia("(max-width: 1200px)").matches) {
      sideColumn.style.removeProperty("--side-max-height");
      sideColumn.classList.remove("is-scrollable");
      return;
    }
    const top = Math.max(24, sideColumn.getBoundingClientRect().top);
    sideColumn.style.setProperty("--side-max-height", `${Math.max(320, window.innerHeight - top - 24)}px`);
    sideColumn.classList.toggle("is-scrollable", sideColumn.scrollHeight > sideColumn.clientHeight + 1);
  }

  function queueSideColumnLayout() {
    if (sideColumnLayoutFrame !== null) return;
    sideColumnLayoutFrame = window.requestAnimationFrame(updateSideColumnLayout);
  }

  return { queueSideColumnLayout, updateSideColumnLayout };
}
