import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyStateDefaults,
  ConfigError,
  CONFIG_FILE_NAME,
  defaultHarnessDbPath,
  defaultSkillsDir,
  discoverConfigFile,
  globalConfigPath,
  loadConfigFile,
  mergeConfig,
  resolveConfigFile,
  resolveShellConfig,
  resolveTransportConfig,
  validateConfig,
  type LoadedConfig,
  type MergeConfigInput,
} from "../src/config.js";
import { getJob, killJob, shutdownJobs } from "../src/jobs.js";
import { createServer } from "../src/server.js";
import { DEFAULT_SHELL_ALLOW, executableRejection, type ShellConfig } from "../src/shell.js";
import { WorkspaceError, type WorkspaceConfig } from "../src/workspaces.js";

interface ToolResponse {
  text: string;
  isError: boolean;
}

interface Session {
  client: Client;
  server: McpServer;
}

async function connect(options: { shell?: ShellConfig; workspaces: WorkspaceConfig[]; defaultWorkspace?: string }): Promise<Session> {
  const server = createServer({ workspaces: options.workspaces, defaultWorkspace: options.defaultWorkspace, version: "test", shell: options.shell });
  const client = new Client({ name: "workspace-mcp-config-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(session: Session): Promise<void> {
  await session.client.close().catch(() => undefined);
  await session.server.close().catch(() => undefined);
}

async function callTool(session: Session, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const result = await session.client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return { text, isError: result.isError === true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeConfig(dir: string, value: unknown): Promise<string> {
  const file = path.join(dir, CONFIG_FILE_NAME);
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

function makeLoaded(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    workspaces: [],
    shell: {},
    transport: {},
    state: {},
    chatgpt: {},
    harness: {},
    path: "/tmp/workspace-mcp.config.json",
    explicit: false,
    ...overrides,
  };
}

function mergeWith(file: LoadedConfig | undefined, overrides: Partial<MergeConfigInput> = {}): ReturnType<typeof mergeConfig> {
  return mergeConfig({
    file,
    cwd: "/cwd",
    env: {},
    root: undefined,
    workspaces: undefined,
    shell: { flag: false, any: false, allow: undefined },
    transport: { http: false, host: undefined, port: undefined },
    ...overrides,
  });
}

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-mcp-config-")));
});

afterAll(async () => {
  await shutdownJobs().catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

describe("tunnel command encoding", () => {
  it("preserves ordinary arguments and escapes paths without invoking tunnel-client", async () => {
    const script = await readFile(path.join(process.cwd(), "scripts/tunnel.sh"), "utf8");
    const setup = script.split('if [[ -n "$NAME"')[0]
      ?.replace('SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"', 'SCRIPT_DIR=""');
    expect(setup).toContain("# Exact mcp-command for this configuration");

    const run = (node: string, server: string, root: string, workspace: string, config: string): string[] => {
      return execFileSync("bash", ["-c", `${setup}\nprintf '%s\n' "$MCP_CMD" "$PROFILE_CMD"`,
        "tunnel-command-test", "--root", root, "--workspace", workspace, "--config", config], {
        encoding: "utf8",
        env: { ...process.env, WORKSPACE_MCP_NODE: node, WORKSPACE_MCP_SERVER: server },
      }).trimEnd().split("\n");
    };

    const plain = "/srv/workspace";
    const ordinary = `/usr/bin/node /app/index.js --root ${plain} --workspace api=${plain} --config /app/config.json`;
    expect(run("/usr/bin/node", "/app/index.js", plain, `api=${plain}`, "/app/config.json")).toEqual([ordinary, ordinary]);

    const apostropheCommand = `"/tools/o'brien/node" "/app/o'brien/index.js" --root "/work/o'brien" --workspace "api=/work/o'brien" --config "/work/o'brien.json"`;
    const apostropheProfile = apostropheCommand.replaceAll('"', '\\"');
    expect(run("/tools/o'brien/node", "/app/o'brien/index.js", "/work/o'brien", "api=/work/o'brien", "/work/o'brien.json"))
      .toEqual([apostropheCommand, apostropheProfile]);

    const node = '/my tools/node\\build';
    const server = '/app/"server".js';
    const root = '/work/a b\\c';
    const workspace = 'api=/work/"team"\\repo';
    const config = '/work/config "prod"\\$(not-executed).json';
    const command = `${JSON.stringify(node)} ${JSON.stringify(server)} --root ${JSON.stringify(root)} --workspace ${JSON.stringify(workspace)} --config ${JSON.stringify(config)}`;
    const profile = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    expect(run(node, server, root, workspace, config)).toEqual([command, profile]);
  });
});

describe("config file discovery", () => {
  it("finds workspace-mcp.config.json in the cwd before the global path", async () => {
    const cwd = path.join(base, "discovery-local");
    await mkdir(cwd, { recursive: true });
    const local = await writeConfig(cwd, {});
    const globalBase = path.join(base, "discovery-global");
    const globalFile = globalConfigPath({ XDG_CONFIG_HOME: globalBase });

    expect(discoverConfigFile(cwd, { XDG_CONFIG_HOME: globalBase })).toBe(local);
    expect(globalFile.endsWith(path.join("workspace-mcp", "config.json"))).toBe(true);
  });

  it("falls back to $XDG_CONFIG_HOME/workspace-mcp/config.json", async () => {
    const cwd = path.join(base, "discovery-xdg-cwd");
    await mkdir(cwd, { recursive: true });
    const xdg = path.join(base, "discovery-xdg");
    const globalDir = path.join(xdg, "workspace-mcp");
    await mkdir(globalDir, { recursive: true });
    await writeFile(path.join(globalDir, "config.json"), "{}", "utf8");

    expect(discoverConfigFile(cwd, { XDG_CONFIG_HOME: xdg })).toBe(path.join(globalDir, "config.json"));
  });

  it("respects HOME when XDG_CONFIG_HOME is unset", async () => {
    const cwd = path.join(base, "discovery-home-cwd");
    await mkdir(cwd, { recursive: true });
    const home = path.join(base, "discovery-home");
    const globalDir = path.join(home, ".config", "workspace-mcp");
    await mkdir(globalDir, { recursive: true });
    await writeFile(path.join(globalDir, "config.json"), "{}", "utf8");

    const env = { HOME: home };
    expect(globalConfigPath(env)).toBe(path.join(globalDir, "config.json"));
    expect(discoverConfigFile(cwd, env)).toBe(path.join(globalDir, "config.json"));
  });

  it("returns null when neither location has a file", async () => {
    const cwd = path.join(base, "discovery-none");
    await mkdir(cwd, { recursive: true });
    expect(discoverConfigFile(cwd, { XDG_CONFIG_HOME: path.join(base, "discovery-none-xdg") })).toBeNull();
  });

  it("lets an explicit --config path win over discovery", async () => {
    const cwd = path.join(base, "discovery-explicit");
    await mkdir(cwd, { recursive: true });
    await writeConfig(cwd, {});
    const explicitDir = path.join(base, "discovery-explicit-other");
    await mkdir(explicitDir, { recursive: true });
    const explicit = await writeConfig(explicitDir, {
      transport: { port: 4444 },
    });

    const loaded = resolveConfigFile({ cwd, explicitPath: explicit, env: {} });
    expect(loaded?.path).toBe(explicit);
    expect(loaded?.explicit).toBe(true);
    expect(loaded?.transport.port).toBe(4444);
  });

  it("marks a discovered file as non-explicit", async () => {
    const cwd = path.join(base, "discovery-non-explicit");
    await mkdir(cwd, { recursive: true });
    const local = await writeConfig(cwd, {});

    const loaded = resolveConfigFile({ cwd, env: {} });
    expect(loaded?.path).toBe(local);
    expect(loaded?.explicit).toBe(false);
  });
});

describe("config file validation", () => {
  it("rejects invalid JSON with the file path in the message", async () => {
    const dir = path.join(base, "invalid-json");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, '{ "workspaces": ', "utf8");

    expect(() => loadConfigFile(file)).toThrow(ConfigError);
    expect(() => loadConfigFile(file)).toThrow(/invalid JSON in config file/);
    expect(() => loadConfigFile(file)).toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reports a missing explicit file", () => {
    const missing = path.join(base, "nope", CONFIG_FILE_NAME);
    expect(() => loadConfigFile(missing, { explicit: true })).toThrow(/config file not found/);
  });

  it("rejects a non-object top level", () => {
    expect(() => validateConfig([])).toThrow(/single JSON object/);
    expect(() => validateConfig("nope")).toThrow(/single JSON object/);
  });

  it("rejects unknown top-level keys by name", () => {
    expect(() => validateConfig({ wrokspaces: {} })).toThrow(/unknown config key: wrokspaces/);
    expect(() => validateConfig({ nope: 1, other: 2 })).toThrow(/unknown config keys: nope, other/);
  });

  it("rejects unknown nested keys with their dotted path", () => {
    expect(() => validateConfig({ transport: { prot: 3333 } })).toThrow(/transport\.prot/);
    expect(() => validateConfig({ shell: { alow: [] } })).toThrow(/shell\.alow/);
    expect(() => validateConfig({ state: { journalBytes: 1 } })).toThrow(/state\.journalBytes/);
  });

  it("rejects a token key anywhere with the explicit secret message", () => {
    const message = "token must not be stored in the config file; use MCP_TOKEN or --token";
    expect(() => validateConfig({ token: "abc" })).toThrow(message);
    expect(() => validateConfig({ shell: { token: "abc" } })).toThrow(message);
    expect(() => validateConfig({ workspaces: { token: "/tmp" } })).toThrow(message);
  });

  it("accepts and ignores $schema", () => {
    expect(validateConfig({ $schema: "https://example.com/schema.json" }).workspaces).toEqual([]);
  });

  it("validates shell.mode", () => {
    expect(() => validateConfig({ shell: { mode: "nope" } })).toThrow(/invalid shell\.mode/);
    expect(() => validateConfig({ shell: { mode: 1 } })).toThrow(/invalid shell\.mode/);
    expect(validateConfig({ shell: { mode: "any" } }).shell.mode).toBe("any");
  });

  it("validates shell.allow and shell.deny shape", () => {
    expect(() => validateConfig({ shell: { allow: "git" } })).toThrow(/must be an array/);
    expect(() => validateConfig({ shell: { allow: [1] } })).toThrow(/shell\.allow\[0\]/);
    expect(() => validateConfig({ shell: { deny: [""] } })).toThrow(/shell\.deny\[0\]/);
    expect(validateConfig({ shell: { deny: ["/usr/bin/docker", "docker"] } }).shell.deny).toEqual(["docker"]);
  });

  it("validates shell timeouts against the documented ranges", () => {
    expect(() => validateConfig({ shell: { timeoutMs: 999 } })).toThrow(/invalid shell\.timeoutMs/);
    expect(() => validateConfig({ shell: { timeoutMs: 600001 } })).toThrow(/invalid shell\.timeoutMs/);
    expect(() => validateConfig({ shell: { timeoutMs: 1.5 } })).toThrow(/invalid shell\.timeoutMs/);
    expect(() => validateConfig({ shell: { maxRuntimeMs: 999 } })).toThrow(/invalid shell\.maxRuntimeMs/);
    expect(() => validateConfig({ shell: { maxRuntimeMs: 7200001 } })).toThrow(/invalid shell\.maxRuntimeMs/);
    expect(validateConfig({ shell: { timeoutMs: 1000, maxRuntimeMs: 7200000 } }).shell).toEqual({
      timeoutMs: 1000,
      maxRuntimeMs: 7200000,
    });
  });

  it("validates transport fields", () => {
    expect(() => validateConfig({ transport: { type: "smtp" } })).toThrow(/invalid transport\.type/);
    expect(() => validateConfig({ transport: { host: "" } })).toThrow(/invalid transport\.host/);
    expect(() => validateConfig({ transport: { host: 1 } })).toThrow(/invalid transport\.host/);
    expect(() => validateConfig({ transport: { port: 0 } })).toThrow(/invalid transport\.port/);
    expect(() => validateConfig({ transport: { port: 65536 } })).toThrow(/invalid transport\.port/);
    expect(() => validateConfig({ transport: { port: 1.5 } })).toThrow(/invalid transport\.port/);
    expect(validateConfig({ transport: { type: "http", host: "0.0.0.0", port: 4444 } }).transport).toEqual({
      type: "http",
      host: "0.0.0.0",
      port: 4444,
    });
  });

  it("validates state.journalMaxBytes as a positive integer", () => {
    expect(() => validateConfig({ state: { journalMaxBytes: 0 } })).toThrow(/invalid state\.journalMaxBytes/);
    expect(() => validateConfig({ state: { journalMaxBytes: -5 } })).toThrow(/invalid state\.journalMaxBytes/);
    expect(() => validateConfig({ state: { journalMaxBytes: 1.5 } })).toThrow(/invalid state\.journalMaxBytes/);
    expect(validateConfig({ state: { journalMaxBytes: 10485760 } }).state.journalMaxBytes).toBe(10485760);
  });

  it("rejects invalid workspace names", () => {
    expect(() => validateConfig({ workspaces: { Bad: "/tmp" } })).toThrow(/invalid workspace name "Bad"/);
    expect(() => validateConfig({ workspaces: { "-lead": "/tmp" } })).toThrow(/invalid workspace name/);
  });

  it("rejects non-existent and non-directory workspace roots, naming the workspace", async () => {
    const missing = path.join(base, "missing-root");
    expect(() => validateConfig({ workspaces: { api: missing } }, base)).toThrow(
      new RegExp(`workspace "api" root does not exist: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );

    const file = path.join(base, "not-a-dir.txt");
    await writeFile(file, "x", "utf8");
    expect(() => validateConfig({ workspaces: { api: file } }, base)).toThrow(/root is not a directory/);
  });

  it("rejects a non-string or empty workspace path", () => {
    expect(() => validateConfig({ workspaces: { api: 5 } })).toThrow(/workspace "api" must have a non-empty string path/);
    expect(() => validateConfig({ workspaces: { api: "  " } })).toThrow(/workspace "api" must have a non-empty string path/);
  });

  it("resolves workspace paths to absolute realpaths", async () => {
    const root = path.join(base, "valid-config", "api");
    await mkdir(root, { recursive: true });
    const data = validateConfig({ workspaces: { api: root } }, base);
    expect(data.workspaces).toEqual([{ name: "api", path: await realpath(root) }]);
  });
});

describe("workspace merge", () => {
  it("keeps config entries and adds/overrides from --workspace", async () => {
    const configA = path.join(base, "merge-conf-a");
    const configB = path.join(base, "merge-conf-b");
    const cliB = path.join(base, "merge-cli-b");
    const cliC = path.join(base, "merge-cli-c");
    await Promise.all([configA, configB, cliB, cliC].map((dir) => mkdir(dir, { recursive: true })));

    const file = makeLoaded({
      workspaces: [
        { name: "alpha", path: configA },
        { name: "beta", path: configB },
      ],
    });
    const resolved = mergeWith(file, { workspaces: [`beta=${cliB}`, `gamma=${cliC}`], cwd: base });

    expect(resolved.workspaces).toEqual([
      { name: "alpha", path: configA },
      { name: "beta", path: cliB },
      { name: "gamma", path: cliC },
    ]);
    expect(resolved.defaultWorkspace).toBe("alpha");
  });

  it("lets --root override a config workspace named default", async () => {
    const configDefault = path.join(base, "merge-default-config");
    const root = path.join(base, "merge-default-cli");
    await Promise.all([configDefault, root].map((dir) => mkdir(dir, { recursive: true })));

    const file = makeLoaded({
      workspaces: [
        { name: "default", path: configDefault },
        { name: "api", path: configDefault },
      ],
    });
    const resolved = mergeWith(file, { root, cwd: base });

    expect(resolved.workspaces).toEqual([
      { name: "default", path: root },
      { name: "api", path: configDefault },
    ]);
    expect(resolved.defaultWorkspace).toBe("default");
  });

  it("selects default as primary when present, otherwise the first entry", () => {
    const withDefault = mergeWith(
      makeLoaded({
        workspaces: [
          { name: "api", path: "/w/api" },
          { name: "default", path: "/w/main" },
        ],
      }),
    );
    expect(withDefault.defaultWorkspace).toBe("default");

    const firstWhenAbsent = mergeWith(
      makeLoaded({
        workspaces: [
          { name: "api", path: "/w/api" },
          { name: "web", path: "/w/web" },
        ],
      }),
    );
    expect(firstWhenAbsent.defaultWorkspace).toBe("api");
  });

  it("falls back to the cwd as default when nothing is configured", () => {
    const resolved = mergeWith(undefined, { cwd: "/somewhere" });
    expect(resolved.workspaces).toEqual([{ name: "default", path: "/somewhere" }]);
    expect(resolved.defaultWorkspace).toBe("default");
  });

  it("still rejects duplicate workspace names inside the CLI flags", () => {
    expect(() => mergeWith(undefined, { workspaces: ["one=/a", "one=/b"], cwd: "/cwd" })).toThrow(
      /duplicate workspace name "one"/,
    );
    expect(() => mergeWith(undefined, { root: "/a", workspaces: ["default=/b"], cwd: "/cwd" })).toThrow(WorkspaceError);
  });
});

describe("shell precedence", () => {
  it("enables the tools with config shell.mode only", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist" } }));
    expect(resolved.shell.enabled).toBe(true);
    expect(resolved.shell.mode).toBe("allowlist");
  });

  it("does not enable the tools for config allow/deny without a mode", () => {
    const resolved = mergeWith(makeLoaded({ shell: { allow: ["git"], deny: ["docker"] } }));
    expect(resolved.shell.enabled).toBe(false);
  });

  it("CLI --shell-any beats config allowlist", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist" } }), {
      shell: { flag: false, any: true, allow: undefined },
    });
    expect(resolved.shell.enabled).toBe(true);
    expect(resolved.shell.mode).toBe("any");
  });

  it("env MODE=any beats config allowlist", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist" } }), { env: { WORKSPACE_MCP_SHELL_MODE: "any" } });
    expect(resolved.shell.enabled).toBe(true);
    expect(resolved.shell.mode).toBe("any");
  });

  it("CLI --shell beats env MODE=any", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "any" } }), {
      env: { WORKSPACE_MCP_SHELL_MODE: "any" },
      shell: { flag: true, any: false, allow: undefined },
    });
    expect(resolved.shell.mode).toBe("allowlist");
  });

  it("WORKSPACE_MCP_SHELL=1 enables with the config mode", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "any" } }), { env: { WORKSPACE_MCP_SHELL: "1" } });
    expect(resolved.shell.enabled).toBe(true);
    expect(resolved.shell.mode).toBe("any");
  });

  it("rejects an invalid WORKSPACE_MCP_SHELL_MODE", () => {
    expect(() => resolveShellConfig({}, { flag: false, any: false, allow: undefined }, { WORKSPACE_MCP_SHELL_MODE: "sometimes" })).toThrow(
      /invalid WORKSPACE_MCP_SHELL_MODE/,
    );
  });

  it("defaults to disabled allowlist with no config and no flags", () => {
    const resolved = mergeWith(undefined);
    expect(resolved.shell.enabled).toBe(false);
    expect(resolved.shell.mode).toBe("allowlist");
    expect(resolved.shell.allow).toEqual([...DEFAULT_SHELL_ALLOW]);
  });
});

describe("shell allow union and deny", () => {
  it("unions the built-in defaults with config, env and CLI allowlists", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist", allow: ["git"] } }), {
      env: { WORKSPACE_MCP_SHELL_ALLOW: "docker, git" },
      shell: { flag: true, any: false, allow: ["kubectl"] },
    });
    expect(resolved.shell.allow).toEqual([...DEFAULT_SHELL_ALLOW, "git", "docker", "kubectl"]);
  });

  it("deny wins over allow in allowlist mode and any mode", () => {
    const allowlist: ShellConfig = {
      enabled: true,
      mode: "allowlist",
      allow: [...DEFAULT_SHELL_ALLOW],
      deny: ["node"],
    };
    expect(executableRejection(allowlist, ["node", "-v"])).toBe("command denied by configuration: node");
    expect(executableRejection(allowlist, ["node_modules/.bin/node"])).toBe("command denied by configuration: node");

    const any: ShellConfig = { enabled: true, mode: "any", allow: [], deny: ["docker"] };
    expect(executableRejection(any, ["docker", "ps"])).toBe("command denied by configuration: docker");
    expect(executableRejection(any, ["git", "status"])).toBeUndefined();
  });

  it("cannot be un-denied by CLI flags or allow entries", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist", allow: ["node"], deny: ["node"] } }), {
      shell: { flag: false, any: true, allow: ["node"] },
    });
    expect(resolved.shell.deny).toEqual(["node"]);
    expect(executableRejection(resolved.shell, ["node", "-v"])).toBe("command denied by configuration: node");
  });

  it("reads deny from WORKSPACE_MCP_SHELL_DENY too, normalized to basenames", () => {
    const resolved = mergeWith(makeLoaded({ shell: { mode: "allowlist", deny: ["/usr/bin/docker"] } }), {
      env: { WORKSPACE_MCP_SHELL_DENY: "git, /opt/bin/foo" },
    });
    expect(resolved.shell.deny).toEqual(["docker", "git", "foo"]);
  });
});

describe("transport and state resolution", () => {
  it("uses config transport values as defaults", () => {
    const transport = resolveTransportConfig({ type: "http", host: "0.0.0.0", port: 4444 }, { http: false, host: undefined, port: undefined });
    expect(transport).toEqual({ http: true, host: "0.0.0.0", port: 4444 });
  });

  it("lets CLI flags override config transport values", () => {
    const transport = resolveTransportConfig({ type: "http", host: "0.0.0.0", port: 4444 }, { http: true, host: "127.0.0.1", port: 5555 });
    expect(transport).toEqual({ http: true, host: "127.0.0.1", port: 5555 });
  });

  it("keeps stdio defaults without config", () => {
    expect(resolveTransportConfig({}, { http: false, host: undefined, port: undefined })).toEqual({
      http: false,
      host: "127.0.0.1",
      port: 3333,
    });
  });

  it("applies journalMaxBytes only when the env var is unset", () => {
    const unset: NodeJS.ProcessEnv = {};
    applyStateDefaults({ journalMaxBytes: 10485760 }, unset);
    expect(unset.WORKSPACE_MCP_JOURNAL_MAX_BYTES).toBe("10485760");

    const empty: NodeJS.ProcessEnv = { WORKSPACE_MCP_JOURNAL_MAX_BYTES: "" };
    applyStateDefaults({ journalMaxBytes: 10485760 }, empty);
    expect(empty.WORKSPACE_MCP_JOURNAL_MAX_BYTES).toBe("10485760");

    const set: NodeJS.ProcessEnv = { WORKSPACE_MCP_JOURNAL_MAX_BYTES: "2048" };
    applyStateDefaults({ journalMaxBytes: 10485760 }, set);
    expect(set.WORKSPACE_MCP_JOURNAL_MAX_BYTES).toBe("2048");

    const noConfig: NodeJS.ProcessEnv = {};
    applyStateDefaults({ journalMaxBytes: undefined }, noConfig);
    expect(noConfig.WORKSPACE_MCP_JOURNAL_MAX_BYTES).toBeUndefined();
  });
});

describe("chatgpt entry profile defaults", () => {
  it("accepts a well-formed chatgpt section without touching workspaces", () => {
    const data = validateConfig({ chatgpt: { preset: false } });
    expect(data.chatgpt).toEqual({ preset: false });
    expect(data.workspaces).toEqual([]);
  });

  it("rejects unknown nested chatgpt keys with their dotted path", () => {
    expect(() => validateConfig({ chatgpt: { presets: true } })).toThrow(/chatgpt\.presets/);
  });

  it("rejects malformed chatgpt values", () => {
    expect(() => validateConfig({ chatgpt: "yes" })).toThrow(/config key "chatgpt" must be an object/);
    expect(() => validateConfig({ chatgpt: { preset: "yes" } })).toThrow(/invalid chatgpt\.preset/);
    expect(() => validateConfig({ chatgpt: { primary: 5 } })).toThrow(/invalid chatgpt\.primary/);
    expect(() => validateConfig({ chatgpt: { primary: "  " } })).toThrow(/invalid chatgpt\.primary/);
  });

  it("defaults the preset on with the default workspace as primary", () => {
    const resolved = mergeWith(makeLoaded({ workspaces: [{ name: "api", path: "/w/api" }] }));
    expect(resolved.chatgpt).toEqual({ preset: true, primary: "api" });
  });

  it("honors a configured primary workspace without disturbing selection", () => {
    const resolved = mergeWith(
      makeLoaded({
        workspaces: [
          { name: "api", path: "/w/api" },
          { name: "web", path: "/w/web" },
        ],
        chatgpt: { primary: "web" },
      }),
    );
    expect(resolved.chatgpt).toEqual({ preset: true, primary: "web" });
    expect(resolved.workspaces).toHaveLength(2);
    expect(resolved.defaultWorkspace).toBe("api");
  });

  it("rejects an unknown primary at startup without guessing", () => {
    expect(() =>
      mergeWith(makeLoaded({ workspaces: [{ name: "api", path: "/w/api" }], chatgpt: { primary: "nope" } })),
    ).toThrow(/invalid chatgpt\.primary "nope"/);
  });

  it("disables guided entry while keeping explicit selection working", () => {
    const resolved = mergeWith(
      makeLoaded({
        workspaces: [
          { name: "api", path: "/w/api" },
          { name: "web", path: "/w/web" },
        ],
        chatgpt: { preset: false },
      }),
    );
    expect(resolved.chatgpt).toEqual({ preset: false, primary: undefined });
    expect(resolved.workspaces).toHaveLength(2);
    expect(resolved.defaultWorkspace).toBe("api");
  });

  it("accepts a CLI-added workspace as the primary", async () => {
    const gamma = path.join(base, "chatgpt-cli-gamma");
    await mkdir(gamma, { recursive: true });
    const resolved = mergeWith(
      makeLoaded({ workspaces: [{ name: "alpha", path: base }], chatgpt: { primary: "gamma" } }),
      { workspaces: [`gamma=${gamma}`], cwd: base },
    );
    expect(resolved.chatgpt).toEqual({ preset: true, primary: "gamma" });
  });
});

describe("harness config defaults", () => {
  it("defaults the harness session and recall flags off with the global harness.db path", () => {
    const resolved = mergeWith(makeLoaded({ workspaces: [{ name: "api", path: "/w/api" }] }));
    expect(resolved.harness).toEqual({ session: false, recall: false, dbPath: defaultHarnessDbPath({}), skillsDir: defaultSkillsDir({}) });
  });

  it("accepts a well-formed harness section without touching workspaces", () => {
    const data = validateConfig({ harness: { session: true, recall: false, dbPath: "/tmp/harness.db" } });
    expect(data.harness).toEqual({ session: true, recall: false, dbPath: "/tmp/harness.db" });
    expect(data.workspaces).toEqual([]);
  });

  it("rejects unknown nested harness keys with their dotted path", () => {
    expect(() => validateConfig({ harness: { sessions: true } })).toThrow(/harness\.sessions/);
  });

  it("rejects malformed harness values", () => {
    expect(() => validateConfig({ harness: "yes" })).toThrow(/config key "harness" must be an object/);
    expect(() => validateConfig({ harness: { session: "yes" } })).toThrow(/invalid harness\.session/);
    expect(() => validateConfig({ harness: { recall: 5 } })).toThrow(/invalid harness\.recall/);
    expect(() => validateConfig({ harness: { dbPath: "" } })).toThrow(/invalid harness\.dbPath/);
    expect(() => validateConfig({ harness: { dbPath: 5 } })).toThrow(/invalid harness\.dbPath/);
  });

  it("lets WORKSPACE_MCP_HARNESS_DB override the file dbPath", () => {
    const resolved = mergeWith(makeLoaded({ harness: { session: true, dbPath: "/file/harness.db" } }), {
      env: { WORKSPACE_MCP_HARNESS_DB: "/env/harness.db" },
    });
    expect(resolved.harness).toEqual({ session: true, recall: false, dbPath: "/env/harness.db", skillsDir: defaultSkillsDir({}) });
  });

  it("ignores a blank WORKSPACE_MCP_HARNESS_DB and keeps the file value", () => {
    const resolved = mergeWith(makeLoaded({ harness: { session: true, dbPath: "/file/harness.db" } }), {
      env: { WORKSPACE_MCP_HARNESS_DB: "   " },
    });
    expect(resolved.harness.dbPath).toBe("/file/harness.db");
  });

  it("keeps harness enabled without disturbing workspace selection", () => {
    const resolved = mergeWith(
      makeLoaded({
        workspaces: [
          { name: "api", path: "/w/api" },
          { name: "web", path: "/w/web" },
        ],
        harness: { session: true },
      }),
    );
    expect(resolved.harness.session).toBe(true);
    expect(resolved.workspaces).toHaveLength(2);
    expect(resolved.defaultWorkspace).toBe("api");
  });

  it("resolves the default harness db path under the global config dir", () => {
    expect(defaultHarnessDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/workspace-mcp/harness.db");
    const fallback = defaultHarnessDbPath({});
    expect(path.isAbsolute(fallback)).toBe(true);
    expect(fallback.endsWith(path.join("workspace-mcp", "harness.db"))).toBe(true);
  });
});

describe("without a config file the server is unchanged", () => {
  it("still registers exactly nineteen tools when shell is off", async () => {
    const root = path.join(base, "no-config");
    await mkdir(root, { recursive: true });
    const session = await connect({ workspaces: [{ name: "default", path: root }] });
    try {
      const listed = await session.client.listTools();
      expect(listed.tools).toHaveLength(19);
    } finally {
      await close(session);
    }
  });
});

describe("configured shell defaults end to end", () => {
  let root: string;

  beforeAll(async () => {
    root = path.join(base, "shell-e2e");
    await mkdir(root, { recursive: true });
  });

  it("uses config timeoutMs when run_command omits the argument", async () => {
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW], timeoutMs: 1000 };
    const session = await connect({ shell, workspaces: [{ name: "default", path: root }] });
    try {
      const response = await callTool(session, "run_command", {
        command: ["node", "-e", "setTimeout(() => {}, 5000)"],
      });
      expect(response.isError).toBe(false);
      expect(response.text).toContain("timed out after 1000ms");
    } finally {
      await close(session);
    }
  });

  it("still lets a per-call timeoutMs override the configured default", async () => {
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW], timeoutMs: 1000 };
    const session = await connect({ shell, workspaces: [{ name: "default", path: root }] });
    try {
      const response = await callTool(session, "run_command", {
        command: ["node", "-e", "setTimeout(() => console.log('done'), 1500)"],
        timeoutMs: 5000,
      });
      expect(response.isError).toBe(false);
      expect(response.text).toContain("exit code: 0");
      expect(response.text).toContain("done");
    } finally {
      await close(session);
    }
  });

  it("applies config deny to run_command and start_job, even in any mode", async () => {
    const shell: ShellConfig = { enabled: true, mode: "any", allow: [], deny: ["node"] };
    const session = await connect({ shell, workspaces: [{ name: "default", path: root }] });
    try {
      const run = await callTool(session, "run_command", { command: ["node", "-v"] });
      expect(run.isError).toBe(true);
      expect(run.text).toBe("command denied by configuration: node");

      const job = await callTool(session, "start_job", { command: ["node", "-e", "console.log('hi')"] });
      expect(job.isError).toBe(true);
      expect(job.text).toBe("command denied by configuration: node");
    } finally {
      await close(session);
    }
  });

  it("uses config maxRuntimeMs as the start_job default", async () => {
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW], maxRuntimeMs: 1000 };
    const session = await connect({ shell, workspaces: [{ name: "default", path: root }] });
    try {
      const started = await callTool(session, "start_job", {
        command: ["node", "-e", "setTimeout(() => {}, 60000)"],
        name: "config default runtime",
      });
      expect(started.isError).toBe(false);
      expect(started.text).toContain("maxRuntimeMs: 1000");
      const jobId = started.text.match(/jobId: (\S+)/)?.[1];
      expect(jobId).toBeDefined();

      await sleep(300);
      if (jobId !== undefined) {
        await killJob(jobId);
        expect(getJob(jobId)?.status).toBe("killed");
      }
    } finally {
      await close(session);
    }
  });
});
