import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import initSqlJs from "sql.js";

const SQLITE_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000];
let sqlJsPromise = null;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isSqliteBusyError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("database is locked") || message.includes("database busy") || message.includes("sqlite_busy");
}

function isMissingSqliteCliError(error) {
  return error?.code === "ENOENT" || String(error?.message || "").includes("spawn sqlite3 ENOENT");
}

function isMissingPythonError(error) {
  return error?.code === "ENOENT" || String(error?.message || "").includes("spawn python ENOENT");
}

async function getSqlJs() {
  sqlJsPromise ||= initSqlJs();
  return sqlJsPromise;
}

function parseSqliteArgs(args, options) {
  const remaining = [...args];
  const json = remaining[0] === "-json";
  if (json) remaining.shift();
  const dbPath = remaining.shift();
  const sql = options.input !== undefined ? options.input : remaining.join("\n");
  return { dbPath, json, sql };
}

function stripCliCommands(sql) {
  let mode = "list";
  let backupPath = null;
  const lines = [];
  for (const line of String(sql || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(".")) {
      lines.push(line);
      continue;
    }
    if (trimmed.startsWith(".mode")) {
      const [, nextMode] = trimmed.split(/\s+/, 2);
      mode = nextMode || mode;
      continue;
    }
    if (trimmed.startsWith(".backup")) {
      const match = trimmed.match(/^\.backup\s+['"]?(.+?)['"]?$/);
      backupPath = match?.[1] || null;
      continue;
    }
  }
  return { mode, backupPath, sql: lines.join("\n").trim() };
}

function resultRows(result) {
  return result.values.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
}

function formatSqlJsOutput(results, { json, mode }) {
  if (json) {
    return `${JSON.stringify(results.flatMap(resultRows))}\n`;
  }
  const lines = [];
  for (const result of results) {
    for (const row of result.values) {
      if (mode === "tabs") {
        lines.push(row.map((value) => (value == null ? "" : String(value))).join("\t"));
      } else {
        lines.push(row.map((value) => (value == null ? "" : String(value))).join("|"));
      }
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

async function sqliteWithSqlJs(args, options = {}) {
  const { dbPath, json, sql } = parseSqliteArgs(args, options);
  const { mode, backupPath, sql: runnableSql } = stripCliCommands(sql);
  const SQL = await getSqlJs();
  const db = new SQL.Database(await readFile(dbPath));
  try {
    const results = runnableSql ? db.exec(runnableSql) : [];
    if (runnableSql && !/^\s*select\b/i.test(runnableSql) && !/^\s*pragma\b/i.test(runnableSql)) {
      await writeFile(dbPath, Buffer.from(db.export()));
    }
    if (backupPath) {
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, Buffer.from(db.export()));
    }
    return formatSqlJsOutput(results, { json, mode });
  } finally {
    db.close();
  }
}

function sqliteWithPython(args, options = {}) {
  const payload = parseSqliteArgs(args, options);
  const stripped = stripCliCommands(payload.sql);
  const request = {
    dbPath: payload.dbPath,
    json: payload.json,
    mode: stripped.mode,
    backupPath: stripped.backupPath,
    sql: stripped.sql,
  };
  const script = String.raw`
import json
import os
import sqlite3
import sys

request = json.loads(sys.stdin.read())
con = sqlite3.connect(request["dbPath"], timeout=30)
try:
    rows_out = []
    statement = ""
    for line in request.get("sql", "").splitlines():
        statement += line + "\n"
        if not sqlite3.complete_statement(statement):
            continue
        sql = statement.strip()
        statement = ""
        if not sql:
            continue
        cur = con.execute(sql)
        if cur.description:
            columns = [column[0] for column in cur.description]
            rows_out.append({"columns": columns, "values": cur.fetchall()})
    if statement.strip():
        cur = con.execute(statement.strip())
        if cur.description:
            columns = [column[0] for column in cur.description]
            rows_out.append({"columns": columns, "values": cur.fetchall()})
    con.commit()
    backup_path = request.get("backupPath")
    if backup_path:
        parent = os.path.dirname(backup_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        dest = sqlite3.connect(backup_path)
        try:
            con.backup(dest)
        finally:
            dest.close()
    if request.get("json"):
        flattened = []
        for result in rows_out:
            columns = result["columns"]
            for values in result["values"]:
                flattened.append(dict(zip(columns, values)))
        sys.stdout.write(json.dumps(flattened, ensure_ascii=False) + "\n")
    else:
        separator = "\t" if request.get("mode") == "tabs" else "|"
        lines = []
        for result in rows_out:
            for values in result["values"]:
                lines.append(separator.join("" if value is None else str(value) for value in values))
        if lines:
            sys.stdout.write("\n".join(lines) + "\n")
finally:
    con.close()
`;

  return new Promise((resolvePromise, reject) => {
    const child = spawn("python", ["-c", script]);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(err || `python sqlite exited with ${code}`));
        return;
      }
      resolvePromise(out);
    });
    child.stdin.end(JSON.stringify(request));
  });
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
      if (isMissingSqliteCliError(error)) {
        try {
          return await sqliteWithPython(args, options);
        } catch (pythonError) {
          if (!isMissingPythonError(pythonError)) throw pythonError;
          return sqliteWithSqlJs(args, options);
        }
      }
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === retries) break;
      await sleep(SQLITE_RETRY_DELAYS_MS[Math.min(attempt, SQLITE_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw lastError;
}
