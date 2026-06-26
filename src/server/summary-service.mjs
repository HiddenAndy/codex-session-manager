import { stat } from "node:fs/promises";
import { normalize } from "node:path";

export function createSummaryService(deps) {
  const {
    byId,
    exists,
    getPaths,
    loadBackups,
    loadCodexGlobalState,
    loadConfigProjects,
    loadGlobalProjects,
    loadIndex,
    loadSessionFiles,
    loadSpawnEdges,
    loadThreads,
    normalizeAbsolutePath,
    pathCompareKey,
  } = deps;
  const paths = getPaths;

async function buildSummary() {
  const [threads, sessionFiles, indexRows, backups, spawnEdges, globalState, globalProjects, configProjects] = await Promise.all([
    loadThreads(),
    loadSessionFiles(),
    loadIndex(),
    loadBackups(),
    loadSpawnEdges(),
    loadCodexGlobalState(),
    loadGlobalProjects(),
    loadConfigProjects(),
  ]);
  const projectlessThreadIds = new Set(globalState["projectless-thread-ids"] || []);
  const globalProjectSet = new Set(globalProjects.map(pathCompareKey));
  const threadMap = byId(threads);
  const fileMap = byId(sessionFiles);
  const indexMap = byId(indexRows);
  const projectExistsCache = new Map();
  async function projectExists(project) {
    if (!project) return true;
    if (!projectExistsCache.has(project)) {
      const st = await stat(project).catch(() => null);
      projectExistsCache.set(project, Boolean(st?.isDirectory()));
    }
    return projectExistsCache.get(project);
  }
  const parentByChild = new Map();
  const childrenByParent = new Map();
  for (const edge of spawnEdges) {
    parentByChild.set(edge.childId, edge.parentId);
    if (!childrenByParent.has(edge.parentId)) childrenByParent.set(edge.parentId, []);
    childrenByParent.get(edge.parentId).push(edge.childId);
  }
  const ids = new Set([...threadMap.keys(), ...fileMap.keys(), ...indexMap.keys()]);
  const records = await Promise.all([...ids].map(async (id) => {
    const thread = threadMap.get(id)?.[0] || null;
    const files = fileMap.get(id) || [];
    const primaryFile = files.find((file) => file.canonicalName) || files[0] || null;
    const index = indexMap.get(id)?.[0] || null;
    const parentId = parentByChild.get(id) || primaryFile?.parentThreadId || null;
    const role = thread?.thread_source === "subagent" || primaryFile?.threadSource === "subagent" ? "agent" : "user";
    const project = thread?.cwd || primaryFile?.cwd || null;
    const projectless = projectlessThreadIds.has(id);
    const issues = [];
    if (!primaryFile) issues.push("missing-session-file");
    if (thread && primaryFile && pathCompareKey(thread.cwd) !== pathCompareKey(primaryFile.cwd)) issues.push("cwd-mismatch");
    if (primaryFile && !primaryFile.canonicalName) issues.push("non-canonical-session-file");
    if (files.length > 1) issues.push("duplicate-session-files");
    if (thread && primaryFile && pathCompareKey(normalize(thread.rollout_path)) !== pathCompareKey(normalize(primaryFile.path))) {
      issues.push("rollout-path-differs");
    }
    if (!index) issues.push("missing-session-index");
    if (!thread && (!primaryFile || !index)) issues.push("missing-db-thread");
    if (!projectless && project && !(await projectExists(project))) issues.push("missing-project-path");
    if (!projectless && project && (await projectExists(project)) && !globalProjectSet.has(pathCompareKey(project))) {
      issues.push("missing-codex-project-registration");
    }
    return { id, role, project, projectless, parentId, thread, primaryFile, files, index, issues };
  }));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const groups = [];
  for (const record of records) {
    if (record.parentId) continue;
    const explicitChildren = childrenByParent.get(record.id) || [];
    const inferredChildren = records.filter((candidate) => candidate.parentId === record.id).map((candidate) => candidate.id);
    const childIds = [...new Set([...explicitChildren, ...inferredChildren])];
    const children = childIds
      .map((childId) => recordById.get(childId))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
        const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
        return bTime - aTime;
      });
    groups.push({ parent: record, children, projectless: record.projectless || children.some((child) => child.projectless) });
  }
  const orphanChildrenByParent = new Map();
  for (const record of records) {
    if (!record.parentId || recordById.has(record.parentId)) continue;
    if (!orphanChildrenByParent.has(record.parentId)) orphanChildrenByParent.set(record.parentId, []);
    orphanChildrenByParent.get(record.parentId).push(record);
  }
  for (const [missingParentId, children] of orphanChildrenByParent) {
    children.sort((a, b) => {
      const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
      const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
      return bTime - aTime;
    });
    groups.push({ parent: null, missingParentId, children, projectless: children.some((child) => child.projectless) });
  }
  const representedProjects = new Set();
  const projectlessProjects = new Set();
  for (const group of groups) {
    for (const record of [group.parent, ...group.children].filter(Boolean)) {
      if (record.projectless) {
        if (record.project) projectlessProjects.add(pathCompareKey(record.project));
        continue;
      }
      if (record.project) representedProjects.add(pathCompareKey(record.project));
    }
  }
  for (const project of [...new Set([...globalProjects, ...configProjects])].sort()) {
    if (!representedProjects.has(pathCompareKey(project)) && !projectlessProjects.has(pathCompareKey(project))) {
      const projectIssues = [];
      if (!(await projectExists(project))) projectIssues.push("missing-project-path");
      if (!globalProjectSet.has(pathCompareKey(project))) projectIssues.push("missing-codex-project-registration");
      groups.push({ parent: null, children: [], project, emptyProject: true, projectIssues });
    }
  }
  groups.sort((a, b) => {
    if (a.emptyProject && b.emptyProject) return String(a.project).localeCompare(String(b.project));
    if (a.emptyProject) return 1;
    if (b.emptyProject) return -1;
    const aRecord = a.parent || a.children[0];
    const bRecord = b.parent || b.children[0];
    const aTime = aRecord?.thread?.updated_at_ms || aRecord?.primaryFile?.mtimeMs || 0;
    const bTime = bRecord?.thread?.updated_at_ms || bRecord?.primaryFile?.mtimeMs || 0;
    return bTime - aTime;
  });
  records.sort((a, b) => {
    const aTime = a.thread?.updated_at_ms || a.primaryFile?.mtimeMs || 0;
    const bTime = b.thread?.updated_at_ms || b.primaryFile?.mtimeMs || 0;
    return bTime - aTime;
  });
  const issueCounts = {};
  for (const record of records) {
    for (const issue of record.issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }
  return {
    codexHome: paths().CODEX_HOME,
    codexHomeExists: await exists(paths().CODEX_HOME),
    configPath: paths().CONFIG_PATH,
    defaultCodexHome: paths().DEFAULT_CODEX_HOME,
    stateDb: paths().STATE_DB,
    stateDbExists: await exists(paths().STATE_DB),
    sessionsRoot: paths().SESSIONS_ROOT,
    sessionsRootExists: await exists(paths().SESSIONS_ROOT),
    backupsRoot: paths().BACKUPS_ROOT,
    backupsRootExists: await exists(paths().BACKUPS_ROOT),
    generatedAt: new Date().toISOString(),
    counts: {
      threads: threads.length,
      sessionFiles: sessionFiles.length,
      indexRows: indexRows.length,
      records: records.length,
      backups: backups.length,
      spawnEdges: spawnEdges.length,
      groups: groups.length,
      projects: new Set([...globalProjects, ...configProjects.filter((project) => !projectlessProjects.has(project)), ...representedProjects]).size,
    },
    issueCounts,
    spawnEdges,
    groups,
    records,
    backups,
  };
}


  return { buildSummary };
}
