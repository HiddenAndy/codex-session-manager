import { cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const packageRoot = join(dist, "codex-session-manager");
const zipPath = join(dist, "codex-session-manager.zip");
const include = ["README.md", "package.json", "package-lock.json", "server.mjs", "start.command", "stop.command", "start.cmd", "start.ps1", "public", "docs", "scripts", "src"];

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

await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(packageRoot, { recursive: true });

for (const item of include) {
  await cp(join(root, item), join(packageRoot, item), { recursive: true, preserveTimestamps: true });
}

await run("zip", ["-qr", zipPath, "codex-session-manager"], { cwd: dist });
console.log(zipPath);
