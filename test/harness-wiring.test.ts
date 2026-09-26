import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { openHarnessStore, type HarnessStore } from "../src/session-store.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "../src/shell.js";
import type { WorkspaceConfig } from "../src/workspaces.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { buildInstructions } from "../src/server.js";

/**
 * Slice 2 wiring (change chatgpt-workspace-harness, tasks 3.3-3.5).
 *
 * Covers the server instructions block (harness stages, explicit-session
 * convention, bearer/token-possession semantics, no-artifacts scope note,
 * job-restart expectations), the low-interruption contract published in the
 * shell/job tool descriptions (allowlist, truncation caps, env scrubbing,
 * re-attach; enforcement semantics unchanged), the operator-docs disclosures,
 * and one consolidated Slice 2 lifecycle over fresh server instances sharing
 * a single temp DB file.
 */

interface Session {
  client: Client;
  server: McpServer;
  store?: HarnessStore;
}

async function connect(options: {
  workspaces: WorkspaceConfig[];
  defaultWorkspace?: string;
  shell?: ShellConfig;
  harness?: { session?: boolean; store?: HarnessStore };
}): Promise<Session> {
  const server = createServer({
    workspaces: options.workspaces,
    defaultWorkspace: options.defaultWorkspace,
    version: "test",
    shell: options.shell,
    harness: options.harness,
  });
  const client = new Client({ name: "workspace-mcp-harness-wiring-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, store: options.harness?.store };
}

async function close(session: Session): Promise<void> {
  await session.client.close().catch(() => undefined);
  await session.server.close().catch(() => undefined);
  session.store?.close();
}

async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await session.client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return { text, isError: result.isError === true };
}

async function toolDescription(session: Session, name: string): Promise<string> {
  const listed = await session.client.listTools();
  const tool = listed.tools.find((entry) => entry.name === name);
  expect(tool, `expected tool ${name} to be registered`).toBeDefined();
  return tool?.description ?? "";
}

function instructionsWithHarness(workspaces: WorkspaceConfig[], shell?: ShellConfig): string {
  const registry = new WorkspaceRegistry(workspaces);
  return buildInstructions(registry, shell, { session: true });
}

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-mcp-harness-wiring-")));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("slice 2 wiring: harness tool registration", () => {
  it("keeps the 19-tool pre-harness surface when the harness flag is off", async () => {
    const root = path.join(base, "flag-off");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const session = await connect({ workspaces: [{ name: "default", path: root }] });
    try {
      const listed = await session.client.listTools();
      expect(listed.tools).toHaveLength(19);
    } finally {
      await close(session);
    }
  });

  it("registers the eight harness tools when the harness flag is on", async () => {
    const root = path.join(base, "flag-on");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const store = openHarnessStore({ dbPath: path.join(base, "flag-on.db"), workspaceRoots: [root] });
    store.open();
    const session = await connect({
      workspaces: [{ name: "default", path: root }],
      harness: { session: true, store },
    });
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      for (const expected of [
        "session_start",
        "session_end",
        "work_start",
        "session_resume",
        "stage_write",
        "task_write",
        "checkpoint",
        "harness_status",
      ]) {
        expect(names, `expected harness tool ${expected}`).toContain(expected);
      }
      expect(names).toHaveLength(27);
    } finally {
      await close(session);
    }
  });
});

describe("slice 2 wiring: server instructions block", () => {
  it("advertises the harness stages and the explicit-session convention when enabled", async () => {
    const root = path.join(base, "instructions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    for (const stage of ["explore", "propose", "spec", "design", "tasks", "apply", "verify"]) {
      expect(text, `instructions must name harness stage ${stage}`).toContain(stage);
    }
    expect(text).toContain("session_start");
    expect(text).toMatch(/explicit.*token|token.*explicit/i);
    expect(text).toMatch(/tunnel.*never.*identity|never.*tunnel.*identity/i);
  });

  it("states bearer/token-possession semantics honestly when enabled", async () => {
    const root = path.join(base, "instructions-bearer");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    expect(text).toMatch(/bearer/i);
    expect(text).toMatch(/transport/i);
    expect(text).toMatch(/possession/i);
  });

  it("scopes the no-artifacts note to the stateful harness flow only", async () => {
    const root = path.join(base, "instructions-scope");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    expect(text).toMatch(/outside-repo/i);
    expect(text).toMatch(/legacy.*repo-local|repo-local.*legacy/i);
  });

  it("documents job-restart expectations when enabled", async () => {
    const root = path.join(base, "instructions-jobs");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };
    const text = instructionsWithHarness([{ name: "default", path: root }], shell);
    expect(text).toMatch(/restart/i);
    expect(text).toMatch(/unknown/i);
  });

  it("omits the harness block when the flag is off", async () => {
    const root = path.join(base, "instructions-off");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const registry = new WorkspaceRegistry([{ name: "default", path: root }]);
    const text = buildInstructions(registry);
    expect(text).not.toContain("session_start");
  });
});

describe("slice 2 wiring: low-interruption contract in tool descriptions", () => {
  it("publishes env scrubbing on run_command without changing enforcement", async () => {
    const root = path.join(base, "run-desc");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };
    const session = await connect({ workspaces: [{ name: "default", path: root }], shell });
    try {
      const description = await toolDescription(session, "run_command");
      expect(description).toMatch(/scrubbed/i);
      expect(description).toMatch(/allowlist/i);
      expect(description).toMatch(/truncat/i);
      const denied = await callTool(session, "run_command", { command: ["definitely-not-allowed-xyz", "--v"] });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/not allowed/i);
    } finally {
      await close(session);
    }
  });

  it("publishes env scrubbing and re-attach on start_job without changing enforcement", async () => {
    const root = path.join(base, "job-desc");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };
    const session = await connect({ workspaces: [{ name: "default", path: root }], shell });
    try {
      const description = await toolDescription(session, "start_job");
      expect(description).toMatch(/scrubbed/i);
      expect(description).toMatch(/job_status/i);
      const denied = await callTool(session, "start_job", { command: ["definitely-not-allowed-xyz"] });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/not allowed/i);
    } finally {
      await close(session);
    }
  });

  it("reports job_status restart behavior in its description", async () => {
    const root = path.join(base, "job-status-desc");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };
    const session = await connect({ workspaces: [{ name: "default", path: root }], shell });
    try {
      const description = await toolDescription(session, "job_status");
      expect(description).toMatch(/restart/i);
      expect(description).toMatch(/unknown job id/i);
    } finally {
      await close(session);
    }
  });
});

describe("slice 2 operator docs", () => {
  it("documents the harness identity/resume contract and token-possession limits in ARCHITECTURE.md", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs", "ARCHITECTURE.md"), "utf8");
    expect(doc).toMatch(/harness/i);
    expect(doc).toMatch(/session_start/i);
    expect(doc).toMatch(/possession/i);
    expect(doc).toMatch(/node:sqlite/);
    expect(doc).toMatch(/>=22\.13/);
  });

  it("documents the stateful harness entry and its limits in README.md", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toMatch(/session_start/i);
    expect(readme).toMatch(/possession/i);
    expect(readme).toMatch(/outside-repo/i);
  });
});

describe("slice 2 end to end over fresh server instances", () => {
  it("runs start, work, stage_write, task_write, checkpoint, resume with bodies surviving root removal", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, "slice2-e2e");
    await mkdir(root, { recursive: true });
    const dbPath = path.join(base, "slice2-e2e.db");

    async function freshTurn(): Promise<Session> {
      const store = openHarnessStore({ dbPath, workspaceRoots: [root] });
      store.open();
      return connect({ workspaces: [{ name: "default", path: root }], harness: { session: true, store } });
    }

    const turn1 = await freshTurn();
    const started = await callTool(turn1, "session_start", {});
    expect(started.isError).toBe(false);
    const sessionToken = started.text.split("\n")[0]!.trim();
    const workStarted = await callTool(turn1, "work_start", { session: sessionToken });
    expect(workStarted.isError).toBe(false);
    const workToken = workStarted.text.split("\n")[0]!.trim();
    const stageBody = "slice 2 explore findings persisted externally";
    const staged = await callTool(turn1, "stage_write", {
      session: sessionToken,
      work: workToken,
      stage: "explore",
      body: stageBody,
    });
    expect(staged.isError).toBe(false);
    const artifactId = staged.text.split("\n")[0]!.trim();
    const taskBody = "- [ ] wire slice 2\n- [ ] verify slice 2";
    const tasked = await callTool(turn1, "task_write", { session: sessionToken, work: workToken, body: taskBody });
    expect(tasked.isError).toBe(false);
    const taskId = tasked.text.split("\n")[0]!.trim();
    const summary = "explore complete; spec is next";
    const checked = await callTool(turn1, "checkpoint", {
      session: sessionToken,
      work: workToken,
      completedStage: "explore",
      artifactId,
      summary,
    });
    expect(checked.isError).toBe(false);
    await close(turn1);

    const turn2 = await freshTurn();
    try {
      const resumed = await callTool(turn2, "session_resume", { session: sessionToken, work: workToken });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain(summary);
      const status = await callTool(turn2, "harness_status", { session: sessionToken, work: workToken });
      expect(status.isError).toBe(false);
      expect(status.text).toContain("currentStage: explore");
      expect(status.text).toContain("next: propose");
    } finally {
      await close(turn2);
    }

    await rm(root, { recursive: true, force: true });
    const { mkdir: mkdirAgain } = await import("node:fs/promises");
    const survivingRoot = path.join(base, "slice2-e2e-survivor");
    await mkdirAgain(survivingRoot, { recursive: true });
    const survivingStore = openHarnessStore({ dbPath, workspaceRoots: [survivingRoot] });
    survivingStore.open();
    try {
      const artifact = survivingStore.readStageArtifact(artifactId, {
        sessionId: sessionToken,
        workId: workToken,
      });
      expect(artifact.body).toBe(stageBody);
      const tasks = survivingStore.readTaskList(taskId, { sessionId: sessionToken, workId: workToken });
      expect(tasks.body).toBe(taskBody);
      const status = survivingStore.harnessStatus(sessionToken, workToken);
      expect(status.currentStage).toBe("explore");
      expect(status.next).toBe("propose");
    } finally {
      survivingStore.close();
    }
  });
});
