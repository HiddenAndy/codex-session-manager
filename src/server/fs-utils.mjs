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
  return isAbsolute(stripWindowsExtendedPathPrefix(value));
}

export function stripWindowsExtendedPathPrefix(value) {
  const textValue = String(value || "").trim();
  if (textValue.startsWith("\\\\?\\UNC\\")) return `\\\\${textValue.slice("\\\\?\\UNC\\".length)}`;
  if (textValue.startsWith("//?/UNC/")) return `//${textValue.slice("//?/UNC/".length)}`;
  if (textValue.startsWith("\\\\?\\")) return textValue.slice("\\\\?\\".length);
  if (textValue.startsWith("//?/")) return textValue.slice("//?/".length);
  return textValue;
}

function toWindowsExtendedPath(value) {
  const textValue = String(value || "").trim();
  if (process.platform !== "win32" || !isAbsolute(textValue) || textValue.startsWith("\\\\?\\")) return "";
  if (textValue.startsWith("\\\\")) return `\\\\?\\UNC\\${textValue.slice(2)}`;
  return `\\\\?\\${textValue}`;
}

export function createPathNormalizer(expandHomePath) {
  function normalizeAbsolutePath(value) {
    const textValue = stripWindowsExtendedPathPrefix(expandHomePath(value));
    if (!isAbsolutePath(textValue)) return String(textValue || "").trim();
    return resolve(textValue);
  }

  function pathCompareKey(value) {
    const normalized = normalizeAbsolutePath(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  function pathMatchVariants(value) {
    const textValue = String(value || "").trim();
    const normalized = normalizeAbsolutePath(textValue);
    const extended = toWindowsExtendedPath(normalized);
    const variants = [textValue, stripWindowsExtendedPathPrefix(textValue), normalized, extended];
    if (isAbsolutePath(normalized) && resolve(normalized) !== parse(resolve(normalized)).root) {
      variants.push(`${normalized}${sep}`);
      if (extended) variants.push(`${extended}${sep}`);
    }
    return [...new Set(variants.filter(isAbsolutePath))];
  }

  return { normalizeAbsolutePath, pathCompareKey, pathMatchVariants };
}
