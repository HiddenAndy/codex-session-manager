import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

const noteFiles = (await readdir(join(root, "docs", "patch-notes", "releases"))).filter((name) => name.endsWith(".md"));
assert.ok(noteFiles.length >= 3, "at least three patch note files should be available");
for (const fileName of noteFiles) {
  const text = await readFile(join(root, "docs", "patch-notes", "releases", fileName), "utf8");
  assert.match(text, /^## /m, `${fileName} should have a markdown heading`);
  assert.match(text, /^- /m, `${fileName} should have bullet items`);
}

console.log("regression checks passed");
