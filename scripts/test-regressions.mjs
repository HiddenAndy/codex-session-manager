import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createPathNormalizer } from "../src/server/fs-utils.mjs";
import { chatSizeAdvice } from "../public/js/format.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverModuleDir = join(root, "src", "server");
const serverModuleFiles = (await readdir(serverModuleDir)).filter((name) => name.endsWith(".mjs"));
const serverSource = [
  await readFile(join(root, "server.mjs"), "utf8"),
  ...(await Promise.all(serverModuleFiles.map((fileName) => readFile(join(serverModuleDir, fileName), "utf8")))),
].join("\n");
const projectActionsSource = await readFile(join(root, "public", "js", "project-actions.js"), "utf8");
const updateUiSource = await readFile(join(root, "public", "js", "update-ui.js"), "utf8");
const indexHtmlSource = await readFile(join(root, "public", "index.html"), "utf8");
const appEventsSource = await readFile(join(root, "public", "js", "app-events.js"), "utf8");
const stylesSource = await readFile(join(root, "public", "styles.css"), "utf8");
const sideColumnSource = await readFile(join(root, "public", "js", "side-column.js"), "utf8");

assert.doesNotMatch(serverSource, /github\.com[:/]Hidden[^/]+\/codex-session-manager/i, "server code should not hard-code a personal GitHub account");
assert.match(serverSource, /ARCHIVED_SESSIONS_ROOT/, "server should scan archived_sessions");
assert.match(serverSource, /for \(const sessionDirName of \["sessions", "archived_sessions"\]\)/, "restore should handle archived_sessions");
assert.match(serverSource, /backupPathForSessionFile/, "session backups should preserve managed session roots");
assert.match(serverSource, /pruneDbThreadsWithMissingSessionFiles/, "restore should prune DB rows without session files");
assert.match(serverSource, /createChatTransferService/, "server should include chat transfer backup service");
const chatTransferServiceConfig = serverSource.match(/createChatTransferService\(\{[\s\S]*?\n\}\);/)?.[0] || "";
assert.match(chatTransferServiceConfig, /ARCHIVED_SESSIONS_ROOT/, "chat transfer service should receive archived_sessions root");
const repairServiceConfig = serverSource.match(/createRepairService\(\{[\s\S]*?\n\}\);/)?.[0] || "";
assert.match(repairServiceConfig, /loadIndex/, "repair service should receive loadIndex for index-row repair");
assert.match(serverSource, /\/api\/export-chat-backup/, "server should expose chat backup export API");
assert.match(serverSource, /\/api\/import-chat-backup/, "server should expose chat backup import API");
assert.match(serverSource, /platform\(\) === "win32"/, "path picker should support Windows");
assert.match(serverSource, /isAbsolutePathLike/, "path handling should recognize Windows absolute paths");
assert.match(serverSource, /\^\[a-zA-Z\]:\[\\\\\/\]/, "path handling should recognize drive-letter paths");
assert.match(serverSource, /updateRunnerScriptWindows/, "update installer should include a Windows runner");
assert.match(serverSource, /powershell\.exe/, "update installer should run through PowerShell on Windows");
assert.match(serverSource, /run-update-\$\{timestampSlug\(\)\}\$\{isWindows \? "\.ps1" : "\.sh"\}/, "update installer should write platform-specific runner scripts");
assert.match(serverSource, /start\.ps1/, "update installer should preserve and restart through the Windows launcher");
const moveProjectPathSource = projectActionsSource.match(/async function moveProjectPath\(project\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.match(moveProjectPathSource, /\/api\/select-path/, "project path changes should use the native folder picker");
assert.match(moveProjectPathSource, /currentPath: project/, "project path picker should open at the current project directory");
assert.match(moveProjectPathSource, /const to = String\(selected\.path/, "selected project folder should be treated as the final path");
assert.match(moveProjectPathSource, /\/api\/repair-cwd/, "project path changes should update Codex references directly");
assert.doesNotMatch(moveProjectPathSource, /\/api\/move-project/, "project path changes should not append the old basename to a selected parent");

assert.equal(chatSizeAdvice(14 * 1024 * 1024), null, "chats below 15MB should not show a size advice badge");
assert.equal(chatSizeAdvice(15 * 1024 * 1024).label, "새 채팅 고려", "15MB chats should suggest considering a new chat");
assert.equal(chatSizeAdvice(30 * 1024 * 1024).label, "새 채팅 권장", "30MB chats should recommend a new chat");
assert.equal(chatSizeAdvice(50 * 1024 * 1024).label, "새 채팅 강력 권장", "50MB chats should strongly recommend a new chat");

assert.match(updateUiSource, /showManualUpdateGuide/, "update UI should provide manual update guidance");
assert.match(updateUiSource, /codex-session-manager\.zip/, "manual update guidance should name the release zip");
assert.match(updateUiSource, /releases\/latest/, "manual update guidance should link to the latest release when possible");
assert.match(updateUiSource, /catch \(error\)[\s\S]*showManualUpdateGuide\(error, updateInfo\)/, "install failures should show manual update guidance");

assert.doesNotMatch(indexHtmlSource, /refreshButton|새로고침/, "topbar should not show the ineffective refresh button");
assert.match(indexHtmlSource, /id="shutdownButton"/, "topbar should keep the shutdown button");
assert.doesNotMatch(appEventsSource, /refreshButton/, "app events should not bind the removed refresh button");
assert.match(appEventsSource, /refresh\(\)\s*\n\s*\.then\(\(\) => maybeShowUpdateNotice\(\)\)/, "app events should still run the initial refresh");
assert.match(stylesSource, /\.topbar\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/, "topbar should stay visible while scrolling");
assert.match(stylesSource, /\.side-column\s*\{[\s\S]*?top:\s*var\(--side-sticky-top, 24px\)/, "side column should offset below the sticky header");
assert.match(sideColumnSource, /topbar\?\.getBoundingClientRect\(\)\.bottom/, "side column layout should account for the sticky header height");
assert.match(stylesSource, /\.thread-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) max-content;/, "thread actions should occupy a real grid column");
assert.match(stylesSource, /\.backup-row\s*\{[\s\S]*?grid-template-columns:[\s\S]*minmax\(0, 1fr\)/, "backup rows should allow long paths to shrink inside the row");
assert.match(stylesSource, /\.backup-actions button\s*\{[\s\S]*?white-space:\s*nowrap;/, "backup action labels should not break vertically");

const pathNormalizer = createPathNormalizer((value) => value);
assert.equal(pathNormalizer.normalizeAbsolutePath("D:\\Codex\\repo"), "D:/Codex/repo", "Windows drive paths should normalize consistently");
assert.ok(pathNormalizer.pathMatchVariants("D:\\Codex\\repo").includes("D:/Codex/repo"), "Windows drive path variants should include slash form");
assert.ok(pathNormalizer.pathMatchVariants("\\\\server\\share\\repo").includes("//server/share/repo"), "UNC path variants should include slash form");
assert.equal(pathNormalizer.normalizeAbsolutePath("\\d\\Codex\\repo"), "D:/Codex/repo", "legacy drive-root paths should normalize to drive-letter paths");
assert.equal(pathNormalizer.normalizeAbsolutePath("\\\\d\\Codex\\repo"), "D:/Codex/repo", "double-backslash legacy drive-root paths should normalize to drive-letter paths");
assert.equal(pathNormalizer.normalizeAbsolutePath("/mnt/d/Codex/repo"), "D:/Codex/repo", "WSL mount paths should normalize to drive-letter paths");

const noteFiles = (await readdir(join(root, "docs", "patch-notes", "releases"))).filter((name) => name.endsWith(".md"));
assert.ok(noteFiles.length >= 3, "at least three patch note files should be available");
for (const fileName of noteFiles) {
  const text = await readFile(join(root, "docs", "patch-notes", "releases", fileName), "utf8");
  assert.match(text, /^## /m, `${fileName} should have a markdown heading`);
  assert.match(text, /^- /m, `${fileName} should have bullet items`);
}

console.log("regression checks passed");
