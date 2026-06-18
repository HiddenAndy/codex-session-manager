import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { exists } from "./fs-utils.mjs";

function replaceProjectPathArray(values, fromSet, to, normalizeAbsolutePath) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  let changed = false;
  const next = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeAbsolutePath(value);
    const mapped = fromSet.has(normalized) || fromSet.has(String(value || "")) ? to : value;
    if (mapped !== value) changed = true;
    if (seen.has(mapped)) {
      changed = true;
      continue;
    }
    seen.add(mapped);
    next.push(mapped);
  }
  if (!seen.has(to) && values.some((value) => fromSet.has(normalizeAbsolutePath(value)) || fromSet.has(String(value || "")))) {
    next.push(to);
    changed = true;
  }
  return { value: next, changed };
}

function replaceProjectPathMapValues(map, fromSet, to, normalizeAbsolutePath) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && (fromSet.has(normalizeAbsolutePath(value)) || fromSet.has(value))) {
      next[key] = to;
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return { value: next, changed };
}

function replaceProjectPathMapKeys(map, fromSet, to, normalizeAbsolutePath) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    const mappedKey = fromSet.has(normalizeAbsolutePath(key)) || fromSet.has(key) ? to : key;
    if (mappedKey !== key) changed = true;
    next[mappedKey] = value;
  }
  return { value: next, changed };
}

function appendMissingProjectPathArray(values, project, normalizeAbsolutePath) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  const normalizedProject = normalizeAbsolutePath(project);
  if (values.some((value) => normalizeAbsolutePath(value) === normalizedProject || String(value || "") === normalizedProject)) {
    return { value: values, changed: false };
  }
  return { value: [...values, normalizedProject], changed: true };
}

function globalStateProjectCandidates(state) {
  const values = new Set();
  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    for (const value of state[key] || []) values.add(value);
  }
  const projectlessThreadIds = new Set(state["projectless-thread-ids"] || []);
  for (const [threadId, value] of Object.entries(state["thread-workspace-root-hints"] || {})) {
    if (!projectlessThreadIds.has(threadId)) values.add(value);
  }
  for (const key of Object.keys(state["electron-workspace-root-labels"] || {})) values.add(key);
  return [...values].filter((value) => typeof value === "string" && value.startsWith("/"));
}

function isLikelyPreviousProjectPath(candidate, currentPaths, normalizeAbsolutePath) {
  const normalizedCandidate = normalizeAbsolutePath(candidate);
  const candidateBase = basename(normalizedCandidate);
  if (!candidateBase) return false;
  return currentPaths.some((currentPath) => {
    const normalizedCurrent = normalizeAbsolutePath(currentPath);
    if (normalizedCurrent === normalizedCandidate) return false;
    if (dirname(normalizedCurrent) !== dirname(normalizedCandidate)) return false;
    const currentBase = basename(normalizedCurrent);
    if (currentBase.startsWith(`${candidateBase}-`) || currentBase.startsWith(`${candidateBase}_`)) return true;
    if (!currentBase.startsWith(candidateBase)) return false;
    return /^\d+$/.test(currentBase.slice(candidateBase.length));
  });
}

function removeProjectPathArray(values, targetSet, normalizeAbsolutePath) {
  if (!Array.isArray(values)) return { value: values, changed: false };
  const next = values.filter((value) => !targetSet.has(normalizeAbsolutePath(value)) && !targetSet.has(String(value || "")));
  return { value: next, changed: next.length !== values.length };
}

function removeProjectPathMapValues(map, targetSet, normalizeAbsolutePath) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && (targetSet.has(normalizeAbsolutePath(value)) || targetSet.has(value))) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return { value: next, changed };
}

function removeProjectPathMapKeys(map, targetSet, normalizeAbsolutePath) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { value: map, changed: false };
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(map)) {
    if (targetSet.has(normalizeAbsolutePath(key)) || targetSet.has(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return { value: next, changed };
}

export function createCodexGlobalStateService({ getGlobalStatePath, getGlobalStateBackupPath, getChatProcessesPath, normalizeAbsolutePath, pathMatchVariants }) {
  async function loadCodexGlobalState() {
    const globalStatePath = getGlobalStatePath();
    if (!(await exists(globalStatePath))) return {};
    return JSON.parse(await readFile(globalStatePath, "utf8"));
  }

  async function loadGlobalProjects() {
    const state = await loadCodexGlobalState();
    return [...new Set(globalStateProjectCandidates(state).map(normalizeAbsolutePath))];
  }

  async function replaceCodexProjectGlobalStateFile(filePath, fromValues, to, options = {}) {
    if (!(await exists(filePath))) return { changed: false, reason: "missing-global-state" };
    const normalizedTo = normalizeAbsolutePath(to);
    const state = JSON.parse(await readFile(filePath, "utf8"));
    const normalizedFromValues = fromValues.flatMap(pathMatchVariants).map(normalizeAbsolutePath);
    const inferredAliases = globalStateProjectCandidates(state).filter((candidate) => isLikelyPreviousProjectPath(candidate, normalizedFromValues, normalizeAbsolutePath));
    const fromSet = new Set([...normalizedFromValues, ...inferredAliases.flatMap(pathMatchVariants).map(normalizeAbsolutePath)]);
    let changed = false;

    for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
      const result = replaceProjectPathArray(state[key], fromSet, normalizedTo, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    for (const key of ["thread-workspace-root-hints"]) {
      const result = replaceProjectPathMapValues(state[key], fromSet, normalizedTo, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    for (const key of ["electron-workspace-root-labels"]) {
      const result = replaceProjectPathMapKeys(state[key], fromSet, normalizedTo, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    let ensured = false;
    if (options.ensureProject) {
      for (const key of ["project-order", "electron-saved-workspace-roots"]) {
        const result = appendMissingProjectPathArray(state[key], normalizedTo, normalizeAbsolutePath);
        state[key] = result.value;
        changed = changed || result.changed;
        ensured = ensured || result.changed;
      }
    }

    if (changed) await writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
    return { changed, project: normalizedTo, inferredAliases, ensured };
  }

  async function replaceCodexProjectGlobalState(fromValues, to, options = {}) {
    const primary = await replaceCodexProjectGlobalStateFile(getGlobalStatePath(), fromValues, to, options);
    const backup = await replaceCodexProjectGlobalStateFile(getGlobalStateBackupPath(), fromValues, to, options);
    return {
      changed: primary.changed || backup.changed,
      project: normalizeAbsolutePath(to),
      files: {
        globalState: primary,
        globalStateBackup: backup,
      },
    };
  }

  async function replaceCodexChatProcesses(fromValues, to) {
    const chatProcessesPath = getChatProcessesPath();
    if (!(await exists(chatProcessesPath))) return { changed: false, reason: "missing-chat-processes" };
    const normalizedTo = normalizeAbsolutePath(to);
    const fromSet = new Set(fromValues.flatMap(pathMatchVariants).map(normalizeAbsolutePath));
    const processes = JSON.parse(await readFile(chatProcessesPath, "utf8"));
    if (!Array.isArray(processes)) return { changed: false, reason: "invalid-chat-processes" };
    let changed = false;
    let entriesChanged = 0;
    for (const entry of processes) {
      if (!entry || typeof entry !== "object" || typeof entry.cwd !== "string") continue;
      if (!fromSet.has(normalizeAbsolutePath(entry.cwd))) continue;
      entry.cwd = normalizedTo;
      changed = true;
      entriesChanged += 1;
    }
    if (changed) await writeFile(chatProcessesPath, `${JSON.stringify(processes, null, 2)}\n`, "utf8");
    return { changed, entriesChanged, path: chatProcessesPath };
  }

  async function removeCodexProjectGlobalStateFile(filePath, project) {
    if (!(await exists(filePath))) return { changed: false, reason: "missing-global-state" };
    const state = JSON.parse(await readFile(filePath, "utf8"));
    const targetSet = new Set(pathMatchVariants(project).map(normalizeAbsolutePath));
    let changed = false;

    for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
      const result = removeProjectPathArray(state[key], targetSet, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    for (const key of ["thread-workspace-root-hints"]) {
      const result = removeProjectPathMapValues(state[key], targetSet, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    for (const key of ["electron-workspace-root-labels"]) {
      const result = removeProjectPathMapKeys(state[key], targetSet, normalizeAbsolutePath);
      state[key] = result.value;
      changed = changed || result.changed;
    }

    if (changed) await writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
    return { changed, project: normalizeAbsolutePath(project) };
  }

  async function removeCodexProjectGlobalState(project) {
    const primary = await removeCodexProjectGlobalStateFile(getGlobalStatePath(), project);
    const backup = await removeCodexProjectGlobalStateFile(getGlobalStateBackupPath(), project);
    return {
      changed: primary.changed || backup.changed,
      project: normalizeAbsolutePath(project),
      files: {
        globalState: primary,
        globalStateBackup: backup,
      },
    };
  }

  return { loadCodexGlobalState, loadGlobalProjects, removeCodexProjectGlobalState, replaceCodexChatProcesses, replaceCodexProjectGlobalState };
}
