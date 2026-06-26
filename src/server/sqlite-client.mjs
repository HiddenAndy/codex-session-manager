import { execFile, spawn } from "node:child_process";

const SQLITE_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000];

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isSqliteBusyError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("database is locked") || message.includes("database busy") || message.includes("sqlite_busy");
}

function sqliteOnce(args, options = {}) {
  const sqliteArgs = ["-cmd", ".timeout 5000", ...args];
  if (options.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("sqlite3", sqliteArgs);
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          reject(new Error(err || `sqlite3 exited with ${code}`));
          return;
        }
        resolvePromise(out);
      });
      child.stdin.end(options.input);
    });
  }
  return new Promise((resolvePromise, reject) => {
    execFile("sqlite3", sqliteArgs, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message += stderr ? `\n${stderr}` : "";
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function sqlite(args, options = {}) {
  const retries = options.retries ?? SQLITE_RETRY_DELAYS_MS.length;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await sqliteOnce(args, options);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === retries) break;
      await sleep(SQLITE_RETRY_DELAYS_MS[Math.min(attempt, SQLITE_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw lastError;
}
