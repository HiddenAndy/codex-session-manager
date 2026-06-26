import { readFile, writeFile } from "node:fs/promises";
import { exists, isAbsolutePath } from "./fs-utils.mjs";

function tomlProjectHeader(project) {
  return `[projects."${String(project).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

function unescapeTomlProjectName(value) {
  return String(value || "").replace(/\\(["\\])/g, "$1");
}

export function createCodexProjectConfigService({ getConfigToml, normalizeAbsolutePath, pathMatchVariants }) {
  async function loadConfigProjects() {
    const configToml = getConfigToml();
    if (!(await exists(configToml))) return [];
    const textContent = await readFile(configToml, "utf8");
    const projects = [];
    const re = /^\[projects\."((?:\\.|[^"\\])*)"\]\s*$/gm;
    let match;
    while ((match = re.exec(textContent)) !== null) {
      const project = normalizeAbsolutePath(unescapeTomlProjectName(match[1]));
      if (isAbsolutePath(project)) projects.push(project);
    }
    return [...new Set(projects)];
  }

  async function ensureCodexProjectConfig(project) {
    const configToml = getConfigToml();
    if (!project || !(await exists(configToml))) return { changed: false, reason: "missing-config" };
    const textContent = await readFile(configToml, "utf8");
    const header = tomlProjectHeader(normalizeAbsolutePath(project));
    if (textContent.includes(header)) return { changed: false, reason: "already-present" };
    const addition = `\n${header}\ntrust_level = "trusted"\n`;
    await writeFile(configToml, `${textContent.replace(/\s*$/, "")}\n${addition}`, "utf8");
    return { changed: true, project };
  }

  async function replaceCodexProjectConfig(fromValues, to) {
    const configToml = getConfigToml();
    if (!(await exists(configToml))) return { changed: false, reason: "missing-config" };
    const normalizedTo = normalizeAbsolutePath(to);
    const toHeader = tomlProjectHeader(normalizedTo);
    const fromHeaders = new Set(fromValues.map((value) => tomlProjectHeader(value)).filter((header) => header !== toHeader));
    const lines = (await readFile(configToml, "utf8")).split("\n");
    let hasToHeader = lines.some((line) => line.trim() === toHeader);
    let changed = false;
    const nextLines = [];
    let skippingOldBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) skippingOldBlock = false;
      if (fromHeaders.has(trimmed)) {
        changed = true;
        if (hasToHeader) {
          skippingOldBlock = true;
          continue;
        }
        nextLines.push(toHeader);
        hasToHeader = true;
        continue;
      }
      if (skippingOldBlock) continue;
      nextLines.push(line);
    }

    if (!hasToHeader) {
      nextLines.push("", toHeader, 'trust_level = "trusted"');
      changed = true;
    }

    if (changed) await writeFile(configToml, `${nextLines.join("\n").replace(/\s*$/, "")}\n`, "utf8");
    return { changed, project: normalizedTo };
  }

  async function removeCodexProjectConfig(project) {
    const configToml = getConfigToml();
    if (!(await exists(configToml))) return { changed: false, reason: "missing-config" };
    const targets = new Set(pathMatchVariants(project).map((value) => tomlProjectHeader(normalizeAbsolutePath(value))));
    const lines = (await readFile(configToml, "utf8")).split("\n");
    const nextLines = [];
    let changed = false;
    let skippingBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) skippingBlock = false;
      if (targets.has(trimmed)) {
        changed = true;
        skippingBlock = true;
        continue;
      }
      if (skippingBlock) continue;
      nextLines.push(line);
    }

    if (changed) await writeFile(configToml, `${nextLines.join("\n").replace(/\s*$/, "")}\n`, "utf8");
    return { changed, project: normalizeAbsolutePath(project) };
  }

  return { ensureCodexProjectConfig, loadConfigProjects, removeCodexProjectConfig, replaceCodexProjectConfig };
}
