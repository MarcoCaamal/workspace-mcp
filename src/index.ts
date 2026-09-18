#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { shutdownJobs } from "./jobs.js";
import { createServer, FALLBACK_VERSION, SERVER_NAME } from "./server.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig, type ShellMode } from "./shell.js";
import { parseWorkspaceFlags, type WorkspaceConfig } from "./workspaces.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3333;
const MCP_ENDPOINT = "/mcp";

interface CliOptions {
  root: string | undefined;
  workspaces: string[] | undefined;
  http: boolean;
  host: string;
  port: number;
  token: string | undefined;
  shell: ShellConfig;
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
      "  --http          Serve Streamable HTTP at /mcp instead of stdio.",
      `  --host <host>   HTTP bind host. Default: ${DEFAULT_HOST}.`,
      `  --port <port>   HTTP bind port. Default: ${DEFAULT_PORT}.`,
      "  --token <t>     Require 'Authorization: Bearer <t>' on every HTTP request (or set MCP_TOKEN).",
      "  --shell         Enable run_command and the background job tools in allowlist mode. Off by default.",
      "  --shell-any     Enable them in unrestricted mode (any executable). Implies --shell and prints a warning.",
      "  --shell-allow <list>  Add executables to the allowlist (comma-separated and/or repeated; only used when enabled).",
      "  -h, --help      Show this help.",
      "  -v, --version   Show the version.",
      "",
      "Shell environment fallbacks (CLI flags win): WORKSPACE_MCP_SHELL=1,",
      "WORKSPACE_MCP_SHELL_MODE=allowlist|any, WORKSPACE_MCP_SHELL_ALLOW=git,docker.",
      "",
    ].join("\n"),
  );
}

/**
 * Splits comma-separated and repeated values into executable names and reduces
 * each entry to its basename, so `--shell-allow /usr/bin/git` means `git`.
 */
function parseAllowList(rawValues: readonly string[]): string[] {
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

function parseShellConfig(values: {
  shell: boolean;
  "shell-any": boolean;
  "shell-allow": string[] | undefined;
}): ShellConfig {
  const envModeRaw = process.env.WORKSPACE_MCP_SHELL_MODE;
  let envMode: ShellMode | undefined;
  if (envModeRaw === "any" || envModeRaw === "allowlist") {
    envMode = envModeRaw;
  } else if (envModeRaw !== undefined) {
    throw new Error(`invalid WORKSPACE_MCP_SHELL_MODE: ${envModeRaw} (expected "allowlist" or "any")`);
  }

  const cliMode: ShellMode | undefined = values["shell-any"] ? "any" : values.shell ? "allowlist" : undefined;
  const envEnabled = process.env.WORKSPACE_MCP_SHELL === "1";

  const allow = [...DEFAULT_SHELL_ALLOW];
  for (const name of parseAllowList([process.env.WORKSPACE_MCP_SHELL_ALLOW ?? "", ...(values["shell-allow"] ?? [])])) {
    if (!allow.includes(name)) {
      allow.push(name);
    }
  }

  return {
    enabled: cliMode !== undefined || envMode !== undefined || envEnabled,
    mode: cliMode ?? envMode ?? "allowlist",
    allow,
  };
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      workspace: { type: "string", multiple: true },
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      shell: { type: "boolean", default: false },
      "shell-any": { type: "boolean", default: false },
      "shell-allow": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }

  return {
    root: values.root,
    workspaces: values.workspace,
    http: values.http === true,
    host: values.host ?? DEFAULT_HOST,
    port,
    token: values.token ?? process.env.MCP_TOKEN ?? undefined,
    shell: parseShellConfig({
      shell: values.shell === true,
      "shell-any": values["shell-any"] === true,
      "shell-allow": values["shell-allow"],
    }),
    help: values.help === true,
    version: values.version === true,
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
): Promise<void> {
  const server = createServer({ workspaces, defaultWorkspace, version, shell });
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
  options: CliOptions,
  workspaces: WorkspaceConfig[],
  defaultWorkspace: string,
  version: string,
): Promise<void> {
  if (options.token === undefined && !isLoopbackHost(options.host)) {
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
    if (!isAuthorized(request, options.token)) {
      sendUnauthorized(response);
      return;
    }

    if (request.method !== "POST") {
      sendJsonRpcError(response, 405, -32000, "Method not allowed.");
      return;
    }

    const server = createServer({ workspaces, defaultWorkspace, version, shell: options.shell });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const session = { server, transport };
    activeSessions.add(session);

    response.on("close", () => {
      activeSessions.delete(session);
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      log(`request error: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, -32603, "Internal server error");
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  log(`ready on http://${options.host}:${options.port}${MCP_ENDPOINT} (workspaces: ${workspaces.map((workspace) => workspace.name).join(", ")})`);
  if (options.token !== undefined) {
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

  let workspaceConfigs: WorkspaceConfig[];
  try {
    workspaceConfigs = parseWorkspaceFlags({ root: options.root, workspaces: options.workspaces, cwd: process.cwd() });
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 2;
    return;
  }
  const defaultWorkspace =
    workspaceConfigs.find((workspace) => workspace.name === "default")?.name ?? workspaceConfigs[0]!.name;

  if (options.shell.enabled) {
    if (options.shell.mode === "any") {
      log(
        "SECURITY WARNING: run_command is enabled in UNRESTRICTED mode (--shell-any / WORKSPACE_MCP_SHELL_MODE=any). " +
          `Any executable can run with your OS user's permissions. This is NOT a sandbox ` +
          `(workspaces: ${workspaceConfigs.map((workspace) => workspace.path).join(", ")}).`,
      );
    } else {
      log(`run_command enabled in allowlist mode (allowed: ${options.shell.allow.join(", ")})`);
    }
  }

  if (options.http) {
    await runHttp(options, workspaceConfigs, defaultWorkspace, version);
  } else {
    await runStdio(workspaceConfigs, defaultWorkspace, version, options.shell);
  }
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
