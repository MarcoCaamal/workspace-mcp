#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  applyStateDefaults,
  CONFIG_FILE_NAME,
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  mergeConfig,
  resolveConfigFile,
  type ResolvedConfig,
} from "./config.js";
import { shutdownJobs } from "./jobs.js";
import { createServer, FALLBACK_VERSION, SERVER_NAME } from "./server.js";
import { formatMetricsHuman, formatMetricsJson } from "./harness-metrics.js";
import { openHarnessStore, type HarnessStore } from "./session-store.js";
import type { ShellConfig } from "./shell.js";
import type { WorkspaceConfig } from "./workspaces.js";

const MCP_ENDPOINT = "/mcp";

interface CliOptions {
  root: string | undefined;
  workspaces: string[] | undefined;
  http: boolean;
  host: string | undefined;
  port: number | undefined;
  token: string | undefined;
  shell: { flag: boolean; any: boolean; allow: string[] | undefined };
  harnessMetrics: boolean;
  format: string | undefined;
  config: string | undefined;
  help: boolean;
  version: boolean;
}

/** All diagnostics go to stderr: stdout is the MCP protocol stream over stdio. */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function printHelp(): void {
  process.stderr.write(
    [
      `${SERVER_NAME} - MCP server with workspace-scoped file tools`,
      "",
      "Usage:",
      `  ${SERVER_NAME} [options]`,
      "",
      "Options:",
      "  --root <dir>    Primary workspace root, registered as the workspace named 'default'.",
      "                  Defaults to the current working directory.",
      "  --workspace <name>=<path>  Register an additional named workspace. Repeatable.",
      "                  Names match ^[a-z0-9][a-z0-9_-]*$ and must be unique. With no --root,",
      "                  the first one is primary unless one is literally named 'default'.",
      "                  Every root is resolved to a real, existing absolute path at startup.",
      "  --config <path> Use an explicit JSON config file. Without it, ./" + CONFIG_FILE_NAME,
      "                  (cwd) is tried, then ~/.config/workspace-mcp/config.json",
      "                  (or $XDG_CONFIG_HOME/workspace-mcp/config.json).",
      "                  A config file that exists but is invalid aborts startup.",
      "  --http          Serve Streamable HTTP at /mcp instead of stdio.",
      `  --host <host>   HTTP bind host. Default: ${DEFAULT_HOST}.`,
      `  --port <port>   HTTP bind port. Default: ${DEFAULT_PORT}.`,
      "  --token <t>     Require 'Authorization: Bearer <t>' on every HTTP request (or set MCP_TOKEN).",
      "                  Tokens are NOT allowed in the config file.",
      "  --shell         Enable run_command and the background job tools in allowlist mode. Off by default.",
      "  --shell-any     Enable them in unrestricted mode (any executable). Implies --shell and prints a warning.",
      "  --shell-allow <list>  Add executables to the allowlist (comma-separated and/or repeated; only used when enabled).",
      "  --harness-metrics   Print the operator-local harness health snapshot and exit. Never an MCP tool.",
      "  --format <human|json>  Metrics output shape. Default: human. Only used with --harness-metrics.",
      "  -h, --help      Show this help.",
      "  -v, --version   Show the version.",
      "",
      "Config file: optional JSON that fills in defaults for workspaces, shell, transport and state.",
      "Precedence everywhere: CLI flags > environment variables > config file > built-in defaults.",
      "Unknown keys are rejected, and a 'token' key is refused (use MCP_TOKEN or --token).",
      "",
      "Shell environment fallbacks (CLI flags win): WORKSPACE_MCP_SHELL=1,",
      "WORKSPACE_MCP_SHELL_MODE=allowlist|any, WORKSPACE_MCP_SHELL_ALLOW=git,docker,",
      "WORKSPACE_MCP_SHELL_DENY=docker.",
      "",
    ].join("\n"),
  );
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      workspace: { type: "string", multiple: true },
      config: { type: "string" },
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      shell: { type: "boolean", default: false },
      "harness-metrics": { type: "boolean", default: false },
      format: { type: "string" },
      "shell-any": { type: "boolean", default: false },
      "shell-allow": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  });

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid --port: ${values.port}`);
    }
  }

  // Slice B metrics (change harness-operability): operator-local CLI surface
  // only. The format is validated here; the snapshot itself is printed from
  // main() after config resolution and the process exits without serving.
  const format = values.format;
  if (values["harness-metrics"] !== true && format !== undefined) {
    throw new Error("--format requires --harness-metrics");
  }
  if (format !== undefined && format !== "human" && format !== "json") {
    throw new Error(`invalid --format: ${format} (expected human|json)`);
  }

  return {
    root: values.root,
    workspaces: values.workspace,
    config: values.config,
    http: values.http === true,
    host: values.host,
    port,
    token: values.token ?? process.env.MCP_TOKEN ?? undefined,
    shell: {
      flag: values.shell === true,
      any: values["shell-any"] === true,
      allow: values["shell-allow"],
    },
    help: values.help === true,
    version: values.version === true,
    harnessMetrics: values["harness-metrics"] === true,
    format,
  };
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function isAuthorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

function sendJsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function runStdio(
  workspaces: WorkspaceConfig[],
  defaultWorkspace: string,
  version: string,
  shell: ShellConfig,
  harness?: { session?: boolean; recall?: boolean; store?: HarnessStore; skillsDir?: string },
): Promise<void> {
  // Harness sessions are explicit tokens only (change chatgpt-workspace-harness):
  // continuity is by server-issued session/work token resolved inside
  // src/tools/session.ts handlers against the shared outside-repo store.
  // Bearer/session semantics live in runHttp below and in the handlers.
  const server = createServer({ workspaces, defaultWorkspace, version, shell, harness });
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("shutting down");
    // Kill background jobs first: they are detached from this process and
    // would otherwise survive as orphans when the daemon exits.
    void shutdownJobs()
      .catch(() => undefined)
      .then(() => server.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  process.stdin.on("end", shutdown);
  log(`ready on stdio (workspaces: ${workspaces.map((workspace) => workspace.name).join(", ")})`);
}

async function runHttp(
  transport: ResolvedConfig["transport"],
  shell: ShellConfig,
  token: string | undefined,
  workspaces: WorkspaceConfig[],
  defaultWorkspace: string,
  version: string,
  harness?: { session?: boolean; recall?: boolean; store?: HarnessStore; skillsDir?: string },
): Promise<void> {
  if (token === undefined && !isLoopbackHost(transport.host)) {
    log(
      "SECURITY WARNING: HTTP mode is bound to a non-loopback host without a token. " +
        "Anyone who can reach this port gets full read/write access to the workspace. " +
        "Set --token (or MCP_TOKEN) or bind to 127.0.0.1.",
    );
  }

  const activeSessions = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname !== MCP_ENDPOINT) {
      sendJsonRpcError(response, 404, -32601, "Not found");
      return;
    }
    if (!isAuthorized(request, token)) {
      sendUnauthorized(response);
      return;
    }

    if (request.method !== "POST") {
      sendJsonRpcError(response, 405, -32000, "Method not allowed.");
      return;
    }

    const server = createServer({ workspaces, defaultWorkspace, version, shell, harness });
    const serverTransport = new StreamableHTTPServerTransport({
      // Stateless transport by design (change chatgpt-workspace-harness):
      // kept undefined so every POST constructs a fresh McpServer. Session
      // continuity is by explicit harness session/work token resolved inside
      // src/tools/session.ts handlers against the shared outside-repo store —
      // tunnel, connection, and profile identifiers are never identity. The
      // single shared bearer below gates transport/tunnel access only.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const session = { server, transport: serverTransport };
    activeSessions.add(session);

    response.on("close", () => {
      activeSessions.delete(session);
      void serverTransport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(serverTransport);
      await serverTransport.handleRequest(request, response);
    } catch (error) {
      log(`request error: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, -32603, "Internal server error");
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(transport.port, transport.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  log(`ready on http://${transport.host}:${transport.port}${MCP_ENDPOINT} (workspaces: ${workspaces.map((workspace) => workspace.name).join(", ")})`);
  if (token !== undefined) {
    log("bearer token authentication is enabled");
  }

  const shutdown = (): void => {
    log("shutting down");
    httpServer.close();
    httpServer.closeAllConnections();
    for (const session of activeSessions) {
      void session.transport.close().catch(() => undefined);
      void session.server.close().catch(() => undefined);
    }
    void shutdownJobs()
      .catch(() => undefined)
      .finally(() => setTimeout(() => process.exit(0), 100).unref());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  const version = await readPackageVersion();
  if (options.version) {
    process.stderr.write(`${SERVER_NAME} ${version}\n`);
    return;
  }

  let resolved: ResolvedConfig;
  try {
    const file = resolveConfigFile({ cwd: process.cwd(), explicitPath: options.config });
    resolved = mergeConfig({
      file,
      cwd: process.cwd(),
      env: process.env,
      root: options.root,
      workspaces: options.workspaces,
      shell: options.shell,
      transport: { http: options.http, host: options.host, port: options.port },
    });
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    if (error instanceof ConfigError) {
      process.exitCode = 1;
      return;
    }
    printHelp();
    process.exitCode = 2;
    return;
  }

  applyStateDefaults(resolved.state, process.env);
  if (resolved.configPath !== undefined) {
    log(`using config file ${resolved.configPath}`);
  }

  const workspaceConfigs = resolved.workspaces;
  const defaultWorkspace = resolved.defaultWorkspace;
  const shell = resolved.shell;

  if (shell.enabled) {
    if (shell.mode === "any") {
      log(
        "SECURITY WARNING: run_command is enabled in UNRESTRICTED mode (--shell-any / WORKSPACE_MCP_SHELL_MODE=any). " +
          `Any executable can run with your OS user's permissions. This is NOT a sandbox ` +
          `(workspaces: ${workspaceConfigs.map((workspace) => workspace.path).join(", ")}).`,
      );
    } else {
      log(`run_command enabled in allowlist mode (allowed: ${shell.allow.join(", ")})`);
    }
    if ((shell.deny ?? []).length > 0) {
      log(`denied executables (enforced in every mode): ${shell.deny!.join(", ")}`);
    }
  }

  // Slice B metrics (change harness-operability): operator-local CLI path.
  // Reuses the resolved config (workspace roots for scope validation, the
  // configured outside-repo DB path) plus openHarnessStore, so DB-path
  // validation and store-unavailable failure apply unchanged. Prints the
  // SELECT-only snapshot and exits; registers NOTHING via server.registerTool
  // (there is no metrics MCP tool under any flag combination).
  if (options.harnessMetrics) {
    const metricsStore = openHarnessStore({
      dbPath: resolved.harness.dbPath,
      workspaceRoots: workspaceConfigs.map((workspace) => workspace.path),
      skillsDir: resolved.harness.skillsDir,
    });
    try {
      metricsStore.open();
    } catch (error) {
      log(`harness store unavailable: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    try {
      const snapshot = metricsStore.getMetricsSnapshot();
      const output = options.format === "json" ? formatMetricsJson(snapshot) : formatMetricsHuman(snapshot);
      process.stdout.write(`${output}\n`);
    } catch (error) {
      log(`harness store unavailable: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      metricsStore.close();
    }
    return;
  }

  // Harness store (change chatgpt-workspace-harness, tasks 3.2/4.2): opened
  // once here and shared across stateless turns. Flag-off serves the
  // pre-harness surface. An invalid store path aborts startup; request-time
  // failures are explicit store-unavailable errors with no repo-local
  // fallback. The optionals (Engram, obsidian-mcp) are never opened here, so
  // startup never requires them; recall marks them degraded instead.
  let harness: { session: boolean; recall: boolean; store: HarnessStore; skillsDir: string } | undefined;
  if (resolved.harness.session || resolved.harness.recall) {
    const store = openHarnessStore({
      dbPath: resolved.harness.dbPath,
      workspaceRoots: workspaceConfigs.map((workspace) => workspace.path),
      skillsDir: resolved.harness.skillsDir,
    });
    try {
      store.open();
    } catch (error) {
      log(`harness store unavailable: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    harness = { session: resolved.harness.session, recall: resolved.harness.recall, store, skillsDir: resolved.harness.skillsDir };
    if (resolved.harness.session) {
      log(`harness sessions enabled (store: ${resolved.harness.dbPath})`);
    }
    if (resolved.harness.recall) {
      log(`harness recall enabled (store: ${resolved.harness.dbPath})`);
    }
  }

  if (resolved.transport.http) {
    await runHttp(resolved.transport, shell, options.token, workspaceConfigs, defaultWorkspace, version, harness);
  } else {
    await runStdio(workspaceConfigs, defaultWorkspace, version, shell, harness);
  }
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
