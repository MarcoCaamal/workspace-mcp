import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getJob, listJobs, shutdownJobs } from "../src/jobs.js";
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
  const client = new Client({ name: "workspace-mcp-jobs-test-client", version: "1.0.0" });
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobIdOf(response: ToolResponse): string {
  const match = response.text.match(/job_[0-9a-f]{8}/);
  if (match === null) {
    throw new Error(`no job id in response: ${response.text}`);
  }
  return match[0];
}

async function pollJobStatus(
  session: Session,
  jobId: string,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<ToolResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await callTool(session, "job_status", { jobId });
    if (!response.isError && predicate(response.text)) {
      return response;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for job_status; last response:\n${response.text}`);
    }
    await sleep(100);
  }
}

const exited = (text: string): boolean => /^status: exited/m.test(text);
const killed = (text: string): boolean => /^status: killed/m.test(text);
const timedOut = (text: string): boolean => /^status: timed-out/m.test(text);

const allowlistShell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };

let root: string;
let jobLogDirRoot: string;
let session: Session;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-mcp-jobs-"));
  jobLogDirRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-jobs-log-"));
  process.env.WORKSPACE_MCP_JOB_DIR = jobLogDirRoot;
  await mkdir(path.join(root, "subdir"), { recursive: true });
  session = await connect({ root, version: "test", shell: allowlistShell });
});

afterAll(async () => {
  await shutdownJobs();
  await close(session);
  delete process.env.WORKSPACE_MCP_JOB_DIR;
  await rm(root, { recursive: true, force: true });
  await rm(jobLogDirRoot, { recursive: true, force: true });
});

describe("job tool registration", () => {
  it("registers the four shell tools only when shell is enabled", async () => {
    const listed = await session.client.listTools();
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

    const statusTool = listed.tools.find((tool) => tool.name === "job_status");
    expect(statusTool?.annotations?.readOnlyHint).toBe(true);
    expect(statusTool?.annotations?.openWorldHint).toBe(false);

    const startTool = listed.tools.find((tool) => tool.name === "start_job");
    expect(startTool?.annotations?.readOnlyHint).toBe(false);
    expect(startTool?.annotations?.destructiveHint).toBe(true);
    expect(startTool?.annotations?.openWorldHint).toBe(true);

    const disabled = await connect({ root, version: "test" });
    try {
      const disabledNames = (await disabled.client.listTools()).tools.map((tool) => tool.name).sort();
      expect(disabledNames).toEqual([
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
      expect(disabledNames).not.toContain("start_job");
    } finally {
      await close(disabled);
    }
  });
});

describe("start_job and job_status", () => {
  it("returns immediately and the job finishes with its output in the tail", async () => {
    const startedAt = Date.now();
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "setTimeout(() => console.log('job-finished-marker'), 2000)"],
      name: "immediate-return",
    });
    const elapsed = Date.now() - startedAt;

    expect(start.isError).toBe(false);
    expect(elapsed).toBeLessThan(500);
    expect(start.text).toMatch(/jobId: job_[0-9a-f]{8}/);
    expect(start.text).toContain("Job started. Follow with job_status (read-only, no confirmation needed).");

    const jobId = jobIdOf(start);
    const running = await callTool(session, "job_status", { jobId });
    expect(running.isError).toBe(false);
    expect(running.text).toMatch(/^status: running/m);

    const finished = await pollJobStatus(session, jobId, exited);
    expect(finished.text).toMatch(/exit code: 0/);
    expect(finished.text).toContain("job-finished-marker");
  });

  it("rejects a non-allowlisted executable synchronously and creates no job", async () => {
    const before = listJobs(1000).length;
    const response = await callTool(session, "start_job", { command: ["bash", "-c", "echo hi"] });
    expect(response.isError).toBe(true);
    expect(response.text).toContain("command not allowed: bash");
    expect(response.text).toContain("Allowed executables: pnpm, npm, npx, node");
    expect(listJobs(1000).length).toBe(before);
  });

  it("lists recent jobs and reports unknown job ids", async () => {
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "console.log('listed')"],
      name: "list-me",
    });
    const jobId = jobIdOf(start);
    await pollJobStatus(session, jobId, exited);

    const list = await callTool(session, "job_status", {});
    expect(list.isError).toBe(false);
    expect(list.text).toContain("Recent jobs (newest first");
    expect(list.text).toContain(jobId);
    expect(list.text).toContain("list-me");

    const unknown = await callTool(session, "job_status", { jobId: "job_deadbeef" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toBe("unknown job id: job_deadbeef");
  });

  it("honors tailBytes and returns only the tail of a long log", async () => {
    const script = "for (let i = 1; i <= 2000; i++) console.log('LINE_' + String(i).padStart(4, '0'))";
    const start = await callTool(session, "start_job", { command: ["node", "-e", script] });
    const jobId = jobIdOf(start);
    await pollJobStatus(session, jobId, exited);

    const tail = await callTool(session, "job_status", { jobId, tailBytes: 200 });
    expect(tail.text).toContain("LINE_2000");
    expect(tail.text).not.toContain("LINE_0001");

    const full = await callTool(session, "job_status", { jobId, tailBytes: 262144 });
    expect(full.text).toContain("LINE_0001");
    expect(full.text).toContain("LINE_2000");
  });

  it("confines cwd to the workspace root", async () => {
    const before = listJobs(1000).length;
    const rejected = await callTool(session, "start_job", {
      command: ["node", "-e", "console.log('x')"],
      cwd: "../..",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toBe("path outside workspace root: ../..");
    expect(listJobs(1000).length).toBe(before);

    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "console.log(process.cwd())"],
      cwd: "subdir",
    });
    expect(start.isError).toBe(false);
    const jobId = jobIdOf(start);
    const finished = await pollJobStatus(session, jobId, exited);
    expect(finished.text).toContain(await realpath(path.join(root, "subdir")));
  });

  it("scrubs credentials from the job environment", async () => {
    process.env.CONTROL_PLANE_API_KEY = "super-secret";
    try {
      const start = await callTool(session, "start_job", {
        command: ["node", "-e", "console.log(process.env.CONTROL_PLANE_API_KEY ?? 'ABSENT')"],
      });
      const jobId = jobIdOf(start);
      const finished = await pollJobStatus(session, jobId, exited);
      expect(finished.text).toContain("ABSENT");
      expect(finished.text).not.toContain("super-secret");
    } finally {
      delete process.env.CONTROL_PLANE_API_KEY;
    }
  });

  it("strips ANSI escape codes from job output", async () => {
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", 'process.stdout.write("\\u001B[31mred-job\\u001B[0m\\n")'],
      name: "ansi-job",
    });
    const jobId = jobIdOf(start);
    const finished = await pollJobStatus(session, jobId, exited);
    expect(finished.text).toContain("red-job");
    expect(finished.text).not.toContain("\u001B");
    expect(finished.text).not.toContain("[31m");
    expect(getJob(jobId)?.name).toBe("ansi-job");
  });
});

describe("job_kill", () => {
  it("kills a running job quickly and the process is really dead", async () => {
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      name: "kill-me",
    });
    const jobId = jobIdOf(start);
    const job = getJob(jobId);
    expect(job?.pid).toBeTypeOf("number");

    const startedAt = Date.now();
    const response = await callTool(session, "job_kill", { jobId });
    const elapsed = Date.now() - startedAt;
    expect(response.isError).toBe(false);
    expect(response.text).toContain("killed");
    expect(elapsed).toBeLessThan(5000);

    const status = await callTool(session, "job_status", { jobId });
    expect(status.text).toMatch(/^status: killed/m);
    expect(() => process.kill(job?.pid ?? 0, 0)).toThrow();
  });

  it("is not an error to kill a job that already finished", async () => {
    const start = await callTool(session, "start_job", { command: ["node", "-e", "console.log('done')"] });
    const jobId = jobIdOf(start);
    await pollJobStatus(session, jobId, exited);
    const response = await callTool(session, "job_kill", { jobId });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("already finished with status exited");
  });
});

describe("job limits and lifecycle", () => {
  it("kills a job that exceeds maxRuntimeMs and marks it timed-out", async () => {
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      maxRuntimeMs: 1000,
    });
    const jobId = jobIdOf(start);
    const startedAt = Date.now();
    const finished = await pollJobStatus(session, jobId, timedOut, 5000);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(finished.text).toContain("maxRuntimeMs: 1000");
  });

  it("survives a client disconnect: a fresh server in the same process still sees the job", async () => {
    // Mirrors the HTTP stateless mode: each request gets a new McpServer in the
    // same process, so job lookups must work through the process-global
    // registry rather than per-server state.
    const sessionA = await connect({ root, version: "test", shell: allowlistShell });
    const start = await callTool(sessionA, "start_job", {
      command: ["node", "-e", "setTimeout(() => console.log('survived-disconnect'), 1500)"],
      name: "survivor",
    });
    const jobId = jobIdOf(start);

    await close(sessionA);

    const sessionB = await connect({ root, version: "test", shell: allowlistShell });
    try {
      const finished = await pollJobStatus(sessionB, jobId, exited, 10_000);
      expect(finished.text).toMatch(/exit code: 0/);
      expect(finished.text).toContain("survived-disconnect");
    } finally {
      await close(sessionB);
    }
  });

  it("kills running jobs on shutdown so no orphans remain", async () => {
    const start = await callTool(session, "start_job", {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
    });
    const jobId = jobIdOf(start);
    const job = getJob(jobId);
    expect(job?.pid).toBeTypeOf("number");

    await shutdownJobs();

    expect(() => process.kill(job?.pid ?? 0, 0)).toThrow();
    const status = await callTool(session, "job_status", { jobId });
    expect(status.text).toMatch(/^status: killed/m);
  });
});
