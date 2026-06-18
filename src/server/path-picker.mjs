import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { execFileText } from "./codex-process.mjs";

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function createPathPicker({ expandHomePath, getCodexHome, normalizeAbsolutePath }) {
  async function existingDirectoryForPicker(path) {
    const codexHome = getCodexHome();
    const resolved = normalizeAbsolutePath(expandHomePath(path || codexHome));
    const candidates = [resolved, dirname(resolved), codexHome, homedir()];
    for (const candidate of candidates) {
      const st = await stat(candidate).catch(() => null);
      if (st?.isDirectory()) return candidate;
    }
    return homedir();
  }

  async function selectPath(payload) {
    const kind = payload.kind === "file" ? "file" : "directory";
    const currentPath = String(payload.currentPath || "");
    const defaultDirectory = await existingDirectoryForPicker(currentPath);
    const prompt = kind === "file" ? "SQLite DB 파일을 선택하세요." : "폴더를 선택하세요.";
    const chooseLine =
      kind === "file"
        ? `choose file with prompt "${appleScriptString(prompt)}" default location defaultLocation`
        : `choose folder with prompt "${appleScriptString(prompt)}" default location defaultLocation`;
    const script = [
      `set defaultLocation to POSIX file "${appleScriptString(defaultDirectory)}"`,
      `set pickedPath to ${chooseLine}`,
      "POSIX path of pickedPath",
    ].join("\n");
    try {
      const stdout = await execFileText("osascript", ["-e", script]);
      const selectedPath = stdout.trim();
      return { canceled: false, path: kind === "directory" ? normalizeAbsolutePath(selectedPath) : selectedPath };
    } catch (error) {
      const message = `${error.stderr || ""}\n${error.message || ""}`;
      if (message.includes("User canceled") || message.includes("사용자가 취소") || message.includes("(-128)") || error.code === 1) {
        return { canceled: true };
      }
      throw error;
    }
  }

  return { selectPath };
}
