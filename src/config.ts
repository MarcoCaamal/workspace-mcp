import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_MAX_RUNTIME_MS, MIN_MAX_RUNTIME_MS } from "./jobs.js";
import {
  DEFAULT_SHELL_ALLOW,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  type ShellConfig,
  type ShellMode,
} from "./shell.js";
import { parseWorkspaceFlags, WORKSPACE_NAME_PATTERN, type WorkspaceConfig } from "./workspaces.js";

/** File name probed in the process cwd before the global config location. */
export const CONFIG_FILE_NAME = "workspace-mcp.config.json";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3333;

/**
 * Global config location: `$XDG_CONFIG_HOME/workspace-mcp/config.json`, or
 * `~/.config/workspace-mcp/config.json` when `XDG_CONFIG_HOME` is unset.
 */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim();
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(home !== undefined && home !== "" ? home : homedir(), ".config");
  return path.join(base, "workspace-mcp", "config.json");
}

/** Raised for unreadable or invalid config files. Messages are client-safe. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Shell settings read from the config file (all optional). */
export interface ShellFileSettings {
  mode?: ShellMode;
  allow?: string[];
  deny?: string[];
  timeoutMs?: number;
  maxRuntimeMs?: number;
}

/** Transport settings read from the config file (all optional). */
export interface TransportFileSettings {
  type?: "stdio" | "http";
  host?: string;
  port?: number;
}

/** State settings read from the config file (all optional). */
export interface StateFileSettings {
  journalMaxBytes?: number;
}

/** ChatGPT guided-entry settings read from the config file (all optional). */
export interface ChatgptFileSettings {
  /** `false` disables the guided first-run preset; explicit selection still works. */
  preset?: boolean;
  /** Workspace name the guided entry binds to; must name a configured workspace. */
  primary?: string;
}

/** Harness session-store settings read from the config file (all optional). */
export interface HarnessFileSettings {
  /** `true` registers the session/work/stage tools backed by the outside-repo store. */
  session?: boolean;
  /** `true` enables the scoped recall extension (Slice 3); inert until recall ships. */
  recall?: boolean;
  /** Explicit database file path; `WORKSPACE_MCP_HARNESS_DB` wins when set. */
  dbPath?: string;
}

/** Validated config file contents. Workspace paths are absolute and real. */
export interface ConfigFileData {
  workspaces: WorkspaceConfig[];
  shell: ShellFileSettings;
  transport: TransportFileSettings;
  state: StateFileSettings;
  chatgpt: ChatgptFileSettings;
  harness: HarnessFileSettings;
}

/** A config file that was read from disk. */
export interface LoadedConfig extends ConfigFileData {
  /** Absolute path of the loaded file. */
  path: string;
  /** True when the path came from `--config` instead of discovery. */
  explicit: boolean;
}

/** Fully merged runtime configuration: CLI > env > config file > defaults. */
export interface ResolvedConfig {
  workspaces: WorkspaceConfig[];
  /** Name of the primary workspace: `default` when present, else the first one. */
  defaultWorkspace: string;
  shell: ShellConfig;
  transport: { http: boolean; host: string; port: number };
  state: { journalMaxBytes: number | undefined };
  /**
   * Guided ChatGPT entry binding. `preset` is true unless the file disables
   * it; `primary` is the bound workspace name, or undefined when the preset
   * is off (explicit workspace selection keeps working).
   */
  chatgpt: { preset: boolean; primary: string | undefined };
  /**
   * Harness session-store binding. Both flags default off; `dbPath` is the
   * explicit config/env override or the global `harness.db` default, so it
   * is always an absolute path.
   */
  harness: { session: boolean; recall: boolean; dbPath: string };
  /** Absolute path of the config file in use, when any. */
  configPath: string | undefined;
}

export interface MergeConfigInput {
  file: LoadedConfig | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Raw `--root` value. */
  root: string | undefined;
  /** Raw `--workspace` values. */
  workspaces: string[] | undefined;
  shell: { flag: boolean; any: boolean; allow: string[] | undefined };
  transport: { http: boolean; host: string | undefined; port: number | undefined };
}

const TOP_LEVEL_KEYS: readonly string[] = ["$schema", "workspaces", "shell", "transport", "state", "chatgpt", "harness"];
const SHELL_KEYS: readonly string[] = ["mode", "allow", "deny", "timeoutMs", "maxRuntimeMs"];
const TRANSPORT_KEYS: readonly string[] = ["type", "host", "port"];
const STATE_KEYS: readonly string[] = ["journalMaxBytes"];
const CHATGPT_KEYS: readonly string[] = ["preset", "primary"];
const HARNESS_KEYS: readonly string[] = ["session", "recall", "dbPath"];
const SHELL_MODES: readonly string[] = ["allowlist", "any"];

/** Reads and validates a config file. Throws {@link ConfigError} when unusable. */
export function loadConfigFile(filePath: string, options: { explicit?: boolean } = {}): LoadedConfig {
  const absolute = path.resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`config file not found: ${absolute}`);
    }
    throw new ConfigError(`cannot read config file ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `invalid JSON in config file ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const data = validateConfig(parsed, path.dirname(absolute));
  return { ...data, path: absolute, explicit: options.explicit === true };
}

/** Returns the first existing config file for `cwd`, or null. Never throws. */
export function discoverConfigFile(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const local = path.resolve(cwd, CONFIG_FILE_NAME);
  if (isFile(local)) {
    return local;
  }
  const global = globalConfigPath(env);
  return isFile(global) ? global : null;
}

/**
 * Config entry point for startup: `--config <path>` wins when given (and must
 * exist), otherwise the cwd file and then the global file are tried. A
 * discovered file that exists but is invalid is a startup error, not ignored.
 */
export function resolveConfigFile(options: {
  cwd: string;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
}): LoadedConfig | undefined {
  const env = options.env ?? process.env;
  if (options.explicitPath !== undefined) {
    return loadConfigFile(options.explicitPath, { explicit: true });
  }
  const discovered = discoverConfigFile(options.cwd, env);
  return discovered === null ? undefined : loadConfigFile(discovered);
}

/**
 * Validates raw JSON from a config file. Unknown keys anywhere are rejected so
 * typos fail loudly, and a `token` key is rejected outright: secrets never
 * belong in this file. `baseDir` resolves relative workspace paths (the
 * directory containing the config file).
 */
export function validateConfig(raw: unknown, baseDir: string = process.cwd()): ConfigFileData {
  if (!isPlainObject(raw)) {
    throw new ConfigError("config file must contain a single JSON object at the top level");
  }

  if (containsTokenKey(raw)) {
    throw new ConfigError("token must not be stored in the config file; use MCP_TOKEN or --token");
  }

  const unknown = collectUnknownKeys(raw);
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown config key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")} (remove them or check for typos)`,
    );
  }

  return {
    workspaces: parseWorkspaces(raw.workspaces, baseDir),
    shell: parseShell(raw.shell),
    transport: parseTransport(raw.transport),
    state: parseState(raw.state),
    chatgpt: parseChatgpt(raw.chatgpt),
    harness: parseHarness(raw.harness),
  };
}

/**
 * Merges a loaded file with CLI flags and environment variables. Pure: it
 * never reads the filesystem or mutates `env`. Precedence everywhere is
 * CLI > env > config file > built-in defaults.
 */
export function mergeConfig(input: MergeConfigInput): ResolvedConfig {
  const cliWorkspaces =
    input.root !== undefined || (input.workspaces?.length ?? 0) > 0
      ? parseWorkspaceFlags({ root: input.root, workspaces: input.workspaces, cwd: input.cwd })
      : [];
  const workspaces = mergeWorkspaces(input.file?.workspaces ?? [], cliWorkspaces, input.cwd);
  const defaultWorkspace = workspaces.find((workspace) => workspace.name === "default")?.name ?? workspaces[0]!.name;

  return {
    workspaces,
    defaultWorkspace,
    shell: resolveShellConfig(input.file?.shell ?? {}, input.shell, input.env),
    transport: resolveTransportConfig(input.file?.transport ?? {}, input.transport),
    state: { journalMaxBytes: input.file?.state.journalMaxBytes },
    chatgpt: resolveChatgptEntry(input.file?.chatgpt, workspaces, defaultWorkspace),
    harness: resolveHarnessConfig(input.file?.harness, input.env),
    configPath: input.file?.path,
  };
}

/**
 * Config entries first, then CLI entries override same-name entries in place
 * or append new ones, so a CLI workspace can add to the file's set without
 * retyping it. With nothing configured, the cwd is the single `default`.
 */
export function mergeWorkspaces(
  fileWorkspaces: readonly WorkspaceConfig[],
  cliWorkspaces: readonly WorkspaceConfig[],
  cwd: string,
): WorkspaceConfig[] {
  const merged = fileWorkspaces.map((workspace) => ({ ...workspace }));
  for (const cli of cliWorkspaces) {
    const index = merged.findIndex((workspace) => workspace.name === cli.name);
    if (index >= 0) {
      merged[index] = { ...cli };
    } else {
      merged.push({ ...cli });
    }
  }
  if (merged.length === 0) {
    merged.push({ name: "default", path: path.resolve(cwd) });
  }
  return merged;
}

/**
 * Shell precedence: CLI flags > env > config file > `"allowlist"`. The tool is
 * enabled by any CLI flag, `WORKSPACE_MCP_SHELL=1`, or config `shell.mode`.
 * `allow` is the union of the built-in defaults, config, env and CLI (all
 * reduced to basenames); `deny` only comes from config and env, and always
 * wins because no flag can remove a restriction.
 */
export function resolveShellConfig(
  fileShell: ShellFileSettings,
  cli: { flag: boolean; any: boolean; allow: string[] | undefined },
  env: NodeJS.ProcessEnv,
): ShellConfig {
  const envModeRaw = env.WORKSPACE_MCP_SHELL_MODE;
  let envMode: ShellMode | undefined;
  if (envModeRaw === "any" || envModeRaw === "allowlist") {
    envMode = envModeRaw;
  } else if (envModeRaw !== undefined) {
    throw new Error(`invalid WORKSPACE_MCP_SHELL_MODE: ${envModeRaw} (expected "allowlist" or "any")`);
  }

  const cliMode: ShellMode | undefined = cli.any ? "any" : cli.flag ? "allowlist" : undefined;
  const envEnabled = env.WORKSPACE_MCP_SHELL === "1";

  const allow: string[] = [...DEFAULT_SHELL_ALLOW];
  const addAll = (names: readonly string[]): void => {
    for (const name of names) {
      if (!allow.includes(name)) {
        allow.push(name);
      }
    }
  };
  addAll(normalizeExecutableNames(fileShell.allow ?? []));
  addAll(normalizeExecutableNames([env.WORKSPACE_MCP_SHELL_ALLOW ?? ""]));
  addAll(normalizeExecutableNames(cli.allow ?? []));

  const deny: string[] = [];
  for (const name of [
    ...normalizeExecutableNames(fileShell.deny ?? []),
    ...normalizeExecutableNames([env.WORKSPACE_MCP_SHELL_DENY ?? ""]),
  ]) {
    if (!deny.includes(name)) {
      deny.push(name);
    }
  }

  return {
    enabled: cliMode !== undefined || envMode !== undefined || envEnabled || fileShell.mode !== undefined,
    mode: cliMode ?? envMode ?? fileShell.mode ?? "allowlist",
    allow,
    deny,
    timeoutMs: fileShell.timeoutMs,
    maxRuntimeMs: fileShell.maxRuntimeMs,
  };
}

/** Transport precedence: CLI flags > config file > stdio/127.0.0.1/3333. */
export function resolveTransportConfig(
  fileTransport: TransportFileSettings,
  cli: { http: boolean; host: string | undefined; port: number | undefined },
): { http: boolean; host: string; port: number } {
  return {
    http: cli.http || fileTransport.type === "http",
    host: cli.host ?? fileTransport.host ?? DEFAULT_HOST,
    port: cli.port ?? fileTransport.port ?? DEFAULT_PORT,
  };
}

/**
 * Applies config `state.journalMaxBytes` as the default for
 * `WORKSPACE_MCP_JOURNAL_MAX_BYTES`: set only when the env var is unset, so an
 * explicit environment value always wins. Mutates `env` deliberately.
 */
export function applyStateDefaults(state: { journalMaxBytes: number | undefined }, env: NodeJS.ProcessEnv): void {
  const current = env.WORKSPACE_MCP_JOURNAL_MAX_BYTES;
  if (state.journalMaxBytes !== undefined && (current === undefined || current.trim() === "")) {
    env.WORKSPACE_MCP_JOURNAL_MAX_BYTES = String(state.journalMaxBytes);
  }
}

/** Splits comma-separated and repeated values into deduplicated basenames. */
export function normalizeExecutableNames(rawValues: readonly string[]): string[] {
  const names: string[] = [];
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const name = path.basename(part.trim());
      if (name === "" || name === "." || name === "..") {
        continue;
      }
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

function parseWorkspaces(value: unknown, baseDir: string): WorkspaceConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "workspaces" must be an object mapping workspace names to paths');
  }
  const workspaces: WorkspaceConfig[] = [];
  for (const [name, rawPath] of Object.entries(value)) {
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `invalid workspace name "${name}" in config file: names must match ${WORKSPACE_NAME_PATTERN.source}`,
      );
    }
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw new ConfigError(`workspace "${name}" must have a non-empty string path in the config file`);
    }
    workspaces.push({ name, path: resolveConfiguredWorkspace(name, rawPath, baseDir) });
  }
  return workspaces;
}

function resolveConfiguredWorkspace(name: string, rawPath: string, baseDir: string): string {
  const absolute = path.resolve(baseDir, rawPath);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw new ConfigError(`workspace "${name}" root does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`workspace "${name}" root is not a directory: ${absolute}`);
  }
  return realpathSync(absolute);
}

function parseShell(value: unknown): ShellFileSettings {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "shell" must be an object');
  }
  const shell: ShellFileSettings = {};
  if (value.mode !== undefined) {
    if (typeof value.mode !== "string" || !SHELL_MODES.includes(value.mode)) {
      throw new ConfigError(`invalid shell.mode: ${JSON.stringify(value.mode)} (expected "allowlist" or "any")`);
    }
    shell.mode = value.mode as ShellMode;
  }
  if (value.allow !== undefined) {
    shell.allow = parseExecutableList(value.allow, "shell.allow");
  }
  if (value.deny !== undefined) {
    shell.deny = parseExecutableList(value.deny, "shell.deny");
  }
  if (value.timeoutMs !== undefined) {
    shell.timeoutMs = parseIntegerInRange(value.timeoutMs, "shell.timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  }
  if (value.maxRuntimeMs !== undefined) {
    shell.maxRuntimeMs = parseIntegerInRange(
      value.maxRuntimeMs,
      "shell.maxRuntimeMs",
      MIN_MAX_RUNTIME_MS,
      MAX_MAX_RUNTIME_MS,
    );
  }
  return shell;
}

function parseExecutableList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`config key "${key}" must be an array of executable names`);
  }
  const names: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigError(`config key "${key}[${index}]" must be a non-empty string`);
    }
    const name = path.basename(item.trim());
    if (name === "" || name === "." || name === "..") {
      return;
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  });
  return names;
}

function parseTransport(value: unknown): TransportFileSettings {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "transport" must be an object');
  }
  const transport: TransportFileSettings = {};
  if (value.type !== undefined) {
    if (value.type !== "stdio" && value.type !== "http") {
      throw new ConfigError(`invalid transport.type: ${JSON.stringify(value.type)} (expected "stdio" or "http")`);
    }
    transport.type = value.type;
  }
  if (value.host !== undefined) {
    if (typeof value.host !== "string" || value.host.trim() === "") {
      throw new ConfigError("invalid transport.host: expected a non-empty string");
    }
    transport.host = value.host;
  }
  if (value.port !== undefined) {
    transport.port = parseIntegerInRange(value.port, "transport.port", 1, 65535);
  }
  return transport;
}

function parseState(value: unknown): StateFileSettings {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "state" must be an object');
  }
  const state: StateFileSettings = {};
  if (value.journalMaxBytes !== undefined) {
    state.journalMaxBytes = parseIntegerInRange(value.journalMaxBytes, "state.journalMaxBytes", 1, Number.MAX_SAFE_INTEGER);
  }
  return state;
}

function parseHarness(value: unknown): HarnessFileSettings {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "harness" must be an object');
  }
  const harness: HarnessFileSettings = {};
  if (value.session !== undefined) {
    if (typeof value.session !== "boolean") {
      throw new ConfigError(`invalid harness.session: ${JSON.stringify(value.session)} (expected a boolean)`);
    }
    harness.session = value.session;
  }
  if (value.recall !== undefined) {
    if (typeof value.recall !== "boolean") {
      throw new ConfigError(`invalid harness.recall: ${JSON.stringify(value.recall)} (expected a boolean)`);
    }
    harness.recall = value.recall;
  }
  if (value.dbPath !== undefined) {
    if (typeof value.dbPath !== "string" || value.dbPath.trim() === "") {
      throw new ConfigError(`invalid harness.dbPath: ${JSON.stringify(value.dbPath)} (expected a non-empty path)`);
    }
    harness.dbPath = value.dbPath;
  }
  return harness;
}

function parseChatgpt(value: unknown): ChatgptFileSettings {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError('config key "chatgpt" must be an object');
  }
  const chatgpt: ChatgptFileSettings = {};
  if (value.preset !== undefined) {
    if (typeof value.preset !== "boolean") {
      throw new ConfigError(`invalid chatgpt.preset: ${JSON.stringify(value.preset)} (expected a boolean)`);
    }
    chatgpt.preset = value.preset;
  }
  if (value.primary !== undefined) {
    if (typeof value.primary !== "string" || value.primary.trim() === "") {
      throw new ConfigError(`invalid chatgpt.primary: ${JSON.stringify(value.primary)} (expected a workspace name)`);
    }
    chatgpt.primary = value.primary;
  }
  return chatgpt;
}

/**
 * Guided-entry precedence: config file > built-in defaults (preset on,
 * primary falls back to the default workspace). A configured primary MUST
 * name a workspace from the final merged list (file + CLI); anything else is
 * a startup error that names the value instead of guessing. Disabling the
 * preset leaves multi-workspace selection untouched.
 */
function resolveChatgptEntry(
  file: ChatgptFileSettings | undefined,
  workspaces: readonly WorkspaceConfig[],
  defaultWorkspace: string,
): { preset: boolean; primary: string | undefined } {
  if (file?.preset === false) {
    return { preset: false, primary: undefined };
  }
  const primary = file?.primary ?? defaultWorkspace;
  if (!workspaces.some((workspace) => workspace.name === primary)) {
    const available = workspaces.map((workspace) => workspace.name).join(", ");
    throw new ConfigError(
      `invalid chatgpt.primary "${file?.primary}": unknown workspace (available: ${available}). ` +
        `Pick a configured workspace or disable guided entry with { "chatgpt": { "preset": false } }.`,
    );
  }
  return { preset: true, primary };
}

/**
 * Default harness database path: `$XDG_CONFIG_HOME/workspace-mcp/harness.db`,
 * or `~/.config/workspace-mcp/harness.db` when `XDG_CONFIG_HOME` is unset.
 * The store validator rejects any path inside a Git repository at open, so
 * this global location keeps harness state outside all repos by default.
 */
export function defaultHarnessDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim();
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(home !== undefined && home !== "" ? home : homedir(), ".config");
  return path.join(base, "workspace-mcp", "harness.db");
}

/**
 * Harness database path precedence: `WORKSPACE_MCP_HARNESS_DB` (when
 * non-blank) > config-file `harness.dbPath` > global `harness.db` default.
 * Pure: it never touches the filesystem.
 */
export function resolveHarnessDbPath(
  fileDbPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.WORKSPACE_MCP_HARNESS_DB?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  return fileDbPath ?? defaultHarnessDbPath(env);
}

/**
 * Harness precedence: env/file/defaults with both flags defaulting off, so
 * disabling `harness.session` restores the pre-harness tool surface. There
 * is no CLI flag for the harness: explicit configuration or the environment
 * override is the only way to enable it.
 */
export function resolveHarnessConfig(
  file: HarnessFileSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { session: boolean; recall: boolean; dbPath: string } {
  return {
    session: file?.session ?? false,
    recall: file?.recall ?? false,
    dbPath: resolveHarnessDbPath(file?.dbPath, env),
  };
}

function parseIntegerInRange(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`invalid ${key}: ${JSON.stringify(value)} (expected an integer between ${min} and ${max})`);
  }
  return value;
}

function collectUnknownKeys(raw: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  collectInto(raw, TOP_LEVEL_KEYS, "", unknown);
  for (const [section, allowed] of [
    ["shell", SHELL_KEYS],
    ["transport", TRANSPORT_KEYS],
    ["state", STATE_KEYS],
    ["chatgpt", CHATGPT_KEYS],
    ["harness", HARNESS_KEYS],
  ] as const) {
    const value = raw[section];
    if (isPlainObject(value)) {
      collectInto(value, allowed, section, unknown);
    }
  }
  return unknown;
}

function collectInto(record: Record<string, unknown>, allowed: readonly string[], prefix: string, out: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      out.push(prefix === "" ? key : `${prefix}.${key}`);
    }
  }
}

function containsTokenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsTokenKey);
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "token" || containsTokenKey(child)) {
        return true;
      }
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
