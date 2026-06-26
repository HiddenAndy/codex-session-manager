import { execFile } from "node:child_process";

export function execFileText(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function getCodexProcessStatus() {
  if (process.platform === "win32") {
    try {
      const output = await execFileText("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Process -Name Codex,codex -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress",
      ]);
      const parsed = output.trim() ? JSON.parse(output) : [];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const processes = rows
        .filter((row) => row && String(row.ProcessName || "").toLowerCase() === "codex")
        .map((row) => ({ pid: Number(row.Id), command: row.Path || row.ProcessName }));
      return { open: processes.length > 0, processes };
    } catch (error) {
      return { open: false, error: error.message };
    }
  }

  try {
    const output = await execFileText("ps", ["-axo", "pid=,args="]);
    const processes = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean)
      .filter((process) => process.command === "/Applications/Codex.app/Contents/MacOS/Codex");
    return { open: processes.length > 0, processes };
  } catch (error) {
    return { open: false, error: error.message };
  }
}

export async function assertCodexClosed() {
  const status = await getCodexProcessStatus();
  if (status.open) throw new Error("Codex가 실행 중입니다. Codex를 완전히 종료한 뒤 다시 시도하세요.");
  return status;
}
