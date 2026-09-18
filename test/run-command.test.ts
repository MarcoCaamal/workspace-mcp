import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "../src/server.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "../src/shell.js";

interface ToolResponse {
  text: string;
  isError: boolean;
}

interface Session {
  client: Client;
  server: McpServer;
}

async function connect(options: { root: string } & Omit<CreateServerOptions, "workspaces">): Promise<Session> {
  const { root, ...rest } = options;
  const server = createServer({ workspaces: [{ name: "default", path: root }], ...rest });
  const client = new Client({ name: "workspace-mcp-run-test-client", version: "1.0.0" });
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

const allowlistShell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-mcp-run-"));
  await mkdir(path.join(root, "subdir"), { recursive: true });
  await writeFile(path.join(root, "hello-tool"), "#!/bin/sh\necho custom-tool-ok\n");
  await chmod(path.join(root, "hello-tool"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("run_command registration", () => {
  let disabled: Session;
  let enabled: Session;

  beforeAll(async () => {
    disabled = await connect({ root, version: "test" });
    enabled = await connect({ root, version: "test", shell: allowlistShell });
  });

  afterAll(async () => {
    await close(disabled);
    await close(enabled);
  });

  it("is off by default: tools/list shows exactly the nineteen non-shell tools", async () => {
    const listed = await disabled.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "change_activate",
      "change_create",
      "change_doc",
      "change_status",
      "constraint_add",
      "edit_file",
      "git_diff",
      "git_status",
      "grep",
      "list_files",
      "patch",
      "read_file",
      "recall",
      "remember",
      "task_add",
      "task_update",
      "work_log",
      "workspace_list",
      "write_file",
    ]);
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("start_job");
  });

  it("is registered when enabled: tools/list shows the twenty-three tools with destructive annotations", async () => {
    const listed = await enabled.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "change_activate",
      "change_create",
      "change_doc",
      "change_status",
      "constraint_add",
      "edit_file",
      "git_diff",
      "git_status",
      "grep",
      "job_kill",
      "job_status",
      "list_files",
      "patch",
      "read_file",
      "recall",
      "remember",
      "run_command",
      "start_job",
      "task_add",
      "task_update",
      "work_log",
      "workspace_list",
      "write_file",
    ]);

    const runTool = listed.tools.find((tool) => tool.name === "run_command");
    expect(runTool?.annotations?.readOnlyHint).toBe(false);
    expect(runTool?.annotations?.destructiveHint).toBe(true);
    expect(runTool?.annotations?.openWorldHint).toBe(true);
    expect(runTool?.inputSchema?.required).toContain("command");
  });

  it("accepts the documented arguments", async () => {
    const response = await callTool(enabled, "run_command", {
      command: ["node", "-e", "console.log('schema-ok')"],
      cwd: ".",
      timeoutMs: 5000,
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("schema-ok");
  });

  it("rejects an empty command array and empty string items at the schema level", async () => {
    const emptyArray = await callTool(enabled, "run_command", { command: [] });
    expect(emptyArray.isError).toBe(true);
    expect(emptyArray.text).toContain("Input validation error");

    const emptyItem = await callTool(enabled, "run_command", { command: [""] });
    expect(emptyItem.isError).toBe(true);
    expect(emptyItem.text).toContain("Input validation error");
  });
});

describe("run_command execution", () => {
  let session: Session;

  beforeAll(async () => {
    session = await connect({ root, version: "test", shell: allowlistShell });
  });

  afterAll(async () => {
    await close(session);
  });

  it("runs an allowlisted command and reports output and exit code 0", async () => {
    const response = await callTool(session, "run_command", { command: ["node", "-e", "console.log('hello')"] });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("hello");
    expect(response.text).toContain("exit code: 0");
  });

  it("reports a non-zero exit code with the captured stderr", async () => {
    const response = await callTool(session, "run_command", {
      command: ["node", "-e", "console.error('boom-stderr'); process.exit(3)"],
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("boom-stderr");
    expect(response.text).toContain("exit code: 3");
  });

  it("rejects a non-allowlisted executable with a clear message", async () => {
    const response = await callTool(session, "run_command", { command: ["bash", "-c", "echo hi"] });
    expect(response.isError).toBe(true);
    expect(response.text).toContain("command not allowed: bash");
    expect(response.text).toContain("Allowed executables: pnpm, npm, npx, node");
    expect(response.text).toContain("--shell-allow");
    expect(response.text).toContain("--shell-any");
  });

  it("kills a command that exceeds the timeout", async () => {
    const startedAt = Date.now();
    const response = await callTool(session, "run_command", {
      command: ["node", "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - startedAt;
    expect(response.isError).toBe(false);
    expect(response.text).toContain("timed out after 1000ms");
    expect(elapsed).toBeLessThan(5000);
  });

  it("confines cwd to the workspace root and supports a subdirectory", async () => {
    const rejected = await callTool(session, "run_command", {
      command: ["node", "-e", "console.log('x')"],
      cwd: "../..",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toBe("path outside workspace root: ../..");

    const response = await callTool(session, "run_command", {
      command: ["node", "-e", "console.log(process.cwd())"],
      cwd: "subdir",
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain(await realpath(path.join(root, "subdir")));
  });

  it("scrubs credentials from the child environment", async () => {
    process.env.CONTROL_PLANE_API_KEY = "super-secret";
    try {
      const response = await callTool(session, "run_command", {
        command: ["node", "-e", "console.log(process.env.CONTROL_PLANE_API_KEY ?? 'ABSENT')"],
      });
      expect(response.isError).toBe(false);
      expect(response.text).toContain("ABSENT");
      expect(response.text).not.toContain("super-secret");
    } finally {
      delete process.env.CONTROL_PLANE_API_KEY;
    }
  });

  it("keeps head and tail when output exceeds 256 KiB", async () => {
    const script = 'process.stdout.write("HEAD_MARKER\\n" + "x".repeat(300 * 1024) + "\\nTAIL_MARKER\\n")';
    const response = await callTool(session, "run_command", { command: ["node", "-e", script] });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("HEAD_MARKER");
    expect(response.text).toContain("TAIL_MARKER");
    expect(response.text).toMatch(/\.\.\. \(\d+ bytes truncated\) \.\.\./);
  });

  it("strips ANSI escape codes", async () => {
    const response = await callTool(session, "run_command", {
      command: ["node", "-e", 'process.stdout.write("\\u001B[31mred\\u001B[0m\\n")'],
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("red");
    expect(response.text).not.toContain("\u001B");
    expect(response.text).not.toContain("[31m");
  });
});

describe("run_command allowlist extension and unrestricted mode", () => {
  let extended: Session;
  let unrestricted: Session;

  beforeAll(async () => {
    extended = await connect({
      root,
      version: "test",
      shell: { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW, "hello-tool"] },
    });
    unrestricted = await connect({ root, version: "test", shell: { enabled: true, mode: "any", allow: [...DEFAULT_SHELL_ALLOW] } });
  });

  afterAll(async () => {
    await close(extended);
    await close(unrestricted);
  });

  it("runs a custom executable added to the allowlist", async () => {
    const response = await callTool(extended, "run_command", { command: ["./hello-tool"], cwd: "." });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("custom-tool-ok");
    expect(response.text).toContain("exit code: 0");
  });

  it("still rejects the custom executable when it is not in the default allowlist", async () => {
    const defaults = await connect({ root, version: "test", shell: allowlistShell });
    try {
      const response = await callTool(defaults, "run_command", { command: ["./hello-tool"] });
      expect(response.isError).toBe(true);
      expect(response.text).toContain("command not allowed: hello-tool");
    } finally {
      await close(defaults);
    }
  });

  it("runs a non-allowlisted executable in unrestricted mode", async () => {
    const response = await callTool(unrestricted, "run_command", { command: ["bash", "-c", "echo hi"] });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("hi");
    expect(response.text).toContain("exit code: 0");
  });
});
