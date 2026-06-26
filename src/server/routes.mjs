import { json, readRequestBody, serveStaticFile, text } from "./http-utils.mjs";

export function createRequestHandler({
  publicDir,
  getConfig,
  saveConfig,
  selectPath,
  buildSummary,
  getCodexProcessStatus,
  updateService,
  noteHeartbeat,
  shutdownSoon,
  repairCwd,
  renameProject,
  moveProject,
  repairProjectRegistration,
  repairProjectChats,
  repairThreadChat,
  fixStoredTitles,
  deleteBackup,
  deleteBackups,
  restoreBackup,
  deleteAllBackups,
  deleteUnknownOriginalBackups,
  deleteThread,
  deleteThreads,
  removeProject,
}) {
  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/api/config") {
        json(res, 200, await getConfig());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        json(res, 200, await saveConfig(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/select-path") {
        json(res, 200, await selectPath(await readRequestBody(req)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/summary") {
        json(res, 200, await buildSummary());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/codex-status") {
        json(res, 200, await getCodexProcessStatus());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/update-status") {
        json(res, 200, await updateService.getUpdateStatus());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/patch-notes") {
        json(res, 200, { notes: await updateService.readPatchNotes(url.searchParams.get("limit") || 3) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/runtime-info") {
        json(res, 200, updateService.getRuntimeInfo());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/update-notice") {
        json(res, 200, await updateService.getUpdateNotice());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        noteHeartbeat();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/update") {
        json(res, 200, await updateService.installUpdate());
        shutdownSoon(200);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/update-notice/read") {
        json(res, 200, await updateService.markUpdateNoticeRead());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        json(res, 200, { ok: true });
        shutdownSoon(50);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/repair-cwd") {
        json(res, 200, await repairCwd(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/rename-project") {
        json(res, 200, await renameProject(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/move-project") {
        json(res, 200, await moveProject(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/repair-project-registration") {
        json(res, 200, await repairProjectRegistration(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/repair-project-chats") {
        json(res, 200, await repairProjectChats(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/repair-thread-chat") {
        json(res, 200, await repairThreadChat(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/fix-titles") {
        json(res, 200, await fixStoredTitles());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-backup") {
        json(res, 200, await deleteBackup(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-backups") {
        json(res, 200, await deleteBackups(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/restore-backup") {
        json(res, 200, await restoreBackup(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-all-backups") {
        json(res, 200, await deleteAllBackups());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-unknown-original-backups") {
        json(res, 200, await deleteUnknownOriginalBackups());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-thread") {
        json(res, 200, await deleteThread(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/delete-threads") {
        json(res, 200, await deleteThreads(await readRequestBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/remove-project") {
        json(res, 200, await removeProject(await readRequestBody(req)));
        return;
      }
      if (req.method === "GET") {
        serveStaticFile({ req, res, publicDir });
        return;
      }
      text(res, 405, "Method not allowed");
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  };
}
