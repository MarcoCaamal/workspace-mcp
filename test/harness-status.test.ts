import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import {
  CONTINUATION_ENVELOPE_VERSION,
  HARNESS_STAGE_CONTRACTS,
  HARNESS_STAGES,
  HarnessStoreError,
  openHarnessStore,
  type HarnessStore,
} from "../src/session-store.js";

/**
 * Harness status + store-unavailable + restart (change chatgpt-workspace-harness,
 * tasks 2.15/2.17 RED).
 *
 * Unit 6 requires: `harness_status` derived solely from the outside-repo store
 * (missing checkpoints flagged as unverified without gating, out-of-order
 * bypasses recorded in the harness DB, legacy `change_status` byte-compatible),
 * request-time `store-unavailable` errors for EVERY write kind with zero
 * repo-local fallback, and restart-durable resume with honest unknown job
 * handles. These tests fail until task 2.16/2.18 lands the store + handler
 * implementation; legacy writers stay untouched throughout.
 */

describe("harness_status derivation from the external store", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-harness-status-"));
    rootA = path.join(sandbox, "root-a");
    rootB = path.join(sandbox, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
  });

  afterEach(async () => {
    store?.close();
    store = null;
    await rm(sandbox, { recursive: true, force: true });
  });

  function active(): HarnessStore {
    if (store === null) {
      throw new Error("store not open");
    }
    return store;
  }

  function seedSpecCheckpoint(): { sessionId: string; workId: string } {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "spec body for status derivation",
    });
    active().checkpoint({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "spec",
      artifactId: artifact.id,
      summary: "spec checkpoint summary",
    });
    return { sessionId: session.id, workId: work.id };
  }

  it("recommends explore for a fresh work item with no checkpoints", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const status = active().harnessStatus(session.id, work.id);
    expect(status.currentStage).toBeNull();
    expect(status.next).toBe("explore");
    expect(status.latestCheckpoint).toBeNull();
    expect(status.unverified).toBe(false);
    expect(status.reason.length).toBeGreaterThan(0);
  });

  it("derives the next stage solely from the latest external checkpoint", () => {
    const { sessionId, workId } = seedSpecCheckpoint();
    const status = active().harnessStatus(sessionId, workId);
    expect(status.currentStage).toBe("spec");
    expect(status.next).toBe("design");
    expect(status.reason).toContain("spec");
    expect(status.latestCheckpoint?.completedStage).toBe("spec");
    expect(status.latestCheckpoint?.summary).toBe("spec checkpoint summary");
    expect(status.unverified).toBe(false);
  });

  it("serves status from the store after the bound roots are deleted", async () => {
    const { sessionId, workId } = seedSpecCheckpoint();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    const status = active().harnessStatus(sessionId, workId);
    expect(status.currentStage).toBe("spec");
    expect(status.next).toBe("design");
  });

  it("flags a missing checkpoint as unverified without gating progress", () => {
    const { sessionId, workId } = seedSpecCheckpoint();
    active().writeStageArtifact({
      sessionId,
      workId,
      workspace: rootA,
      changeId: "change-1",
      stage: "design",
      body: "design body with no checkpoint yet",
    });
    const status = active().harnessStatus(sessionId, workId);
    expect(status.currentStage).toBe("spec");
    expect(status.next).toBe("design");
    expect(status.unverified).toBe(true);
    expect(status.reason).toMatch(/unverified/i);
  });

  it("permits out-of-order checkpoints and records the bypass in the harness DB", () => {
    const { sessionId, workId } = seedSpecCheckpoint();
    const tasksArtifact = active().writeStageArtifact({
      sessionId,
      workId,
      workspace: rootA,
      changeId: "change-1",
      stage: "tasks",
      body: "task list written before design",
    });
    const bypass = active().checkpoint({
      sessionId,
      workId,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "tasks",
      artifactId: tasksArtifact.id,
      summary: "tasks checkpoint that bypassed design",
    });
    expect(bypass.completedStage).toBe("tasks");
    const status = active().harnessStatus(sessionId, workId);
    expect(status.currentStage).toBe("tasks");
    expect(status.next).toBe("apply");
    expect(status.reason).toMatch(/bypass/i);
    const resumed = active().resume(sessionId, workId);
    expect(resumed.latestCheckpoint?.completedStage).toBe("tasks");
  });

  it("scopes status depth to the presented work item", () => {
    const session = active().startSession(rootA);
    const workA = active().startWork(session.id, rootA, "change-1");
    const workB = active().startWork(session.id, rootB, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "explore",
      body: "explore body for work A",
    });
    active().checkpoint({
      sessionId: session.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "explore",
      artifactId: artifact.id,
      summary: "explore checkpoint for work A",
    });
    expect(active().harnessStatus(session.id, workA.id).currentStage).toBe("explore");
    const statusB = active().harnessStatus(session.id, workB.id);
    expect(statusB.currentStage).toBeNull();
    expect(statusB.next).toBe("explore");
  });
});

describe("harness_status over the transport with legacy compatibility", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;

  interface HarnessClient {
    client: Client;
    server: McpServer;
  }

  interface ToolResponse {
    text: string;
    isError: boolean;
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-status-transport-"));
    rootA = path.join(sandbox, "root-a");
    rootB = path.join(sandbox, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function connectWithHarness(): Promise<HarnessClient> {
    const store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
    const server = (createServer as (...args: unknown[]) => McpServer)({
      workspaces: [
        { name: "alpha", path: rootA },
        { name: "beta", path: rootB },
      ],
      defaultWorkspace: "alpha",
      version: "test",
      harness: { session: true, store },
    } as unknown);
    const client = new Client({ name: "workspace-mcp-status-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    (server as unknown as { __harnessStore?: HarnessStore }).__harnessStore = store;
    return { client, server };
  }

  async function closeHarness(session: HarnessClient): Promise<void> {
    await session.client.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
    (session.server as unknown as { __harnessStore?: HarnessStore }).__harnessStore?.close();
  }

  async function callTool(
    session: HarnessClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const result = await session.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    return { text, isError: result.isError === true };
  }

  function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
  }

  it("reports derived status with unverified honesty and rejects tokenless calls", async () => {
    const session = await connectWithHarness();
    try {
      const started = await callTool(session, "session_start", { workspace: "alpha" });
      expect(started.isError).toBe(false);
      const sessionToken = firstLine(started.text);
      const workToken = firstLine(
        (await callTool(session, "work_start", { session: sessionToken, workspace: "alpha" }))
          .text,
      );

      const fresh = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(fresh.isError).toBe(false);
      expect(fresh.text).toContain("next: explore");
      expect(fresh.text).toContain("unverified: false");

      const stage = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        stage: "explore",
        body: "explore body that is not checkpointed yet",
      });
      expect(stage.isError).toBe(false);

      const unverified = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(unverified.isError).toBe(false);
      expect(unverified.text).toContain("unverified: true");

      const tokenless = await callTool(session, "harness_status", {});
      expect(tokenless.isError).toBe(true);
      expect(tokenless.text).toMatch(/session/i);
    } finally {
      await closeHarness(session);
    }
  });

  it("keeps legacy change_status output byte-compatible with pre-harness behavior", async () => {
    const session = await connectWithHarness();
    try {
      const created = await callTool(session, "change_create", {
        title: "Legacy Compatibility Probe",
        workspace: "alpha",
      });
      expect(created.isError).toBe(false);
      const before = await callTool(session, "change_status", { workspace: "alpha" });
      expect(before.isError).toBe(false);

      const started = await callTool(session, "session_start", { workspace: "alpha" });
      expect(started.isError).toBe(false);
      const sessionToken = firstLine(started.text);
      const workToken = firstLine(
        (await callTool(session, "work_start", { session: sessionToken, workspace: "alpha" }))
          .text,
      );
      const stage = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        stage: "spec",
        body: "harness spec body that must not leak into legacy status",
      });
      expect(stage.isError).toBe(false);
      const artifactId = firstLine(stage.text);
      const checkpoint = await callTool(session, "checkpoint", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        completedStage: "spec",
        artifactId,
        summary: "harness checkpoint invisible to legacy status",
      });
      expect(checkpoint.isError).toBe(false);

      const after = await callTool(session, "change_status", { workspace: "alpha" });
      expect(after.isError).toBe(false);
      expect(after.text).toBe(before.text);
    } finally {
      await closeHarness(session);
    }
  });
});

describe("harness store-unavailable for every write kind", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbDir: string;
  let dbPath: string;
  let store: HarnessStore | null = null;
  let sessionId = "";
  let workId = "";
  let artifactId = "";

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-unavailable-"));
    rootA = path.join(sandbox, "root-a");
    rootB = path.join(sandbox, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    dbDir = path.join(sandbox, "db");
    await mkdir(dbDir, { recursive: true });
    dbPath = path.join(dbDir, "harness.db");
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
    const session = store.startSession(rootA);
    const work = store.startWork(session.id, rootA, "change-1");
    const artifact = store.writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "spec body before the store went away",
    });
    sessionId = session.id;
    workId = work.id;
    artifactId = artifact.id;
    // Make the temp DB unreachable the way the task prescribes: rename its
    // directory out from under the open store. Every later write kind must
    // fail explicitly instead of falling back to repo-local files.
    await rename(dbDir, path.join(sandbox, "db-gone"));
  });

  afterEach(async () => {
    store?.close();
    store = null;
    await rm(sandbox, { recursive: true, force: true });
  });

  function active(): HarnessStore {
    if (store === null) {
      throw new Error("store not open");
    }
    return store;
  }

  async function listRepoFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const root of [rootA, rootB]) {
      const entries = await readdir(root, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          found.push(path.join(entry.parentPath, entry.name));
        }
      }
    }
    return found;
  }

  function expectStoreUnavailable(action: () => unknown): void {
    let code = "";
    try {
      action();
    } catch (error) {
      code = (error as HarnessStoreError).code;
    }
    expect(code).toBe("store-unavailable");
  }

  it("fails session writes with an explicit error and zero repo writes", async () => {
    expectStoreUnavailable(() => active().startSession(rootA));
    expectStoreUnavailable(() => active().endSession(sessionId));
    expect(await listRepoFiles()).toEqual([]);
  });

  it("fails work writes with an explicit error and zero repo writes", async () => {
    expectStoreUnavailable(() => active().startWork(sessionId, rootA, "change-2"));
    expect(await listRepoFiles()).toEqual([]);
  });

  it("fails stage-artifact writes with an explicit error and zero repo writes", async () => {
    expectStoreUnavailable(() =>
      active().writeStageArtifact({
        sessionId,
        workId,
        workspace: rootA,
        changeId: "change-1",
        stage: "design",
        body: "design body while the store is unreachable",
      }),
    );
    expect(await listRepoFiles()).toEqual([]);
  });

  it("fails task-list writes with an explicit error and zero repo writes", async () => {
    expectStoreUnavailable(() =>
      active().writeTaskList({
        sessionId,
        workId,
        workspace: rootA,
        changeId: "change-1",
        body: "- [ ] unreachable task",
        supersedes: null,
      }),
    );
    expect(await listRepoFiles()).toEqual([]);
  });

  it("fails checkpoint and semantic-summary writes with an explicit error and zero repo writes", async () => {
    expectStoreUnavailable(() =>
      active().checkpoint({
        sessionId,
        workId,
        workspace: rootA,
        changeId: "change-1",
        completedStage: "spec",
        artifactId,
        summary: "summary that must never fall back to a repo file",
      }),
    );
    expect(await listRepoFiles()).toEqual([]);
  });
});

describe("harness restart durability", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-restart-"));
    rootA = path.join(sandbox, "root-a");
    rootB = path.join(sandbox, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("resumes the session with bindings intact on a new store instance", () => {
    const first = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    first.open();
    const session = first.startSession(rootA);
    const work = first.startWork(session.id, rootB, "change-9");
    const artifact = first.writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootB,
      changeId: "change-9",
      stage: "spec",
      body: "spec body that must survive restart",
    });
    const checkpoint = first.checkpoint({
      sessionId: session.id,
      workId: work.id,
      workspace: rootB,
      changeId: "change-9",
      completedStage: "spec",
      artifactId: artifact.id,
      summary: "spec checkpoint before restart",
    });
    first.close();

    const second = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    second.open();
    try {
      const resumed = second.resume(session.id, work.id);
      expect(resumed.session.id).toBe(session.id);
      expect(resumed.work?.workspace).toBe(work.workspace);
      expect(resumed.work?.changeId).toBe("change-9");
      expect(resumed.latestCheckpoint?.summary).toBe(checkpoint.summary);
      const status = second.harnessStatus(session.id, work.id);
      expect(status.currentStage).toBe("spec");
      expect(status.next).toBe("design");
    } finally {
      second.close();
    }
  });

  it("reports a pre-restart job handle as unknown instead of fabricating output", async () => {
    const store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
    const server = (createServer as (...args: unknown[]) => McpServer)({
      workspaces: [{ name: "alpha", path: rootA }],
      defaultWorkspace: "alpha",
      version: "test",
      shell: { enabled: true, mode: "allowlist", allow: [] },
      harness: { session: true, store },
    } as unknown);
    const client = new Client({ name: "workspace-mcp-restart-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({
        name: "job_status",
        arguments: { jobId: "job_deadbeef" },
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      expect(result.isError).toBe(true);
      expect(text).toMatch(/unknown job id/i);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      store.close();
    }
  });
});

/**
 * Slice C continuation (change harness-operability, task C.1 RED).
 *
 * Opt-in JSON envelope on the single store derivation: default `text` output
 * stays byte-identical to pre-change behavior (golden approval tests below),
 * while explicit `format: "json"` returns a versioned envelope whose
 * `next`/`reason` equal the text derivation for the same state, with a
 * per-stage table and a capped latest checkpoint (explicit truncation marker,
 * JSON stays parseable). Enriched payloads carry NO metric values.
 */
describe("slice C continuation: opt-in JSON envelope on the single derivation", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;

  interface HarnessClient {
    client: Client;
    server: McpServer;
  }

  interface ToolResponse {
    text: string;
    isError: boolean;
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-continuation-"));
    rootA = path.join(sandbox, "root-a");
    await mkdir(rootA, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function connectWithHarness(): Promise<HarnessClient> {
    const store = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
    store.open();
    const server = (createServer as (...args: unknown[]) => McpServer)({
      workspaces: [{ name: "alpha", path: rootA }],
      defaultWorkspace: "alpha",
      version: "test",
      harness: { session: true, store },
    } as unknown);
    const client = new Client({ name: "workspace-mcp-continuation-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    (server as unknown as { __harnessStore?: HarnessStore }).__harnessStore = store;
    return { client, server };
  }

  async function closeHarness(session: HarnessClient): Promise<void> {
    await session.client.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
    (session.server as unknown as { __harnessStore?: HarnessStore }).__harnessStore?.close();
  }

  async function callTool(
    session: HarnessClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const result = await session.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    return { text, isError: result.isError === true };
  }

  function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
  }

  async function startSeededWork(session: HarnessClient, summary: string): Promise<{
    sessionToken: string;
    workToken: string;
    artifactId: string;
  }> {
    const started = await callTool(session, "session_start", { workspace: "alpha" });
    expect(started.isError).toBe(false);
    const sessionToken = firstLine(started.text);
    const workStarted = await callTool(session, "work_start", {
      session: sessionToken,
      workspace: "alpha",
      changeId: "change-1",
    });
    expect(workStarted.isError).toBe(false);
    const workToken = firstLine(workStarted.text);
    const staged = await callTool(session, "stage_write", {
      session: sessionToken,
      work: workToken,
      workspace: "alpha",
      stage: "spec",
      body: "spec body for continuation",
    });
    expect(staged.isError).toBe(false);
    const artifactId = firstLine(staged.text);
    const checked = await callTool(session, "checkpoint", {
      session: sessionToken,
      work: workToken,
      workspace: "alpha",
      completedStage: "spec",
      artifactId,
      summary,
    });
    expect(checked.isError).toBe(false);
    return { sessionToken, workToken, artifactId };
  }

  function textLines(text: string, key: string): string {
    const line = text.split("\n").find((entry) => entry.startsWith(`${key}:`));
    expect(line, `expected a ${key} line in text output`).toBeDefined();
    return (line ?? "").slice(key.length + 1).trim();
  }

  it("keeps harness_status default text byte-identical when format is omitted", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      const status = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(status.isError).toBe(false);
      expect(status.text).toBe(
        [
          `session: ${sessionToken}`,
          "currentStage: spec",
          "next: design",
          "reason: spec checkpointed; continue with design",
          "unverified: false",
          "latestCheckpoint: seq 1 stage spec",
          "summary: spec checkpoint summary",
        ].join("\n"),
      );
    } finally {
      await closeHarness(session);
    }
  });

  it("appends the Slice D bootstrap block to session_resume default text", async () => {
    // Slice D (change harness-operability) supersedes the pre-D byte-identical
    // pin for session_resume only: the handler appends the capped bootstrap
    // block carrying the session works, latest summary, and derived next.
    // harness_status default text stays byte-identical (pinned above).
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toBe(
        [
          `session: ${sessionToken}`,
          `primaryWorkspace: ${rootA}`,
          `work: ${workToken}`,
          `workWorkspace: ${rootA}`,
          "changeId: change-1",
          "latestCheckpoint: seq 1 stage spec",
          "summary: spec checkpoint summary",
          "next: design",
          `session: ${sessionToken}`,
          `primaryWorkspace: ${rootA}`,
          `works: ${workToken} (change-1)`,
          "latestSummary: spec checkpoint summary",
          "next: design",
          `triggers: "nuevo trabajo" → work_start; "continúa la sesión anterior" → session_resume with token`,
          `skills: harness_skill list to discover, harness_skill get <name> to load (work-setup, work-unit-commits, jira-task, jira-epic, cognitive-doc-design, issue-creation, comment-writer, github-pr, chained-pr, sdd-explore, sdd-propose, sdd-spec, sdd-design, sdd-tasks, sdd-apply, sdd-verify, sdd-archive)`,
          `requiredSkill: sdd-design`,
          `skillLoaded: unknown (skills directory unbound)`,
          `nextAction: harness_skill get sdd-design`,
        ].join("\n"),
      );
    } finally {
      await closeHarness(session);
    }
  });

  it("returns a versioned JSON envelope consistent with the text derivation", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken, artifactId } = await startSeededWork(
        session,
        "spec checkpoint summary",
      );
      const text = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(text.isError).toBe(false);
      const json = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
        format: "json",
      });
      expect(json.isError).toBe(false);
      const envelope = JSON.parse(json.text) as {
        version: number;
        next: string;
        reason: string;
        perStage: Array<{ stage: string; allowedActions: string[]; artifact: string }>;
        latestCheckpoint: {
          seq: number;
          completedStage: string;
          artifactId: string;
          summary: string;
          truncated: boolean;
        } | null;
      };
      expect(envelope.version).toBe(CONTINUATION_ENVELOPE_VERSION);
      expect(envelope.version).toBe(1);
      expect(envelope.next).toBe(textLines(text.text, "next"));
      expect(envelope.reason).toBe(textLines(text.text, "reason"));
      expect(envelope.perStage.map((entry) => entry.stage)).toEqual([...HARNESS_STAGES]);
      for (const entry of envelope.perStage) {
        expect(entry.allowedActions.length).toBeGreaterThan(0);
        expect(entry.artifact.length).toBeGreaterThan(0);
      }
      expect(envelope.latestCheckpoint?.seq).toBe(1);
      expect(envelope.latestCheckpoint?.completedStage).toBe("spec");
      expect(envelope.latestCheckpoint?.artifactId).toBe(artifactId);
      expect(envelope.latestCheckpoint?.summary).toBe("spec checkpoint summary");
      expect(envelope.latestCheckpoint?.truncated).toBe(false);
      expect(HARNESS_STAGE_CONTRACTS.spec.artifact.length).toBeGreaterThan(0);
    } finally {
      await closeHarness(session);
    }
  });

  it("truncates an oversized checkpoint with an explicit marker and stays parseable", async () => {
    const session = await connectWithHarness();
    try {
      const oversize = `long summary body ${"x".repeat(2500)}`;
      const { sessionToken, workToken } = await startSeededWork(session, oversize);
      const json = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
        format: "json",
      });
      expect(json.isError).toBe(false);
      const envelope = JSON.parse(json.text) as {
        latestCheckpoint: { summary: string; truncated: boolean } | null;
      };
      expect(envelope.latestCheckpoint?.truncated).toBe(true);
      expect(envelope.latestCheckpoint?.summary).toMatch(/\[truncated \d+ chars\]/);
      expect(envelope.latestCheckpoint?.summary.length).toBeLessThan(oversize.length);
    } finally {
      await closeHarness(session);
    }
  });

  it("returns session_resume JSON with next/reason equal to the text derivation", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      const text = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(text.isError).toBe(false);
      const json = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
        format: "json",
      });
      expect(json.isError).toBe(false);
      const envelope = JSON.parse(json.text) as { version: number; next: string; reason: string };
      expect(envelope.version).toBe(1);
      expect(envelope.next).toBe(textLines(text.text, "next"));
      expect(envelope.reason).toContain("spec checkpointed; continue with design");
    } finally {
      await closeHarness(session);
    }
  });

  it("carries zero metric values in enriched continuation payloads", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      for (const tool of ["harness_status", "session_resume"] as const) {
        const json = await callTool(session, tool, {
          session: sessionToken,
          work: workToken,
          format: "json",
        });
        expect(json.isError).toBe(false);
        expect(() => JSON.parse(json.text), `${tool} output must be JSON`).not.toThrow();
        expect(json.text, `${tool} JSON must carry no metric values`).not.toMatch(
          /coverag|cadence|hygiene|rework|gameable|advisor|deltasMs|taskRows|oldestLiveAgeMs|withCheckpoint|percent/i,
        );
      }
    } finally {
      await closeHarness(session);
    }
  });
});

/**
 * Slice E lifecycle v2 (change harness-operability, task E.4 RED): ended
 * snapshots on `harness_status`. Text snapshots carry the read-time state,
 * the latest checkpoint, the derived next action, and reopen guidance with
 * zero metric values; the JSON shape stays parseable and carries the state.
 */
describe("slice E lifecycle v2: ended snapshots on harness_status", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;

  interface HarnessClient {
    client: Client;
    server: McpServer;
  }

  interface ToolResponse {
    text: string;
    isError: boolean;
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-ended-status-"));
    rootA = path.join(sandbox, "root-a");
    await mkdir(rootA, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function connectWithHarness(): Promise<HarnessClient> {
    const store = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
    store.open();
    const server = (createServer as (...args: unknown[]) => McpServer)({
      workspaces: [{ name: "alpha", path: rootA }],
      defaultWorkspace: "alpha",
      version: "test",
      harness: { session: true, store },
    } as unknown);
    const client = new Client({ name: "workspace-mcp-ended-status-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    (server as unknown as { __harnessStore?: HarnessStore }).__harnessStore = store;
    return { client, server };
  }

  async function closeHarness(session: HarnessClient): Promise<void> {
    await session.client.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
    (session.server as unknown as { __harnessStore?: HarnessStore }).__harnessStore?.close();
  }

  async function callTool(
    session: HarnessClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const result = await session.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    return { text, isError: result.isError === true };
  }

  function firstLine(text: string): string {
    return (text.split("\n")[0] ?? "").trim();
  }

  async function startSeededWork(session: HarnessClient, summary: string): Promise<{
    sessionToken: string;
    workToken: string;
  }> {
    const started = await callTool(session, "session_start", { workspace: "alpha" });
    expect(started.isError).toBe(false);
    const sessionToken = firstLine(started.text);
    const workStarted = await callTool(session, "work_start", {
      session: sessionToken,
      workspace: "alpha",
      changeId: "change-1",
    });
    expect(workStarted.isError).toBe(false);
    const workToken = firstLine(workStarted.text);
    const staged = await callTool(session, "stage_write", {
      session: sessionToken,
      work: workToken,
      workspace: "alpha",
      stage: "spec",
      body: "spec body for ended snapshots",
    });
    expect(staged.isError).toBe(false);
    const checked = await callTool(session, "checkpoint", {
      session: sessionToken,
      work: workToken,
      workspace: "alpha",
      completedStage: "spec",
      artifactId: firstLine(staged.text),
      summary,
    });
    expect(checked.isError).toBe(false);
    const ended = await callTool(session, "session_end", { session: sessionToken });
    expect(ended.isError).toBe(false);
    return { sessionToken, workToken };
  }

  it("serves an ended status snapshot with state, checkpoint, next, and reopen guidance", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      const status = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(status.isError).toBe(false);
      expect(status.text).toContain("state: idle");
      expect(status.text).toContain("spec checkpoint summary");
      expect(status.text).toContain("next: design");
      expect(status.text).toMatch(/session_reopen/);
      expect(status.text, "ended snapshot must carry no metric values").not.toMatch(
        /coverag|cadence|hygiene|rework|gameable|advisor|deltasMs|taskRows|oldestLiveAgeMs|withCheckpoint|percent/i,
      );
    } finally {
      await closeHarness(session);
    }
  });

  it("serves an ended status snapshot as parseable JSON carrying the state", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededWork(session, "spec checkpoint summary");
      const text = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(text.isError).toBe(false);
      const json = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
        format: "json",
      });
      expect(json.isError).toBe(false);
      const envelope = JSON.parse(json.text) as {
        state: string;
        next: string;
        version: number;
        reopen: string;
      };
      expect(envelope.state).toBe("idle");
      expect(envelope.version).toBe(1);
      expect(envelope.next).toContain("design");
      expect(envelope.reopen).toMatch(/session_reopen/);
      expect(json.text, "ended JSON must carry no metric values").not.toMatch(
        /coverag|cadence|hygiene|rework|gameable|advisor|deltasMs|taskRows|oldestLiveAgeMs|withCheckpoint|percent/i,
      );
    } finally {
      await closeHarness(session);
    }
  });
});
