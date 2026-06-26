import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createPathNormalizer } from "../src/server/fs-utils.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverModuleDir = join(root, "src", "server");
const serverModuleFiles = (await readdir(serverModuleDir)).filter((name) => name.endsWith(".mjs"));
const serverSource = [
  await readFile(join(root, "server.mjs"), "utf8"),
  ...(await Promise.all(serverModuleFiles.map((fileName) => readFile(join(serverModuleDir, fileName), "utf8")))),
].join("\n");

assert.match(serverSource, /ARCHIVED_SESSIONS_ROOT/, "server should scan archived_sessions");
assert.match(serverSource, /for \(const sessionDirName of \["sessions", "archived_sessions"\]\)/, "restore should handle archived_sessions");
assert.match(serverSource, /backupPathForSessionFile/, "session backups should preserve managed session roots");
assert.match(serverSource, /pruneDbThreadsWithMissingSessionFiles/, "restore should prune DB rows without session files");
assert.match(serverSource, /createChatTransferService/, "server should include chat transfer backup service");
const chatTransferServiceConfig = serverSource.match(/createChatTransferService\(\{[\s\S]*?\n\}\);/)?.[0] || "";
assert.match(chatTransferServiceConfig, /ARCHIVED_SESSIONS_ROOT/, "chat transfer service should receive archived_sessions root");
assert.match(serverSource, /\/api\/export-chat-backup/, "server should expose chat backup export API");
assert.match(serverSource, /\/api\/import-chat-backup/, "server should expose chat backup import API");
assert.match(serverSource, /platform\(\) === "win32"/, "path picker should support Windows");
assert.match(serverSource, /isAbsolutePathLike/, "path handling should recognize Windows absolute paths");
assert.match(serverSource, /\^\[a-zA-Z\]:\[\\\\\/\]/, "path handling should recognize drive-letter paths");
assert.match(serverSource, /updateRunnerScriptWindows/, "update installer should include a Windows runner");
assert.match(serverSource, /powershell\.exe/, "update installer should run through PowerShell on Windows");
assert.match(serverSource, /run-update-\$\{timestampSlug\(\)\}\$\{isWindows \? "\.ps1" : "\.sh"\}/, "update installer should write platform-specific runner scripts");
assert.match(serverSource, /start\.ps1/, "update installer should preserve and restart through the Windows launcher");

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
