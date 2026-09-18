import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shutdownJobs } from "../src/jobs.js";
import { createServer, type CreateServerOptions } from "../src/server.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "../src/shell.js";
import { appendJournal, readJournal, stateDir } from "../src/state.js";

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
  const client = new Client({ name: "workspace-mcp-state-test-client", version: "1.0.0" });
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
let session: Session;
let shellSession: Session;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-mcp-state-"));
  session = await connect({ root, version: "test" });
  shellSession = await connect({ root, version: "test", shell: allowlistShell });
});

afterAll(async () => {
  await shutdownJobs();
  await close(session);
  await close(shellSession);
  await rm(root, { recursive: true, force: true });
});

describe("automatic journal", () => {
  it("records write_file, edit_file and patch with paths and details", async () => {
    await callTool(session, "write_file", { path: "j/a.txt", content: "alpha" });
    await callTool(session, "edit_file", { path: "j/a.txt", oldString: "alpha", newString: "beta" });
    await callTool(session, "patch", {
      edits: [
        { path: "j/a.txt", oldString: "beta", newString: "gamma" },
        { path: "j/a.txt", oldString: "gamma", newString: "delta" },
      ],
    });

    const log = await callTool(session, "work_log", { path: "j/a.txt" });
    expect(log.isError).toBe(false);
    expect(log.text).toContain("write_file");
    expect(log.text).toContain("j/a.txt");
    expect(log.text).toContain("created 5 bytes");
    expect(log.text).toContain("edit_file");
    expect(log.text).toContain("1 replacement");
    expect(log.text).toContain("patch");
    expect(log.text).toContain("2 edits across 1 file");
    expect(log.text).toContain("[ok]");

    expect(log.text.indexOf("patch")).toBeLessThan(log.text.indexOf("edit_file"));
    expect(log.text.indexOf("edit_file")).toBeLessThan(log.text.indexOf("write_file"));
  });

  it("records a failed edit_file as an error entry", async () => {
    await callTool(session, "write_file", { path: "j/fail.txt", content: "x" });
    const failed = await callTool(session, "edit_file", { path: "j/fail.txt", oldString: "nope", newString: "y" });
    expect(failed.isError).toBe(true);

    const log = await callTool(session, "work_log", { path: "j/fail.txt" });
    expect(log.text).toContain("error: oldString not found in j/fail.txt");
    expect(log.text).toContain("[error:");
  });

  it("records run_command, start_job and job_kill outcomes", async () => {
    const run = await callTool(shellSession, "run_command", { command: ["node", "-e", "console.log('ok')"] });
    expect(run.isError).toBe(false);

    const start = await callTool(shellSession, "start_job", {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      name: "journal-job",
    });
    expect(start.isError).toBe(false);
    const jobId = /jobId: (job_[0-9a-f]+)/.exec(start.text)?.[1];
    expect(jobId).toBeDefined();

    const killed = await callTool(shellSession, "job_kill", { jobId: jobId as string });
    expect(killed.isError).toBe(false);

    const log = await callTool(shellSession, "work_log", {});
    expect(log.text).toContain("run_command");
    expect(log.text).toMatch(/exit 0 \(\d+ms\)/);
    expect(log.text).toContain(`started (${jobId as string})`);
    expect(log.text).toContain(jobId as string);
    expect(log.text).toContain("[killed]");
  });

  it("filters by since, path and limit, and reports an empty log", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const emptyLog = await callTool(session, "work_log", { since: future });
    expect(emptyLog.isError).toBe(false);
    expect(emptyLog.text).toBe("no activity recorded yet");

    const byPath = await callTool(session, "work_log", { path: "j/a.txt" });
    expect(byPath.text).toContain("j/a.txt");
    expect(byPath.text).not.toContain("j/fail.txt");

    const limited = await callTool(session, "work_log", { limit: 1 });
    const header = limited.text.split("\n")[0] ?? "";
    expect(header).toContain("newest first, 1");
  });
});

describe("remember and recall", () => {
  it("appends notes and returns them newest first with query and tag filters", async () => {
    const first = await callTool(session, "remember", { text: "first memory", tags: ["alpha", "phase-1"] });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^noted \(#\d+ total\)$/);

    const second = await callTool(session, "remember", { text: "second memory about auth", tags: ["beta"] });
    expect(second.text).toMatch(/^noted \(#\d+ total\)$/);

    const all = await callTool(session, "recall", {});
    expect(all.isError).toBe(false);
    const firstIndex = all.text.indexOf("first memory");
    const secondIndex = all.text.indexOf("second memory");
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeGreaterThan(secondIndex);
    expect(all.text).toContain("[#alpha]");
    expect(all.text).toMatch(/^\d{4}-\d{2}-\d{2}  /);

    const query = await callTool(session, "recall", { query: "AUTH" });
    expect(query.text).toContain("second memory");
    expect(query.text).not.toContain("first memory");

    const tag = await callTool(session, "recall", { tag: "alpha" });
    expect(tag.text).toContain("first memory");
    expect(tag.text).not.toContain("second memory");

    const missing = await callTool(session, "recall", { query: "zzz-does-not-exist" });
    expect(missing.isError).toBe(false);
    expect(missing.text).toBe("no notes match");
  });

  it("persists notes across server instances on the same root", async () => {
    const isolated = await mkdtemp(path.join(tmpdir(), "workspace-mcp-notes-"));
    try {
      const first = await connect({ root: isolated, version: "test" });
      await callTool(first, "remember", { text: "durable note", tags: ["persist"] });
      await close(first);

      const second = await connect({ root: isolated, version: "test" });
      const recalled = await callTool(second, "recall", {});
      expect(recalled.text).toContain("durable note");
      await close(second);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe("state directory", () => {
  it("is created lazily, ignores itself in git and stays invisible to traversal", async () => {
    const isolated = await mkdtemp(path.join(tmpdir(), "workspace-mcp-state-dir-"));
    try {
      const isolatedSession = await connect({ root: isolated, version: "test" });
      try {
        expect(existsSync(stateDir(isolated))).toBe(false);

        await callTool(isolatedSession, "write_file", { path: "hello.txt", content: "hi" });
        expect(existsSync(stateDir(isolated))).toBe(true);
        expect(await readFile(path.join(stateDir(isolated), ".gitignore"), "utf8")).toBe("*\n");

        const listed = await callTool(isolatedSession, "list_files", { path: "." });
        expect(listed.isError).toBe(false);
        expect(listed.text).not.toContain(".workspace-mcp");

        const grepped = await callTool(isolatedSession, "grep", { pattern: '"tool"', path: "." });
        expect(grepped.isError).toBe(false);
        expect(grepped.text).not.toContain(".workspace-mcp");
      } finally {
        await close(isolatedSession);
      }
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it("rotates the journal when WORKSPACE_MCP_JOURNAL_MAX_BYTES is exceeded", async () => {
    const isolated = await mkdtemp(path.join(tmpdir(), "workspace-mcp-rotate-"));
    try {
      process.env.WORKSPACE_MCP_JOURNAL_MAX_BYTES = "1";
      try {
        await appendJournal(isolated, { tool: "write_file", paths: ["a.txt"], detail: "created 1 bytes", result: "ok" });
        await appendJournal(isolated, { tool: "write_file", paths: ["b.txt"], detail: "created 1 bytes", result: "ok" });
      } finally {
        delete process.env.WORKSPACE_MCP_JOURNAL_MAX_BYTES;
      }

      expect(existsSync(path.join(stateDir(isolated), "journal.1.jsonl"))).toBe(true);
      const entries = await readJournal(isolated, { limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries[0]?.paths).toEqual(["b.txt"]);
      expect(entries[1]?.paths).toEqual(["a.txt"]);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe("tool registration", () => {
  it("registers exactly nineteen tools without shell and marks memory reads read-only", async () => {
    const plain = await connect({ root, version: "test" });
    try {
      const listed = await plain.client.listTools();
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

      const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
      for (const name of ["work_log", "recall", "git_status", "git_diff", "change_status"]) {
        expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await close(plain);
    }
  });

  it("registers exactly twenty-three tools when shell is enabled", async () => {
    const listed = await shellSession.client.listTools();
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
  });
});
