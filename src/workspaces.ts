import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** One workspace as configured on the command line, before any I/O. */
export interface WorkspaceConfig {
  name: string;
  path: string;
}

/** A registered workspace: name plus its realpath-resolved absolute root. */
export interface Workspace {
  name: string;
  root: string;
}

/** Allowed workspace names: lowercase letters, digits, hyphens and underscores. */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Raised for configuration and lookup problems. Messages are client-safe. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Pure CLI parser: turns `--root` and `--workspace` values into workspace
 * configs. Paths are made absolute against `cwd`; existence and realpath are
 * checked later when the registry is built, so this function never touches
 * the filesystem and stays unit-testable.
 */
export function parseWorkspaceFlags(opts: { root?: string; workspaces?: string[]; cwd: string }): WorkspaceConfig[] {
  const configs: WorkspaceConfig[] = [];
  const names = new Set<string>();

  const add = (name: string, rawPath: string, flag: string): void => {
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new WorkspaceError(
        `invalid workspace name "${name}" in ${flag}: names must match ${WORKSPACE_NAME_PATTERN.source}`,
      );
    }
    if (names.has(name)) {
      throw new WorkspaceError(`duplicate workspace name "${name}": workspace names must be unique`);
    }
    if (rawPath.trim() === "") {
      throw new WorkspaceError(`workspace "${name}" has an empty path`);
    }
    names.add(name);
    configs.push({ name, path: path.resolve(opts.cwd, rawPath) });
  };

  if (opts.root !== undefined) {
    add("default", opts.root, "--root");
  }
  for (const raw of opts.workspaces ?? []) {
    const separator = raw.indexOf("=");
    if (separator === -1) {
      throw new WorkspaceError(`invalid --workspace value "${raw}": expected <name>=<path>`);
    }
    add(raw.slice(0, separator), raw.slice(separator + 1), "--workspace");
  }

  if (configs.length === 0) {
    configs.push({ name: "default", path: path.resolve(opts.cwd) });
  }
  return configs;
}

/**
 * Registry of named workspaces. Roots are validated and realpath-resolved once
 * at construction; `resolve` maps an optional tool argument to one workspace so
 * every path and state operation runs against the selected root.
 */
export class WorkspaceRegistry {
  readonly primary: string;
  private readonly byName = new Map<string, Workspace>();
  private readonly ordered: Workspace[] = [];

  constructor(configs: readonly WorkspaceConfig[], defaultWorkspace?: string) {
    if (configs.length === 0) {
      throw new WorkspaceError("at least one workspace must be configured");
    }

    for (const config of configs) {
      if (this.byName.has(config.name)) {
        throw new WorkspaceError(`duplicate workspace name "${config.name}": workspace names must be unique`);
      }
      const workspace: Workspace = { name: config.name, root: resolveWorkspaceRoot(config.name, config.path) };
      this.byName.set(config.name, workspace);
      this.ordered.push(workspace);
    }

    this.primary = defaultWorkspace ?? this.ordered[0]!.name;
    if (!this.byName.has(this.primary)) {
      throw new WorkspaceError(
        `unknown default workspace "${this.primary}". Available: ${[...this.byName.keys()].join(", ")}`,
      );
    }
  }

  /** Resolves a workspace by name; an omitted name means the primary workspace. */
  resolve(name?: string): Workspace {
    const key = name ?? this.primary;
    const workspace = this.byName.get(key);
    if (workspace === undefined) {
      throw new WorkspaceError(`unknown workspace "${key}". Available: ${[...this.byName.keys()].join(", ")}`);
    }
    return workspace;
  }

  /** All workspaces in configuration order. */
  list(): readonly Workspace[] {
    return this.ordered;
  }
}

function resolveWorkspaceRoot(name: string, rawPath: string): string {
  const absolute = path.resolve(rawPath);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw new WorkspaceError(`workspace "${name}" root does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new WorkspaceError(`workspace "${name}" root is not a directory: ${absolute}`);
  }
  return realpathSync(absolute);
}
