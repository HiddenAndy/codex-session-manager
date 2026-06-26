import { cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const packageRoot = join(dist, "codex-session-manager");
const zipPath = join(dist, "codex-session-manager.zip");
const include = ["README.md", "package.json", "package-lock.json", "server.mjs", "start.command", "start.ps1", "stop.command", "public", "docs", "scripts", "src"];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = stderr || error.message;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function hasCommand(command) {
  try {
    if (process.platform === "win32") {
      await run("where.exe", [command]);
    } else {
      await run("sh", ["-c", `command -v ${command}`]);
    }
    return true;
  } catch {
    return false;
  }
}

await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(packageRoot, { recursive: true });

for (const item of include) {
  await cp(join(root, item), join(packageRoot, item), { recursive: true, preserveTimestamps: true });
}

if (await hasCommand("zip")) {
  await run("zip", ["-qr", zipPath, "codex-session-manager"], { cwd: dist });
} else if (process.platform === "win32") {
  await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Compress-Archive -Path 'codex-session-manager' -DestinationPath 'codex-session-manager.zip' -Force",
  ], { cwd: dist });
} else {
  throw new Error("zip command is required to package a release.");
}
console.log(zipPath);
