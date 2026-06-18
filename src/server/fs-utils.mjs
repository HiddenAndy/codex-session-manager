import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function createPathNormalizer(expandHomePath) {
  function normalizeAbsolutePath(value) {
    const textValue = expandHomePath(value);
    if (!String(textValue || "").startsWith("/")) return String(textValue || "").trim();
    return resolve(textValue);
  }

  function pathMatchVariants(value) {
    const textValue = String(value || "").trim();
    const normalized = normalizeAbsolutePath(textValue);
    const variants = [textValue, normalized];
    if (normalized && normalized !== "/") variants.push(`${normalized}/`);
    return [...new Set(variants.filter((item) => item.startsWith("/")))];
  }

  return { normalizeAbsolutePath, pathMatchVariants };
}
