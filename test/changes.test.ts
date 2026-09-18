import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "../src/server.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "../src/shell.js";
import { readJournal, stateDir } from "../src/state.js";

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
  const client = new Client({ name: "workspace-mcp-changes-test-client", version: "1.0.0" });
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

/** Tolerates both handler-level error results and schema-rejection throws. */
async function callToolError(session: Session, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const result = await callTool(session, name, args);
    expect(result.isError).toBe(true);
    return result;
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

interface ChangeFile {
  id: string;
  title: string;
  goal?: string;
  constraints: string[];
  tasks: Array<{ id: string; text: string; status: string; notes: string[] }>;
  createdAt: string;
  updatedAt: string;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

const allowlistShell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };

let root: string;
let session: Session;
let shellSession: Session;
const isolatedRoots: string[] = [];

async function isolatedSession(): Promise<{ root: string; session: Session }> {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-changes-"));
  isolatedRoots.push(isolatedRoot);
  const isolated = await connect({ root: isolatedRoot, version: "test" });
  return { root: isolatedRoot, session: isolated };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-mcp-changes-main-"));
  session = await connect({ root, version: "test" });
  shellSession = await connect({ root, version: "test", shell: allowlistShell });
});

afterAll(async () => {
  await close(session);
  await close(shellSession);
  await rm(root, { recursive: true, force: true });
  for (const isolatedRoot of isolatedRoots) {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

describe("change_create", () => {
  it("slugifies the id, creates the JSON and docs dir, becomes active and journals with a change tag", async () => {
    const created = await callTool(session, "change_create", { title: "My First Change", goal: "ship Phase 2" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("created change my-first-change: My First Change");
    expect(created.text).toContain(".workspace-mcp/changes/my-first-change/");
    expect(created.text).toContain("write the proposal");

    const jsonPath = path.join(stateDir(root), "changes", "my-first-change.json");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(path.join(stateDir(root), "changes", "my-first-change"))).toBe(true);
    const info = await stat(path.join(stateDir(root), "changes", "my-first-change"));
    expect(info.isDirectory()).toBe(true);

    const change = await readJson<ChangeFile>(jsonPath);
    expect(change.id).toBe("my-first-change");
    expect(change.title).toBe("My First Change");
    expect(change.goal).toBe("ship Phase 2");
    expect(change.constraints).toEqual([]);
    expect(change.tasks).toEqual([]);
    expect(change.createdAt).toBe(change.updatedAt);

    const state = await readJson<{ activeChange: string | null }>(path.join(stateDir(root), "state.json"));
    expect(state.activeChange).toBe("my-first-change");

    const journal = await readJournal(root, { change: "my-first-change" });
    const entry = journal.find((candidate) => candidate.tool === "change_create");
    expect(entry).toBeDefined();
    expect(entry?.detail).toBe("my-first-change");
    expect(entry?.result).toBe("active");
  });

  it("dedupes duplicate titles with -2 and -3", async () => {
    const first = await callTool(session, "change_create", { title: "Duplicate Title" });
    const second = await callTool(session, "change_create", { title: "Duplicate Title" });
    const third = await callTool(session, "change_create", { title: "Duplicate Title" });
    expect(first.text).toContain("created change duplicate-title:");
    expect(second.text).toContain("created change duplicate-title-2:");
    expect(third.text).toContain("created change duplicate-title-3:");
    expect(existsSync(path.join(stateDir(root), "changes", "duplicate-title.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(root), "changes", "duplicate-title-3.json"))).toBe(true);
  });
});

describe("change_activate", () => {
  it("switches the active change and rejects unknown ids cleanly", async () => {
    await callTool(session, "change_create", { title: "Activate One" });
    await callTool(session, "change_create", { title: "Activate Two" });

    const activated = await callTool(session, "change_activate", { changeId: "activate-one" });
    expect(activated.isError).toBe(false);
    expect(activated.text).toContain("active change: activate-one");
    expect(activated.text).toContain("0/0 tasks done");
    let state = await readJson<{ activeChange: string | null }>(path.join(stateDir(root), "state.json"));
    expect(state.activeChange).toBe("activate-one");

    const missing = await callToolError(session, "change_activate", { changeId: "does-not-exist" });
    expect(missing.text).toContain("change not found: does-not-exist");
    state = await readJson<{ activeChange: string | null }>(path.join(stateDir(root), "state.json"));
    expect(state.activeChange).toBe("activate-one");
  });
});

describe("change_doc", () => {
  it("writes, replaces and appends documents for the active change, and rejects bad stages", async () => {
    await callTool(session, "change_create", { title: "Doc Change" });

    const written = await callTool(session, "change_doc", { stage: "proposal", content: "# Proposal\n\nfirst line" });
    expect(written.isError).toBe(false);
    expect(written.text).toContain(".workspace-mcp/changes/doc-change/proposal.md");
    expect(written.text).toContain("docs present: proposal.md");

    const docPath = path.join(stateDir(root), "changes", "doc-change", "proposal.md");
    expect(await readFile(docPath, "utf8")).toBe("# Proposal\n\nfirst line\n");

    const appended = await callTool(session, "change_doc", {
      stage: "proposal",
      content: "appended line",
      append: true,
    });
    expect(appended.isError).toBe(false);
    expect(await readFile(docPath, "utf8")).toBe("# Proposal\n\nfirst line\n\nappended line\n");

    const replaced = await callTool(session, "change_doc", { stage: "proposal", content: "fresh" });
    expect(replaced.isError).toBe(false);
    expect(await readFile(docPath, "utf8")).toBe("fresh\n");

    const badStage = await callToolError(session, "change_doc", { stage: "review", content: "nope" });
    expect(badStage.isError).toBe(true);

    const unknownChange = await callToolError(session, "change_doc", {
      changeId: "ghost",
      stage: "spec",
      content: "nope",
    });
    expect(unknownChange.text).toContain("change not found: ghost");
  });

  it("fails cleanly when there is no active change and no explicit id", async () => {
    const isolated = await isolatedSession();
    try {
      const result = await callToolError(isolated.session, "change_doc", { stage: "proposal", content: "nope" });
      expect(result.text).toContain("no active change");
    } finally {
      await close(isolated.session);
    }
  });

  it("keeps the change updatedAt fresh after a document write", async () => {
    const before = await readJson<ChangeFile>(path.join(stateDir(root), "changes", "doc-change.json"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await callTool(session, "change_doc", { stage: "notes", content: "scratch" });
    const after = await readJson<ChangeFile>(path.join(stateDir(root), "changes", "doc-change.json"));
    expect(after.updatedAt >= before.updatedAt).toBe(true);
    expect(await readFile(path.join(stateDir(root), "changes", "doc-change", "notes.md"), "utf8")).toBe("scratch\n");
  });
});

describe("task_add", () => {
  it("allocates sequential ids and defaults to pending", async () => {
    await callTool(session, "change_create", { title: "Task Change" });

    const first = await callTool(session, "task_add", { text: "wire the schema" });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("added T1 [pending] wire the schema");

    const second = await callTool(session, "task_add", { text: "write tests", status: "in_progress" });
    expect(second.text).toContain("added T2 [in_progress] write tests");
    expect(second.text).toContain("0/2 done");

    const change = await readJson<ChangeFile>(path.join(stateDir(root), "changes", "task-change.json"));
    expect(change.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
    expect(change.tasks[0]?.status).toBe("pending");
    expect(change.tasks[0]?.notes).toEqual([]);
    expect(change.tasks[1]?.status).toBe("in_progress");
  });
});

describe("task_update", () => {
  it("is all-or-nothing, appends notes and validates ids and statuses", async () => {
    await callTool(session, "change_create", { title: "Update Change" });
    await callTool(session, "task_add", { text: "first task" });
    await callTool(session, "task_add", { text: "second task" });

    const changePath = path.join(stateDir(root), "changes", "update-change.json");
    const before = await readFile(changePath, "utf8");

    const bad = await callToolError(session, "task_update", {
      updates: [
        { taskId: "T1", status: "done" },
        { taskId: "T9", status: "done" },
      ],
    });
    expect(bad.text).toContain("unknown task id(s): T9");
    expect(await readFile(changePath, "utf8")).toBe(before);

    const invalidStatus = await callToolError(session, "task_update", {
      updates: [{ taskId: "T2", status: "finished" }],
    });
    expect(invalidStatus.isError).toBe(true);
    expect(await readFile(changePath, "utf8")).toBe(before);

    const updated = await callTool(session, "task_update", {
      updates: [
        { taskId: "T1", status: "done", note: "verified locally" },
        { taskId: "T2", status: "in_progress" },
      ],
    });
    expect(updated.isError).toBe(false);
    expect(updated.text).toContain("T1: pending → done");
    expect(updated.text).toContain("T2: pending → in_progress");
    expect(updated.text).toContain("1/2 done");

    const after = await readJson<ChangeFile>(changePath);
    expect(after.tasks[0]?.status).toBe("done");
    expect(after.tasks[0]?.notes).toEqual(["verified locally"]);
    expect(after.tasks[1]?.status).toBe("in_progress");

    const journal = await readJournal(root, { change: "update-change" });
    const entry = journal.find((candidate) => candidate.tool === "task_update");
    expect(entry?.detail).toBe("T1→done, T2→in_progress");
    expect(entry?.result).toBe("ok");
  });
});

describe("constraint_add", () => {
  it("appends constraints and returns the full list", async () => {
    await callTool(session, "change_create", { title: "Constraint Change" });
    const first = await callTool(session, "constraint_add", { text: "no new runtime dependencies" });
    expect(first.text).toContain("(1 total)");
    const second = await callTool(session, "constraint_add", { text: "keep tests on real fs" });
    expect(second.text).toContain("(2 total)");
    expect(second.text).toContain("- no new runtime dependencies");
    expect(second.text).toContain("- keep tests on real fs");

    const status = await callTool(session, "change_status", {});
    expect(status.text).toContain("constraints (2):");
    expect(status.text).toContain("- keep tests on real fs");
  });
});

describe("change_status", () => {
  it("renders a full view and derives the next action across the lifecycle", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Lifecycle Change", goal: "prove suggestions" });

      const start = await callTool(isolated.session, "change_status", {});
      expect(start.isError).toBe(false);
      expect(start.text).toContain("Change lifecycle-change: Lifecycle Change");
      expect(start.text).toContain("goal: prove suggestions");
      expect(start.text).toContain("active: yes");
      expect(start.text).toContain("proposal.md (missing)");
      expect(start.text).toContain("tasks (0/0 done):");
      expect(start.text).toContain("constraints: none");
      expect(start.text).toContain("recent activity (1, newest first):");
      expect(start.text).toContain("change_create");
      expect(start.text).toContain("suggested next action: write the proposal with change_doc (stage proposal)");

      await callTool(isolated.session, "change_doc", { stage: "proposal", content: "# Proposal" });
      const afterProposal = await callTool(isolated.session, "change_status", {});
      expect(afterProposal.text).toContain("proposal.md (");
      expect(afterProposal.text).toContain("suggested next action: break the work into tasks with task_add");

      await callTool(isolated.session, "task_add", { text: "extract the model" });
      await callTool(isolated.session, "task_add", { text: "wire the tools" });
      const withTasks = await callTool(isolated.session, "change_status", {});
      expect(withTasks.text).toContain("T1 [pending] extract the model");
      expect(withTasks.text).toContain("T2 [pending] wire the tools");
      expect(withTasks.text).toContain("suggested next action: start T1");

      await callTool(isolated.session, "task_update", { updates: [{ taskId: "T1", status: "in_progress" }] });
      const inProgress = await callTool(isolated.session, "change_status", {});
      expect(inProgress.text).toContain("T1 [in_progress] extract the model");
      expect(inProgress.text).toContain("suggested next action: continue T1");

      await callTool(isolated.session, "task_update", { updates: [{ taskId: "T1", status: "blocked", note: "waiting" }] });
      const blocked = await callTool(isolated.session, "change_status", {});
      expect(blocked.text).toContain("T1 [blocked] extract the model");
      expect(blocked.text).toContain("suggested next action: unblock T1");

      await callTool(isolated.session, "task_update", {
        updates: [
          { taskId: "T1", status: "done" },
          { taskId: "T2", status: "done" },
        ],
      });
      const completed = await callTool(isolated.session, "change_status", {});
      expect(completed.text).toContain("tasks (2/2 done):");
      expect(completed.text).toContain("task_update");
      expect(completed.text).toContain("suggested next action: run the tests and save a summary with remember");
    } finally {
      await close(isolated.session);
    }
  });

  it("lists every change newest-first with done/total counts and the active marker", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "List Alpha" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await callTool(isolated.session, "change_create", { title: "List Beta" });
      await callTool(isolated.session, "task_add", { text: "beta task" });
      await callTool(isolated.session, "task_update", { updates: [{ taskId: "T1", status: "done" }] });

      const all = await callTool(isolated.session, "change_status", { all: true });
      expect(all.isError).toBe(false);
      expect(all.text).toContain("Changes (newest first, 2):");
      const betaLine = all.text.split("\n").find((line) => line.includes("list-beta"));
      const alphaLine = all.text.split("\n").find((line) => line.includes("list-alpha"));
      expect(betaLine).toContain("List Beta");
      expect(betaLine).toContain("1/1 tasks");
      expect(betaLine).toContain("(active)");
      expect(alphaLine).toContain("List Alpha");
      expect(alphaLine).toContain("0/0 tasks");
      expect(alphaLine).not.toContain("(active)");
      expect(all.text.indexOf("list-beta")).toBeLessThan(all.text.indexOf("list-alpha"));

      const explicitList = await callTool(isolated.session, "change_status", { changeId: "list-alpha", all: true });
      expect(explicitList.text).toContain("Changes (newest first, 2):");
    } finally {
      await close(isolated.session);
    }
  });

  it("falls back to list mode when there is no active change and reports an empty root", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Orphan Change" });
      await rm(path.join(stateDir(isolated.root), "state.json"), { force: true });

      const listed = await callTool(isolated.session, "change_status", {});
      expect(listed.isError).toBe(false);
      expect(listed.text).toContain("Changes (newest first, 1):");
      expect(listed.text).toContain("orphan-change");
    } finally {
      await close(isolated.session);
    }

    const empty = await isolatedSession();
    try {
      const none = await callTool(empty.session, "change_status", {});
      expect(none.isError).toBe(false);
      expect(none.text).toBe("no changes yet");
      const noneAll = await callTool(empty.session, "change_status", { all: true });
      expect(noneAll.text).toBe("no changes yet");
    } finally {
      await close(empty.session);
    }
  });

  it("is read-only and never writes to the journal", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Read Only Change" });
      const journalPath = path.join(stateDir(isolated.root), "journal.jsonl");
      const before = await readFile(journalPath, "utf8");
      await callTool(isolated.session, "change_status", {});
      await callTool(isolated.session, "change_status", { all: true });
      expect(await readFile(journalPath, "utf8")).toBe(before);
    } finally {
      await close(isolated.session);
    }
  });
});

describe("journal change tagging", () => {
  it("tags mutating operations with the active change and filters work_log by change", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Tag Change" });
      await callTool(isolated.session, "write_file", { path: "tagged.txt", content: "hello" });

      const tagged = await readJournal(isolated.root, { change: "tag-change" });
      const writeEntry = tagged.find((entry) => entry.tool === "write_file");
      expect(writeEntry).toBeDefined();
      expect(writeEntry?.paths).toEqual(["tagged.txt"]);

      await callTool(isolated.session, "change_create", { title: "Other Change" });
      await callTool(isolated.session, "write_file", { path: "other.txt", content: "other" });

      const filtered = await callTool(isolated.session, "work_log", { change: "tag-change" });
      expect(filtered.isError).toBe(false);
      expect(filtered.text).toContain("tagged.txt");
      expect(filtered.text).not.toContain("other.txt");

      const all = await callTool(isolated.session, "work_log", {});
      expect(all.text).toContain("tagged.txt");
      expect(all.text).toContain("other.txt");

      const noTags = await callTool(isolated.session, "remember", { text: "unanchored note" });
      expect(noTags.isError).toBe(false);
    } finally {
      await close(isolated.session);
    }
  });
});

describe("change persistence", () => {
  it("survives across server instances on the same root", async () => {
    const isolated = await isolatedSession();
    try {
      await close(isolated.session);

      const first = await connect({ root: isolated.root, version: "test" });
      await callTool(first, "change_create", { title: "Persist Change", goal: "durable" });
      await callTool(first, "change_doc", { stage: "proposal", content: "# Durable" });
      await callTool(first, "task_add", { text: "survive restart" });
      await close(first);

      const second = await connect({ root: isolated.root, version: "test" });
      try {
        const status = await callTool(second, "change_status", {});
        expect(status.isError).toBe(false);
        expect(status.text).toContain("Change persist-change: Persist Change");
        expect(status.text).toContain("goal: durable");
        expect(status.text).toContain("active: yes");
        expect(status.text).toContain("proposal.md (");
        expect(status.text).toContain("T1 [pending] survive restart");

        const log = await callTool(second, "work_log", { change: "persist-change" });
        expect(log.text).toContain("change_doc");
        expect(log.text).toContain("task_add");
      } finally {
        await close(second);
      }
    } finally {
      const existing = isolatedRoots.indexOf(isolated.root);
      if (existing >= 0) {
        isolatedRoots.splice(existing, 1);
      }
      await rm(isolated.root, { recursive: true, force: true });
    }
  });
});

describe("parallel mutating tool calls", () => {
  it("serializes change_create and task_add fired together", async () => {
    const isolated = await isolatedSession();
    try {
      const [created, added] = await Promise.all([
        callTool(isolated.session, "change_create", { title: "Parallel Create" }),
        callTool(isolated.session, "task_add", { text: "first parallel task" }),
      ]);
      expect(created.isError).toBe(false);
      expect(created.text).toContain("created change parallel-create:");
      expect(added.isError).toBe(false);
      expect(added.text).toContain("added T1 [pending] first parallel task");

      const change = await readJson<ChangeFile>(path.join(stateDir(isolated.root), "changes", "parallel-create.json"));
      expect(change.tasks.map((task) => task.id)).toEqual(["T1"]);
      expect(change.tasks[0]?.text).toBe("first parallel task");
    } finally {
      await close(isolated.session);
    }
  });

  it("assigns distinct sequential ids to two parallel task_add calls", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Parallel Tasks" });

      const [first, second] = await Promise.all([
        callTool(isolated.session, "task_add", { text: "alpha" }),
        callTool(isolated.session, "task_add", { text: "beta" }),
      ]);
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      const ids = [first.text, second.text].map((text) => /added (T\d+)/.exec(text)?.[1]);
      expect(ids).toEqual(["T1", "T2"]);

      const change = await readJson<ChangeFile>(path.join(stateDir(isolated.root), "changes", "parallel-tasks.json"));
      expect(change.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
      expect(change.tasks.map((task) => task.text)).toEqual(["alpha", "beta"]);
    } finally {
      await close(isolated.session);
    }
  });

  it("keeps sequential task_add calls unchanged", async () => {
    const isolated = await isolatedSession();
    try {
      await callTool(isolated.session, "change_create", { title: "Sequential Sanity" });
      const first = await callTool(isolated.session, "task_add", { text: "one" });
      const second = await callTool(isolated.session, "task_add", { text: "two" });
      expect(first.text).toContain("added T1 [pending] one");
      expect(second.text).toContain("added T2 [pending] two");
    } finally {
      await close(isolated.session);
    }
  });
});

describe("change tool registration", () => {
  it("registers exactly nineteen tools without shell, with change_status marked read-only", async () => {
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
    expect(tools.get("change_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("change_create")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.get("task_update")?.annotations?.readOnlyHint).toBe(false);
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

  it("leaves no .tmp files behind after change writes", async () => {
    const files = await collectFiles(stateDir(root));
    const temporary = files.filter((file) => file.endsWith(".tmp"));
    expect(temporary).toEqual([]);
    expect(files.some((file) => file.endsWith("state.json"))).toBe(true);
    expect(files.some((file) => file.endsWith("proposal.md"))).toBe(true);
  });
});
