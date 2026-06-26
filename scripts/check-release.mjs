import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const zipPath = join(root, "dist", "codex-session-manager.zip");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function hasCommand(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(baseDir, rootDir = baseDir) {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, rootDir));
    } else if (entry.isFile()) {
      files.push(relative(rootDir, fullPath).replaceAll("\\", "/"));
    }
  }
  return files;
}

async function inspectReleaseZip() {
  if (hasCommand("unzip")) {
    return {
      packageJson: execFileSync("unzip", ["-p", zipPath, "codex-session-manager/package.json"], { encoding: "utf8" }),
      listing: execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" }),
    };
  }
  if (process.platform !== "win32") throw new Error("unzip command is required to inspect the release zip.");
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-session-manager-release-"));
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "& { param($zipPath, $destination) Expand-Archive -LiteralPath $zipPath -DestinationPath $destination -Force }",
      zipPath,
      tempRoot,
    ], { stdio: "ignore" });
    const packageRoot = join(tempRoot, "codex-session-manager");
    return {
      packageJson: await readFile(join(packageRoot, "package.json"), "utf8"),
      listing: (await listFilesRecursive(tempRoot)).join("\n"),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (!version) fail("package.json version is missing.");
if (!existsSync(join(root, "docs", "patch-notes", "releases", `${version}.md`))) {
  fail(`patch notes file is missing: docs/patch-notes/releases/${version}.md`);
}
if (!existsSync(zipPath)) {
  fail("release zip is missing: dist/codex-session-manager.zip");
} else {
  const { packageJson, listing } = await inspectReleaseZip();
  const distVersion = JSON.parse(packageJson).version;
  if (distVersion !== version) fail(`zip version mismatch: package=${version}, zip=${distVersion}`);
  for (const required of [
    "codex-session-manager/server.mjs",
    "codex-session-manager/start.ps1",
    "codex-session-manager/public/app.js",
    "codex-session-manager/docs/patch-notes.md",
    `codex-session-manager/docs/patch-notes/releases/${version}.md`,
    "codex-session-manager/scripts/check-release.mjs",
    "codex-session-manager/scripts/test-regressions.mjs",
    "codex-session-manager/src/server/backup-inspector.mjs",
    "codex-session-manager/src/server/backup-service.mjs",
    "codex-session-manager/src/server/chat-transfer-service.mjs",
    "codex-session-manager/src/server/codex-global-state.mjs",
    "codex-session-manager/src/server/codex-process.mjs",
    "codex-session-manager/src/server/codex-project-config.mjs",
    "codex-session-manager/src/server/fs-utils.mjs",
    "codex-session-manager/src/server/http-utils.mjs",
    "codex-session-manager/src/server/path-picker.mjs",
    "codex-session-manager/src/server/routes.mjs",
    "codex-session-manager/src/server/sqlite-client.mjs",
    "codex-session-manager/src/server/update-service.mjs",
    "codex-session-manager/public/js/api.js",
    "codex-session-manager/public/js/app-events.js",
    "codex-session-manager/public/js/backup-render.js",
    "codex-session-manager/public/js/codex-status.js",
    "codex-session-manager/public/js/labels.js",
    "codex-session-manager/public/js/modal.js",
    "codex-session-manager/public/js/thread-selection.js",
    "codex-session-manager/public/js/update-ui.js",
  ]) {
    if (!listing.includes(required)) fail(`zip missing required file: ${required}`);
  }
}

if (!process.exitCode) console.log(`release check passed for ${version}`);
