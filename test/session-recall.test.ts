import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { openHarnessStore, type HarnessStore } from "../src/session-store.js";

/**
 * Slice 3 scoped recall + degraded optionals (change chatgpt-workspace-harness,
 * tasks 4.1/4.3 RED).
 *
 * Scoped-recall rule (from design): every harness FTS query REQUIRES an
 * explicit `session` token, accepts optional `work`/workspace narrowing, and
 * filters to the presented session (and work, when given) intersected with
 * the caller's authorized registered-workspace scope. Tokenless queries are
 * rejected; cross-session/work/scope rows are never returned. Legacy
 * `readNotes`/`recall` behavior stays byte-compatible.
 *
 * Degraded-optionals rule: core starts and serves session/work/recall with
 * Engram and the independent `obsidian-mcp` unreachable; recall answers from
 * the local store plus an explicit `degraded:` marker. Startup never requires
 * the optionals.
 *
 * These tests fail until task 4.2/4.4 lands scoped FTS5 recall (`checkpoint_fts`
 * + `stage_artifact_fts`), the `harness_recall` wiring through
 * `src/tools/session.ts` / `src/tools/recall.ts`, and degraded enrichment.
 */

interface Session {
  client: Client;
  server: McpServer;
}

async function connect(options: {
  workspaces: Array<{ name: string; path: string }>;
  harness?: { session?: boolean; recall?: boolean; store?: HarnessStore };
}): Promise<Session> {
  const server = createServer({
    workspaces: options.workspaces,
    version: "test",
    harness: options.harness,
  });
  const client = new Client({ name: "workspace-mcp-session-recall-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(session: Session): Promise<void> {
  await session.client.close().catch(() => undefined);
  await session.server.close().catch(() => undefined);
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

describe("scoped harness recall (store level)", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-session-recall-"));
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

  function seedTwoSessions(): {
    sessionA: string;
    workA: string;
    sessionB: string;
    workB: string;
  } {
    const sessionA = active().startSession(rootA);
    const workA = active().startWork(sessionA.id, rootA, "change-a");
    const artifactA = active().writeStageArtifact({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-a",
      stage: "spec",
      body: "alpha spec body about zebra migration",
    });
    active().checkpoint({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-a",
      completedStage: "spec",
      artifactId: artifactA.id,
      summary: "alpha checkpoint summary about zebra migration",
    });
    const sessionB = active().startSession(rootA);
    const workB = active().startWork(sessionB.id, rootA, "change-b");
    const artifactB = active().writeStageArtifact({
      sessionId: sessionB.id,
      workId: workB.id,
      workspace: rootA,
      changeId: "change-b",
      stage: "spec",
      body: "beta spec body about quarry replication",
    });
    active().checkpoint({
      sessionId: sessionB.id,
      workId: workB.id,
      workspace: rootA,
      changeId: "change-b",
      completedStage: "spec",
      artifactId: artifactB.id,
      summary: "beta checkpoint summary about quarry replication",
    });
    return { sessionA: sessionA.id, workA: workA.id, sessionB: sessionB.id, workB: workB.id };
  }

  it("never returns session-B stage rows for a session-A query", () => {
    const { sessionA, sessionB } = seedTwoSessions();
    const rowsA = active().searchStageArtifacts("zebra", { sessionId: sessionA, limit: 20 });
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((row) => row.sessionId === sessionA)).toBe(true);
    const rowsB = active().searchStageArtifacts("zebra", { sessionId: sessionB, limit: 20 });
    expect(rowsB.length).toBe(0);
  });

  it("never returns session-B checkpoint rows for a session-A query", () => {
    const { sessionA, sessionB } = seedTwoSessions();
    const rowsA = active().searchCheckpoints("zebra", { sessionId: sessionA, limit: 20 });
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((row) => row.sessionId === sessionA)).toBe(true);
    const rowsB = active().searchCheckpoints("zebra", { sessionId: sessionB, limit: 20 });
    expect(rowsB.length).toBe(0);
  });

  it("excludes sibling-work rows when work narrowing is presented", () => {
    const session = active().startSession(rootA);
    const workOne = active().startWork(session.id, rootA, "change-1");
    const workTwo = active().startWork(session.id, rootA, "change-1");
    const artifactOne = active().writeStageArtifact({
      sessionId: session.id,
      workId: workOne.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "design",
      body: "workone body about harbor lattice",
    });
    active().checkpoint({
      sessionId: session.id,
      workId: workOne.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "design",
      artifactId: artifactOne.id,
      summary: "workone summary about harbor lattice",
    });
    const artifactTwo = active().writeStageArtifact({
      sessionId: session.id,
      workId: workTwo.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "design",
      body: "worktwo body about harbor lattice",
    });
    active().checkpoint({
      sessionId: session.id,
      workId: workTwo.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "design",
      artifactId: artifactTwo.id,
      summary: "worktwo summary about harbor lattice",
    });
    const narrowed = active().searchStageArtifacts("harbor", {
      sessionId: session.id,
      workId: workOne.id,
      limit: 20,
    });
    expect(narrowed.length).toBe(1);
    expect(narrowed[0]?.workId).toBe(workOne.id);
    const narrowedCheckpoints = active().searchCheckpoints("harbor", {
      sessionId: session.id,
      workId: workTwo.id,
      limit: 20,
    });
    expect(narrowedCheckpoints.length).toBe(1);
    expect(narrowedCheckpoints[0]?.workId).toBe(workTwo.id);
  });

  it("returns nothing for an out-of-scope workspace query", () => {
    const { sessionA } = seedTwoSessions();
    const rows = active().searchStageArtifacts("zebra", {
      sessionId: sessionA,
      workspace: rootB,
      limit: 20,
    });
    expect(rows.length).toBe(0);
    const checkpoints = active().searchCheckpoints("zebra", {
      sessionId: sessionA,
      workspace: rootB,
      limit: 20,
    });
    expect(checkpoints.length).toBe(0);
  });

  it("rejects unknown-session recall at the store boundary", () => {
    seedTwoSessions();
    expect(() =>
      active().searchStageArtifacts("zebra", {
        sessionId: "00000000-0000-4000-8000-000000000000",
        limit: 20,
      }),
    ).toThrowError();
  });

  it("bounds recall limits instead of serving unbounded result sets", () => {
    const { sessionA } = seedTwoSessions();
    const rows = active().searchStageArtifacts("zebra", { sessionId: sessionA, limit: 500 });
    expect(rows.length).toBeLessThanOrEqual(50);
  });
});

describe("scoped harness recall (handler level)", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-recall-handler-"));
    rootA = path.join(sandbox, "root-a");
    await mkdir(rootA, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
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

  it("rejects tokenless harness recall instead of searching globally", async () => {
    const session = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store: active() },
    });
    try {
      const result = await callTool(session, "harness_recall", { query: "zebra", limit: 10 });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/session/i);
    } finally {
      await close(session);
    }
  });

  it("serves in-scope local results plus an explicit degraded marker", async () => {
    const harness = active();
    const started = harness.startSession(rootA);
    const work = harness.startWork(started.id, rootA, "change-1");
    const artifact = harness.writeStageArtifact({
      sessionId: started.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "recall body about apricot turbine",
    });
    harness.checkpoint({
      sessionId: started.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "spec",
      artifactId: artifact.id,
      summary: "recall summary about apricot turbine",
    });
    const session = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store: harness },
    });
    try {
      const result = await callTool(session, "harness_recall", {
        session: started.id,
        query: "apricot",
        limit: 10,
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("apricot");
      expect(result.text).toMatch(/degraded:/);
    } finally {
      await close(session);
    }
  });

  it("never leaks session-B rows through the handler scope filter", async () => {
    const harness = active();
    const sessionA = harness.startSession(rootA);
    const workA = harness.startWork(sessionA.id, rootA, "change-a");
    const artifactA = harness.writeStageArtifact({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-a",
      stage: "spec",
      body: "handler body about mandolin fresco",
    });
    harness.checkpoint({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-a",
      completedStage: "spec",
      artifactId: artifactA.id,
      summary: "handler summary about mandolin fresco",
    });
    const sessionB = harness.startSession(rootA);
    const session = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store: harness },
    });
    try {
      const result = await callTool(session, "harness_recall", {
        session: sessionB.id,
        query: "mandolin",
        limit: 10,
      });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("mandolin fresco");
    } finally {
      await close(session);
    }
  });

  it("leaves the legacy readNotes path untouched when no session is presented", async () => {
    const session = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store: active() },
    });
    try {
      const remembered = await callTool(session, "remember", { text: "legacy note about elm grove" });
      expect(remembered.isError).toBe(false);
      const result = await callTool(session, "recall", { query: "elm" });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("elm grove");
      expect(result.text).not.toMatch(/degraded:/);
    } finally {
      await close(session);
    }
  });

  it("keeps core session operations serving with optionals unreachable", async () => {
    const session = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store: active() },
    });
    try {
      const started = await callTool(session, "session_start", {});
      expect(started.isError).toBe(false);
      const token = started.text.split("\n")[0] ?? "";
      expect(token.length).toBeGreaterThan(0);
      const status = await callTool(session, "harness_status", { session: token });
      expect(status.isError).toBe(false);
      expect(status.text).toContain("explore");
    } finally {
      await close(session);
    }
  });
});

describe("recall hardening (retention and caps)", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-recall-harden-"));
    rootA = path.join(sandbox, "root-a");
    await mkdir(rootA, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
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

  it("rejects (never truncates) over-cap checkpoint summaries", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "hardening body",
    });
    expect(() =>
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-1",
        completedStage: "spec",
        artifactId: artifact.id,
        summary: "x".repeat(9000),
      }),
    ).toThrowError();
  });

  it("rejects (never truncates) over-cap stage bodies", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    expect(() =>
      active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-1",
        stage: "spec",
        body: "y".repeat(200000),
      }),
    ).toThrowError();
  });
  it("expires ended sessions past the retention window without touching live ones", () => {
    const live = active().startSession(rootA);
    const ended = active().startSession(rootA);
    active().endSession(ended.id);
    const purged = active().purgeExpiredSessions(new Date(Date.now() + 1000 * 86400 * 120).toISOString());
    expect(purged).toContain(ended.id);
    expect(purged).not.toContain(live.id);
    expect(() => active().resume(live.id)).not.toThrowError();
    expect(() => active().resume(ended.id)).toThrowError();
  });
});

describe("slice 3 end to end (task 4.6)", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-slice3-e2e-"));
    rootA = path.join(sandbox, "root-a");
    await mkdir(rootA, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
    store.open();
  });

  afterEach(async () => {
    store?.close();
    store = null;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("progresses stage_write to checkpoint to harness_status to resume to recall", async () => {
    if (store === null) {
      throw new Error("store not open");
    }
    const first = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store },
    });
    let sessionToken = "";
    let workToken = "";
    try {
      const started = await callTool(first, "session_start", {});
      expect(started.isError).toBe(false);
      sessionToken = started.text.split("\n")[0] ?? "";
      const work = await callTool(first, "work_start", { session: sessionToken, changeId: "change-1" });
      expect(work.isError).toBe(false);
      workToken = work.text.split("\n")[0] ?? "";
      const written = await callTool(first, "stage_write", {
        session: sessionToken,
        work: workToken,
        stage: "spec",
        body: "slice three spec about copper ledger",
      });
      expect(written.isError).toBe(false);
      const artifactId = written.text.split("\n")[0] ?? "";
      const marked = await callTool(first, "checkpoint", {
        session: sessionToken,
        work: workToken,
        completedStage: "spec",
        artifactId,
        summary: "slice three summary about copper ledger",
      });
      expect(marked.isError).toBe(false);
      const status = await callTool(first, "harness_status", { session: sessionToken, work: workToken });
      expect(status.isError).toBe(false);
      expect(status.text).toContain("spec");
      expect(status.text).toContain("design");
    } finally {
      await close(first);
    }

    // Fresh server instance sharing the same DB file: stateless turn resumes
    // by explicit token, then scoped recall answers from the store.
    if (store === null) {
      throw new Error("store not open");
    }
    const second = await connect({
      workspaces: [{ name: "default", path: rootA }],
      harness: { session: true, recall: true, store },
    });
    try {
      const resumed = await callTool(second, "session_resume", { session: sessionToken, work: workToken });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain("copper ledger");
      const recalled = await callTool(second, "harness_recall", {
        session: sessionToken,
        work: workToken,
        query: "copper",
        limit: 10,
      });
      expect(recalled.isError).toBe(false);
      expect(recalled.text).toContain("copper ledger");
      expect(recalled.text).toMatch(/degraded:/);
    } finally {
      await close(second);
    }
  });
});
