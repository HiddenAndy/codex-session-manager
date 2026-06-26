import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function movePath(src, dest) {
  try {
    await rename(src, dest);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(src, dest, { recursive: true, preserveTimestamps: true });
    await rm(src, { recursive: true, force: true });
  }
}

export async function* walk(dir) {
  if (!(await exists(dir))) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

export function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

export async function backupFileIfExists(src, dest) {
  if (!(await exists(src))) return false;
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { preserveTimestamps: true });
  return true;
}

export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isAbsolutePath(value) {
  return isAbsolutePathLike(stripWindowsExtendedPathPrefix(value));
}

export function stripWindowsExtendedPathPrefix(value) {
  const textValue = String(value || "").trim();
  if (textValue.startsWith("\\\\?\\UNC\\")) return `\\\\${textValue.slice("\\\\?\\UNC\\".length)}`;
  if (textValue.startsWith("//?/UNC/")) return `//${textValue.slice("//?/UNC/".length)}`;
  if (textValue.startsWith("\\\\?\\")) return textValue.slice("\\\\?\\".length);
  if (textValue.startsWith("//?/")) return textValue.slice("//?/".length);
  return textValue;
}

function isAbsolutePathLike(value) {
  const textValue = stripWindowsExtendedPathPrefix(value);
  return (
    isAbsolute(textValue) ||
    /^[a-zA-Z]:[\\/]/.test(textValue) ||
    /^\\\\/.test(textValue) ||
    /^[\\/][a-zA-Z][\\/]/.test(textValue)
  );
}

function toWindowsExtendedPath(value) {
  const textValue = String(value || "").trim();
  if (process.platform !== "win32" || !isAbsolutePathLike(textValue) || textValue.startsWith("\\\\?\\")) return "";
  if (textValue.startsWith("\\\\")) return `\\\\?\\UNC\\${textValue.slice(2)}`;
  return `\\\\?\\${textValue}`;
}

function legacyDriveRootPath(value) {
  const match = stripWindowsExtendedPathPrefix(value).match(/^[\\/]{1,2}([a-zA-Z])[\\/](.+)$/);
  if (!match) return "";
  return `${match[1].toUpperCase()}:/${match[2].replaceAll("\\", "/")}`;
}

function wslMountPath(value) {
  const match = String(value || "").trim().match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return "";
  return `${match[1].toUpperCase()}:/${match[2]}`;
}

export function createPathNormalizer(expandHomePath) {
  function normalizeAbsolutePath(value) {
    const expanded = stripWindowsExtendedPathPrefix(expandHomePath(value));
    if (!isAbsolutePathLike(expanded)) return String(expanded || "").trim();
    const legacyDrive = legacyDriveRootPath(expanded);
    if (legacyDrive) return legacyDrive;
    const wslDrive = wslMountPath(expanded);
    if (wslDrive) return wslDrive;
    if (/^[a-zA-Z]:[\\/]/.test(expanded)) return expanded.replaceAll("\\", "/");
    if (/^\\\\/.test(expanded)) return expanded.replaceAll("\\", "/");
    return resolve(expanded);
  }

  function pathCompareKey(value) {
    const normalized = normalizeAbsolutePath(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  function pathMatchVariants(value) {
    const textValue = String(value || "").trim();
    const stripped = stripWindowsExtendedPathPrefix(textValue);
    const normalized = normalizeAbsolutePath(textValue);
    const extended = toWindowsExtendedPath(normalized.replaceAll("/", "\\"));
    const variants = [
      textValue,
      stripped,
      normalized,
      normalized.replaceAll("\\", "/"),
      normalized.replaceAll("/", "\\"),
      extended,
      legacyDriveRootPath(textValue),
      wslMountPath(textValue),
    ];
    if (isAbsolutePathLike(normalized) && resolve(stripWindowsExtendedPathPrefix(normalized)) !== parse(resolve(stripWindowsExtendedPathPrefix(normalized))).root) {
      variants.push(`${normalized}${sep}`, `${normalized}/`, `${normalized}\\`);
      if (extended) variants.push(`${extended}${sep}`, `${extended}\\`);
    }
    return [...new Set(variants.filter(isAbsolutePathLike))];
  }

  return { normalizeAbsolutePath, pathCompareKey, pathMatchVariants };
}
