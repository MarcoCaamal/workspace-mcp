import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FileToolError } from "./files.js";

/**
 * Raised when a user-supplied path cannot be safely resolved inside the
 * workspace root. The message is safe to show to MCP clients.
 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** Resolves the workspace root to its real (symlink-free) absolute path. */
export async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(path.resolve(root));
  } catch {
    throw new WorkspacePathError(`workspace root does not exist: ${path.resolve(root)}`);
  }
}

/** True when `candidate` is the real workspace root or lives inside it. */
export function isInside(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(`${realRoot}${path.sep}`);
}

/**
 * Resolves a user-supplied path against the workspace root and guarantees the
 * final real path stays inside the root.
 *
 * Strategy:
 * 1. Reject empty paths and embedded NUL bytes.
 * 2. Resolve relative paths against the root; keep absolute paths as-is.
 * 3. Resolve symlinks with `fs.realpath` for the longest existing prefix of
 *    the target (the remainder may not exist yet, e.g. a new file).
 * 4. Reject anything that is not the root itself or inside it.
 *
 * Returns the real absolute path. Throws {@link WorkspacePathError} otherwise.
 */
export async function resolveSafe(root: string, userPath: string): Promise<string> {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new WorkspacePathError("path must be a non-empty string");
  }
  if (userPath.includes("\0")) {
    throw new WorkspacePathError("path contains a NUL byte");
  }

  const realRoot = await realRootOf(root);
  const candidate = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(realRoot, userPath);

  const resolved = await resolveExistingPrefix(candidate, userPath);
  if (!isInside(realRoot, resolved)) {
    throw new WorkspacePathError(`path outside workspace root: ${userPath}`);
  }
  return resolved;
}

/**
 * Resolves a user-supplied directory against the workspace root and verifies
 * that it exists and is a directory. Used by run_command and start_job for
 * their `cwd` argument so both enforce the same containment rule.
 */
export async function resolveSafeDirectory(root: string, userPath: string): Promise<string> {
  const resolved = await resolveSafe(root, userPath);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileToolError(`working directory not found: ${userPath}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new FileToolError(`not a directory: ${userPath}`);
  }
  return resolved;
}

/**
 * Realpaths the longest existing prefix of `candidate` and re-appends the
 * segments that do not exist yet, so that symlinked ancestors outside the root
 * are still detected.
 */
async function resolveExistingPrefix(candidate: string, userPath: string): Promise<string> {
  const missing: string[] = [];
  let current = candidate;

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        throw new WorkspacePathError(`invalid path (a path component is not a directory): ${userPath}`);
      }
      if (code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root without finding an existing ancestor.
      return candidate;
    }
    missing.push(path.basename(current));
    current = parent;
  }
}

/**
 * Converts an absolute path into a workspace-relative path with forward
 * slashes, so responses are stable across platforms.
 */
export function toWorkspacePath(root: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(root), absolutePath);
  if (relative === "") {
    return ".";
  }
  return relative.split(path.sep).join("/");
}
