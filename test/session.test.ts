import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import {
  ARCHIVED_AFTER_DAYS,
  BOOTSTRAP_MAX_CHARS,
  BOOTSTRAP_SUMMARY_MAX_CHARS,
  ENVELOPE_VERSION,
  HARNESS_STAGES,
  HarnessStoreError,
  deriveSessionState,
  emitEnvelope,
  openHarnessStore,
  parseEnvelope,
  type HarnessStore,
} from "../src/session-store.js";
import { renderBootstrapBlock } from "../src/tools/recall.js";

/**
 * Store foundation (change chatgpt-workspace-harness, task 2.3).
 *
 * Unit 2 covers the engine floor plus the store schema, session/work CRUD,
 * and the token lifecycle with canonical workspace binding. Every test runs
 * against a real temp DB file in `os.tmpdir()` — never inside a fixture —
 * with real temp directories as registered workspace roots.
 *
 * Later units own the trust boundary (any-repo validation, token parentage,
 * scope validation) and checkpoint-reference rejection; this file asserts
 * only foundation behavior so those batches stay autonomous.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("harness session store foundation", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-session-"));
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

  it("exposes the seven SDD stages in order", () => {
    expect([...HARNESS_STAGES]).toEqual([
      "explore",
      "propose",
      "spec",
      "design",
      "tasks",
      "apply",
      "verify",
    ]);
  });

  it("issues unique unguessable session tokens bound to the canonical workspace", async () => {
    const first = active().startSession(rootA);
    const second = active().startSession(rootA);
    expect(first.id).toMatch(UUID_RE);
    expect(second.id).toMatch(UUID_RE);
    expect(first.id).not.toBe(second.id);
    expect(first.primaryWorkspace).toBe(await realpath(rootA));
    expect(first.endedAt).toBeNull();
    expect(typeof first.createdAt).toBe("string");
  });

  it("resolves symlinked workspace roots to their canonical path", async () => {
    const link = path.join(sandbox, "link-a");
    await symlink(rootA, link);
    const session = active().startSession(link);
    expect(session.primaryWorkspace).toBe(await realpath(rootA));
  });

  it("rejects session start for an unregistered workspace", () => {
    expect(() => active().startSession(path.join(sandbox, "nope"))).toThrowError(
      HarnessStoreError,
    );
  });

  it("closes sessions explicitly: writes reject while reads serve snapshots", () => {
    // Slice E lifecycle v2 supersedes the hard-close throw: `resume` returns
    // read-only data for ended sessions (see the Slice E suite below) while
    // writes and a second end still reject; only `reopenSession` revives.
    const session = active().startSession(rootA);
    active().endSession(session.id);
    expect(active().resume(session.id).session.id).toBe(session.id);
    expect(() => active().startWork(session.id, rootA)).toThrowError(HarnessStoreError);
    expect(() => active().endSession(session.id)).toThrowError(HarnessStoreError);
  });

  it("reports unknown sessions without creating state", () => {
    expect(() => active().resume("00000000-0000-4000-8000-000000000000")).toThrowError(
      HarnessStoreError,
    );
    expect(() => active().endSession("00000000-0000-4000-8000-000000000000")).toThrowError(
      HarnessStoreError,
    );
    expect(() =>
      active().startWork("00000000-0000-4000-8000-000000000000", rootA),
    ).toThrowError(HarnessStoreError);
  });

  it("creates distinct work tokens under one session referencing the change model", () => {
    const session = active().startSession(rootA);
    const first = active().startWork(session.id, rootA, "change-1");
    const second = active().startWork(session.id, rootA, "change-1");
    expect(first.id).toMatch(UUID_RE);
    expect(first.id).not.toBe(second.id);
    expect(first.sessionId).toBe(session.id);
    expect(second.sessionId).toBe(session.id);
    expect(first.changeId).toBe("change-1");
    const resumed = active().resume(session.id, first.id);
    expect(resumed.session.id).toBe(session.id);
    expect(resumed.work?.id).toBe(first.id);
    expect(resumed.latestCheckpoint).toBeNull();
  });

  it("keeps the same changeId distinct across two workspace roots", () => {
    const session = active().startSession(rootA);
    const inA = active().startWork(session.id, rootA, "shared-id");
    const inB = active().startWork(session.id, rootB, "shared-id");
    expect(inA.workspace).not.toBe(inB.workspace);
    expect(inA.changeId).toBe(inB.changeId);
    expect(inA.id).not.toBe(inB.id);
  });

  it("persists stage artifact bodies and returns them by external id", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const body = "# Proposal\n\nBody bytes live in the store.";
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "propose",
      body,
    });
    expect(artifact.id).toMatch(UUID_RE);
    const read = active().readStageArtifact(artifact.id, { sessionId: session.id });
    expect(read.body).toBe(body);
    expect(read.stage).toBe("propose");
  });

  it("persists the versioned envelope header inline while reading back the free body", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const body = "# Proposal\n\nEnvelope wiring check.";
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "propose",
      body,
    });
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("SELECT body FROM stage_artifacts WHERE id = ?")
        .get(artifact.id) as { body: string };
      const parsed = parseEnvelope(row.body);
      expect(parsed.header).toMatchObject({
        stage: "propose",
        sessionId: session.id,
        workId: work.id,
        artifactId: artifact.id,
        createdAt: artifact.createdAt,
        bodyLength: body.length,
      });
      expect(parsed.body).toBe(body);
    } finally {
      db.close();
    }
    expect(active().readStageArtifact(artifact.id, { sessionId: session.id }).body).toBe(
      body,
    );
  });

  it("rejects unknown stage names with the valid list", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA);
    let message = "";
    try {
      active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: null,
        stage: "deploy",
        body: "x",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("deploy");
    expect(message).toContain("explore");
  });

  it("persists task-list bodies with supersede chains", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const first = active().writeTaskList({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      body: "- [ ] 1.1 First",
      supersedes: null,
    });
    const second = active().writeTaskList({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      body: "- [x] 1.1 First\n- [ ] 1.2 Second",
      supersedes: first.id,
    });
    expect(second.supersedes).toBe(first.id);
    expect(active().readTaskList(second.id, { sessionId: session.id }).body).toContain("1.2");
    expect(active().readTaskList(first.id, { sessionId: session.id }).body).toContain("1.1");
  });

  it("retrieves stored bodies after the bound roots are deleted", async () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const stageBody = "spec body that must survive repo deletion";
    const taskBody = "task body that must survive repo deletion";
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: stageBody,
    });
    const tasks = active().writeTaskList({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      body: taskBody,
      supersedes: null,
    });
    const checkpoint = active().checkpoint({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "spec",
      artifactId: artifact.id,
      summary: "spec checkpoint summary",
    });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
    expect(active().readStageArtifact(artifact.id, { sessionId: session.id }).body).toBe(
      stageBody,
    );
    expect(active().readTaskList(tasks.id, { sessionId: session.id }).body).toBe(taskBody);
    expect(active().resume(session.id, work.id).latestCheckpoint?.summary).toBe(
      checkpoint.summary,
    );
  });

  it("reopens the same database file with sessions and bindings intact", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootB, "change-9");
    active().close();
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
    const resumed = active().resume(session.id, work.id);
    expect(resumed.session.id).toBe(session.id);
    expect(resumed.work?.workspace).toBe(work.workspace);
    expect(resumed.work?.changeId).toBe("change-9");
  });
});

describe("harness store any-repo path validation", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-dbpath-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function makeRoot(name: string): Promise<string> {
    const dir = path.join(sandbox, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function plantGitDir(dir: string): Promise<void> {
    await mkdir(path.join(dir, ".git"), { recursive: true });
  }

  function expectOpenRejected(dbCandidate: string, workspaceRoots: readonly string[]): void {
    const candidate = openHarnessStore({ dbPath: dbCandidate, workspaceRoots });
    expect(() => candidate.open()).toThrowError(HarnessStoreError);
  }

  it("aborts startup when the DB candidate sits inside a configured root", async () => {
    const root = await makeRoot("root");
    expectOpenRejected(path.join(root, "harness.db"), [root]);
  });

  it("aborts startup when the DB candidate sits inside an unconfigured repo", async () => {
    const root = await makeRoot("root");
    const other = await makeRoot("other-repo");
    await plantGitDir(other);
    expectOpenRejected(path.join(other, "nested", "harness.db"), [root]);
  });

  it("aborts startup when the DB candidate sits inside a parent repo of a configured root", async () => {
    const outer = await makeRoot("outer");
    await plantGitDir(outer);
    const inner = path.join(outer, "sub", "root");
    await mkdir(inner, { recursive: true });
    expectOpenRejected(path.join(outer, "harness.db"), [inner]);
  });

  it("aborts startup when a symlinked DB candidate escapes into a repo", async () => {
    const root = await makeRoot("root");
    const repo = await makeRoot("real-repo");
    await plantGitDir(repo);
    const link = path.join(sandbox, "link-repo");
    await symlink(repo, link);
    expectOpenRejected(path.join(link, "harness.db"), [root]);
  });

  it("aborts startup when the DB candidate sits inside a `.git`-file worktree", async () => {
    const root = await makeRoot("root");
    const worktree = await makeRoot("worktree");
    await writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere/repo/.git/worktrees/wt\n");
    expectOpenRejected(path.join(worktree, "harness.db"), [root]);
  });
});

describe("harness store isolation and scope validation", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-isolation-"));
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

  it("rejects a cross-session work token instead of re-parenting it", () => {
    const sessionA = active().startSession(rootA);
    const sessionB = active().startSession(rootB);
    const workB = active().startWork(sessionB.id, rootB, "change-1");
    expect(() =>
      active().writeStageArtifact({
        sessionId: sessionA.id,
        workId: workB.id,
        workspace: rootA,
        changeId: "change-1",
        stage: "spec",
        body: "cross-session body",
      }),
    ).toThrowError(HarnessStoreError);
    expect(() => active().resume(sessionA.id, workB.id)).toThrowError(HarnessStoreError);
    expect(() =>
      active().checkpoint({
        sessionId: sessionA.id,
        workId: workB.id,
        workspace: rootA,
        changeId: "change-1",
        completedStage: "spec",
        artifactId: "external-artifact-id",
        summary: "cross-session checkpoint",
      }),
    ).toThrowError(HarnessStoreError);
  });

  it("rejects tokenless session-scoped calls without attaching implicitly", () => {
    expect(() => active().resume("")).toThrowError(HarnessStoreError);
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "owned body",
    });
    expect(() => active().readStageArtifact(artifact.id, { sessionId: "" })).toThrowError(
      HarnessStoreError,
    );
  });

  it("rejects reads from a session that does not own the record", () => {
    const sessionA = active().startSession(rootA);
    const sessionB = active().startSession(rootB);
    const workA = active().startWork(sessionA.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "session-a body",
    });
    const tasks = active().writeTaskList({
      sessionId: sessionA.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "change-1",
      body: "- [ ] 1.1 First",
      supersedes: null,
    });
    expect(() =>
      active().readStageArtifact(artifact.id, { sessionId: sessionB.id }),
    ).toThrowError(HarnessStoreError);
    expect(() => active().readTaskList(tasks.id, { sessionId: sessionB.id })).toThrowError(
      HarnessStoreError,
    );
  });

  it("reports closed sessions without reviving them", () => {
    // Slice E lifecycle v2: `resume` serves the ended snapshot instead of
    // throwing; the session stays ended (every write below still rejects).
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    active().endSession(session.id);
    expect(active().resume(session.id, work.id).session.id).toBe(session.id);
    expect(() => active().startWork(session.id, rootA)).toThrowError(HarnessStoreError);
    expect(() =>
      active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-1",
        stage: "spec",
        body: "post-close body",
      }),
    ).toThrowError(HarnessStoreError);
  });

  it("keeps same-changeId stage artifacts distinct across workspaces", () => {
    const session = active().startSession(rootA);
    const workA = active().startWork(session.id, rootA, "shared-id");
    const workB = active().startWork(session.id, rootB, "shared-id");
    const artifactA = active().writeStageArtifact({
      sessionId: session.id,
      workId: workA.id,
      workspace: rootA,
      changeId: "shared-id",
      stage: "spec",
      body: "body for root-a",
    });
    const artifactB = active().writeStageArtifact({
      sessionId: session.id,
      workId: workB.id,
      workspace: rootB,
      changeId: "shared-id",
      stage: "spec",
      body: "body for root-b",
    });
    expect(artifactA.id).not.toBe(artifactB.id);
    const readA = active().readStageArtifact(artifactA.id, { sessionId: session.id });
    const readB = active().readStageArtifact(artifactB.id, { sessionId: session.id });
    expect(readA.body).toBe("body for root-a");
    expect(readB.body).toBe("body for root-b");
    expect(readA.workspace).not.toBe(readB.workspace);
  });
});

/**
 * Checkpoint references (change chatgpt-workspace-harness, task 2.9 RED).
 *
 * Unit 4 requires checkpoints to carry the EXTERNAL stored stage-artifact ID:
 * repo-local paths are rejected as `artifactId`, unknown artifact IDs are
 * rejected, and a checkpoint write against an unreachable store fails with an
 * explicit store-unavailable error and zero repo-local fallback.
 */
describe("harness store checkpoint references", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-checkpoint-"));
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

  it("persists a checkpoint that references the stored external artifact id", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "spec body for checkpoint reference",
    });
    const checkpoint = active().checkpoint({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      completedStage: "spec",
      artifactId: artifact.id,
      summary: "spec checkpoint summary",
    });
    expect(checkpoint.artifactId).toBe(artifact.id);
    expect(checkpoint.artifactId).not.toContain(path.sep);
    expect(active().resume(session.id, work.id).latestCheckpoint?.seq).toBe(checkpoint.seq);
  });

  it("rejects a repo-local path as the checkpoint artifact reference", async () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const repoLocalIds = [
      path.join(rootA, ".workspace-mcp", "spec.md"),
      path.join("artifacts", "spec.md"),
    ];
    for (const artifactId of repoLocalIds) {
      expect(() =>
        active().checkpoint({
          sessionId: session.id,
          workId: work.id,
          workspace: rootA,
          changeId: "change-1",
          completedStage: "spec",
          artifactId,
          summary: "checkpoint with repo-local reference",
        }),
      ).toThrowError(HarnessStoreError);
    }
    expect(active().resume(session.id, work.id).latestCheckpoint).toBeNull();
    expect(await listRepoFiles()).toEqual([]);
  });

  it("rejects a checkpoint for an unknown artifact id", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    expect(() =>
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-1",
        completedStage: "spec",
        artifactId: randomUUID(),
        summary: "checkpoint for unknown artifact",
      }),
    ).toThrowError(HarnessStoreError);
    expect(active().resume(session.id, work.id).latestCheckpoint).toBeNull();
  });

  it("fails checkpoint writes with an explicit store-unavailable error and zero repo-local fallback", async () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "spec body before store loss",
    });
    // Simulate an unreachable store at request time: the open handle is gone,
    // so the checkpoint write cannot reach SQLite.
    active().close();
    let code = "";
    try {
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-1",
        completedStage: "spec",
        artifactId: artifact.id,
        summary: "checkpoint while store unreachable",
      });
    } catch (error) {
      code = (error as HarnessStoreError).code;
    }
    expect(code).toBe("store-unavailable");
    expect(await listRepoFiles()).toEqual([]);
  });
});

/**
 * Write-path separation (change chatgpt-workspace-harness, task 2.11 RED).
 *
 * The new-harness flow MUST NOT call legacy repo writers: `src/tools/session.ts`
 * never imports `src/state.ts` / `src/changes.ts` / `src/tools/changes.ts`, the
 * full handler lifecycle writes zero new files under bound roots, and legacy
 * callers keep working unchanged with repo-local persistence intact.
 */
describe("harness write-path separation", () => {
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
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-separation-"));
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
    const client = new Client({ name: "workspace-mcp-separation-client", version: "1.0.0" });
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
    return found.sort();
  }

  it("never imports legacy repo writers in the session handler module", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "tools", "session.ts"),
      "utf8",
    );
    expect(source).not.toContain("from \"../state.js\"");
    expect(source).not.toContain("from \"../changes.js\"");
    expect(source).not.toContain("from \"./changes.js\"");
    expect(source).not.toContain("from '../state.js'");
    expect(source).not.toContain("from '../changes.js'");
    expect(source).not.toContain("from './changes.js'");
    expect(source).not.toMatch(/import\s+[^;]*state\.js/);
    expect(source).not.toMatch(/import\s+[^;]*tools\/changes\.js/);
    expect(source).not.toMatch(/require\(\s*["'][^"']*state\.js["']\s*\)/);
    expect(source).not.toMatch(/require\(\s*["'][^"']*tools\/changes\.js["']\s*\)/);
  });

  it("runs the full handler lifecycle with zero new files inside bound repos", async () => {
    const session = await connectWithHarness();
    try {
      const started = await callTool(session, "session_start", { workspace: "alpha" });
      expect(started.isError).toBe(false);
      const sessionToken = started.text.split("\n")[0] ?? "";
      expect(sessionToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const work = await callTool(session, "work_start", {
        session: sessionToken,
        workspace: "alpha",
        changeId: "change-1",
      });
      expect(work.isError).toBe(false);
      const workToken = work.text.split("\n")[0] ?? "";

      const stage = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        changeId: "change-1",
        stage: "spec",
        body: "spec body that must stay outside repos",
      });
      expect(stage.isError).toBe(false);
      const artifactId = stage.text.split("\n")[0] ?? "";

      const tasks = await callTool(session, "task_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        changeId: "change-1",
        body: "- [ ] 2.11 separation",
      });
      expect(tasks.isError).toBe(false);

      const checkpoint = await callTool(session, "checkpoint", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        changeId: "change-1",
        completedStage: "spec",
        artifactId,
        summary: "spec checkpoint summary",
      });
      expect(checkpoint.isError).toBe(false);

      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);

      const status = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(status.isError).toBe(false);

      const ended = await callTool(session, "session_end", { session: sessionToken });
      expect(ended.isError).toBe(false);

      expect(await listRepoFiles()).toEqual([]);
    } finally {
      await closeHarness(session);
    }
  });

  it("leaves legacy writers working unchanged with repo-local persistence", async () => {
    const session = await connectWithHarness();
    try {
      const created = await callTool(session, "change_create", {
        title: "Legacy Still Works",
        workspace: "alpha",
      });
      expect(created.isError).toBe(false);
      const files = await listRepoFiles();
      expect(files.some((file) => file.includes(".workspace-mcp"))).toBe(true);

      const harnessFilesBefore = files.length;
      const started = await callTool(session, "session_start", { workspace: "alpha" });
      expect(started.isError).toBe(false);
      const sessionToken = started.text.split("\n")[0] ?? "";
      const work = await callTool(session, "work_start", {
        session: sessionToken,
        workspace: "alpha",
        changeId: "legacy-change",
      });
      expect(work.isError).toBe(false);
      const filesAfter = await listRepoFiles();
      expect(filesAfter.length).toBe(harnessFilesBefore);
      expect(
        filesAfter.filter((file) => !file.includes(".workspace-mcp")).length,
      ).toBe(0);
    } finally {
      await closeHarness(session);
    }
  });
});

/**
 * Transport identity (change chatgpt-workspace-harness, task 2.13 RED).
 *
 * Continuity is by explicit session/work token only: two sessions over the same
 * tunnel identifier stay isolated, reconnect with a new tunnel identifier resumes
 * by token, a tunnel identifier alone never selects or creates a session, and an
 * authenticated transport still requires a session token (no implicit attach).
 */
describe("harness transport identity", () => {
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
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-transport-"));
    rootA = path.join(sandbox, "root-a");
    rootB = path.join(sandbox, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    dbPath = path.join(sandbox, "harness.db");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function connectTurn(): Promise<HarnessClient> {
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
    const client = new Client({ name: "workspace-mcp-transport-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    (server as unknown as { __harnessStore?: HarnessStore }).__harnessStore = store;
    return { client, server };
  }

  async function closeTurn(turn: HarnessClient): Promise<void> {
    await turn.client.close().catch(() => undefined);
    await turn.server.close().catch(() => undefined);
    (turn.server as unknown as { __harnessStore?: HarnessStore }).__harnessStore?.close();
  }

  async function callTool(
    turn: HarnessClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const result = await turn.client.callTool({ name, arguments: args });
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

  it("keeps two sessions over the same tunnel identifier isolated", async () => {
    const tunnelId = "tunnel-1";
    void tunnelId;
    const turn = await connectTurn();
    try {
      const first = await callTool(turn, "session_start", { workspace: "alpha" });
      const second = await callTool(turn, "session_start", { workspace: "alpha" });
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      const sessionA = firstLine(first.text);
      const sessionB = firstLine(second.text);
      expect(sessionA).not.toBe(sessionB);

      const workA = firstLine(
        (await callTool(turn, "work_start", { session: sessionA, workspace: "alpha" })).text,
      );
      const cross = await callTool(turn, "session_resume", {
        session: sessionB,
        work: workA,
      });
      expect(cross.isError).toBe(true);

      const statusA = await callTool(turn, "harness_status", { session: sessionA });
      const statusB = await callTool(turn, "harness_status", { session: sessionB });
      expect(statusA.isError).toBe(false);
      expect(statusB.isError).toBe(false);
      expect(statusA.text).not.toContain(sessionB);
      expect(statusB.text).not.toContain(sessionA);
    } finally {
      await closeTurn(turn);
    }
  });

  it("resumes by token after reconnecting with a new tunnel identifier", async () => {
    const firstTurn = await connectTurn();
    let sessionToken = "";
    let workToken = "";
    try {
      sessionToken = firstLine((await callTool(firstTurn, "session_start", {})).text);
      workToken = firstLine(
        (await callTool(firstTurn, "work_start", { session: sessionToken })).text,
      );
      const stage = await callTool(firstTurn, "stage_write", {
        session: sessionToken,
        work: workToken,
        stage: "explore",
        body: "explore body before reconnect",
      });
      expect(stage.isError).toBe(false);
    } finally {
      await closeTurn(firstTurn);
    }

    const secondTurn = await connectTurn();
    try {
      const resumed = await callTool(secondTurn, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain(sessionToken);
    } finally {
      await closeTurn(secondTurn);
    }
  });

  it("never selects or creates a session from the tunnel identifier alone", async () => {
    const turn = await connectTurn();
    try {
      const tokenless = await callTool(turn, "harness_status", {});
      expect(tokenless.isError).toBe(true);
      expect(tokenless.text).toMatch(/session/i);
      const resumeTokenless = await callTool(turn, "session_resume", {});
      expect(resumeTokenless.isError).toBe(true);
      expect(resumeTokenless.text).toMatch(/session/i);
    } finally {
      await closeTurn(turn);
    }
  });

  it("requires a session token even on an authenticated transport", async () => {
    const turn = await connectTurn();
    try {
      const started = await callTool(turn, "session_start", {});
      expect(started.isError).toBe(false);
      const withoutToken = await callTool(turn, "stage_write", {
        stage: "spec",
        body: "no token attached",
      });
      expect(withoutToken.isError).toBe(true);
      const statusWithoutToken = await callTool(turn, "harness_status", {});
      expect(statusWithoutToken.isError).toBe(true);
    } finally {
      await closeTurn(turn);
    }
  });
});

/**
 * Slice A envelope (change harness-operability, tasks A.1): versioned
 * single-line HTML-comment header emitted at `stage_write` and parsed at
 * `readStageArtifact`, with tolerant fallback to plain text.
 *
 * Delimiter choice (recorded at apply, design open question): the exact
 * single-line form from design —
 * `<!-- harness-envelope v1 stage="…" sessionId="…" workId="…" artifactId="…"
 * createdAt="…" bodyLength="…" -->` — is the compatibility surface.
 */
describe("harness stage-artifact envelope (pure emit/parse)", () => {
  it("round-trips all six header fields with bodyLength excluding the header", () => {
    const body = "# Design\n\nFree-form markdown body.";
    const stored = emitEnvelope(
      {
        stage: "design",
        sessionId: "11111111-1111-4111-8111-111111111111",
        workId: "22222222-2222-4222-8222-222222222222",
        artifactId: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-09-26T00:00:00.000Z",
      },
      body,
    );
    expect(ENVELOPE_VERSION).toBe(1);
    const parsed = parseEnvelope(stored);
    expect(parsed.header).not.toBeNull();
    expect(parsed.header).toMatchObject({
      stage: "design",
      sessionId: "11111111-1111-4111-8111-111111111111",
      workId: "22222222-2222-4222-8222-222222222222",
      artifactId: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-09-26T00:00:00.000Z",
      bodyLength: body.length,
    });
    expect(parsed.body).toBe(body);
    expect(parsed.header?.bodyLength).toBeLessThan(stored.length);
  });

  it("emits a single versioned HTML-comment first line", () => {
    const stored = emitEnvelope(
      {
        stage: "spec",
        sessionId: "s",
        workId: "w",
        artifactId: "a",
        createdAt: "2026-09-26T00:00:00.000Z",
      },
      "body text",
    );
    const [firstLine, ...rest] = stored.split("\n");
    expect(firstLine).toMatch(/^<!-- harness-envelope v1 .* -->$/);
    expect(rest.join("\n")).toBe("body text");
  });

  it("round-trips multiline and empty bodies byte-identically", () => {
    const multiline = "line one\n\nline two\n```\ncode\n```\n";
    const parsedMulti = parseEnvelope(
      emitEnvelope(
        {
          stage: "tasks",
          sessionId: "s",
          workId: "w",
          artifactId: "a",
          createdAt: "2026-09-26T00:00:00.000Z",
        },
        multiline,
      ),
    );
    expect(parsedMulti.body).toBe(multiline);
    expect(parsedMulti.header?.bodyLength).toBe(multiline.length);

    const parsedEmpty = parseEnvelope(
      emitEnvelope(
        {
          stage: "tasks",
          sessionId: "s",
          workId: "w",
          artifactId: "a",
          createdAt: "2026-09-26T00:00:00.000Z",
        },
        "",
      ),
    );
    expect(parsedEmpty.body).toBe("");
    expect(parsedEmpty.header?.bodyLength).toBe(0);
  });

  it("treats pre-change bodies with no header as full free text", () => {
    const legacy = "# Proposal\n\nBody bytes live in the store.";
    const parsed = parseEnvelope(legacy);
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe(legacy);
  });

  it("trusts no header field when the first line is malformed", () => {
    const malformed =
      `<!-- harness-envelope v1 stage="design" sessionId="s" -->\nReal body.`;
    const parsed = parseEnvelope(malformed);
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe(malformed);
  });

  it("falls back to full text on an unknown envelope version", () => {
    const future =
      `<!-- harness-envelope v2 stage="design" sessionId="s" workId="w" artifactId="a" createdAt="t" bodyLength="9" -->\nReal body.`;
    const parsed = parseEnvelope(future);
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe(future);
  });

  it("falls back to full text when free text merely resembles a header", () => {
    const lookalike = `<!-- harness-envelope v1 -->\nReal body.`;
    const parsed = parseEnvelope(lookalike);
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe(lookalike);
  });
});

/**
 * Slice D bootstrap (change harness-operability, task D.1 RED).
 *
 * Pure-renderer tests for `renderBootstrapBlock`: the whole block stays
 * within `BOOTSTRAP_MAX_CHARS`, the embedded summary within
 * `BOOTSTRAP_SUMMARY_MAX_CHARS` with an explicit truncation marker, small
 * sessions render complete with no marker, and the block carries the session
 * id, primary workspace, works, latest summary, next action, and the static
 * bilingual trigger hints.
 */
describe("slice D bootstrap block (pure capped renderer)", () => {
  it("pins the bootstrap caps beside the existing store caps", () => {
    expect(BOOTSTRAP_MAX_CHARS).toBe(2000);
    expect(BOOTSTRAP_SUMMARY_MAX_CHARS).toBe(500);
  });

  it("renders a small session complete with no truncation marker", () => {
    const block = renderBootstrapBlock({
      sessionId: "11111111-1111-4111-8111-111111111111",
      primaryWorkspace: "/tmp/root-a",
      works: [{ id: "22222222-2222-4222-8222-222222222222", changeId: "change-1" }],
      latestSummary: "spec checkpoint summary",
      next: "design",
    });
    expect(block.length).toBeLessThanOrEqual(BOOTSTRAP_MAX_CHARS);
    expect(block).toContain("session: 11111111-1111-4111-8111-111111111111");
    expect(block).toContain("primaryWorkspace: /tmp/root-a");
    expect(block).toContain("22222222-2222-4222-8222-222222222222");
    expect(block).toContain("change-1");
    expect(block).toContain("spec checkpoint summary");
    expect(block).toContain("next: design");
    expect(block).not.toMatch(/… \[truncated \d+ chars\]/);
  });

  it("caps an oversized summary at 500 chars with an explicit marker", () => {
    const summary = "s".repeat(1200);
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/tmp/root-a",
      works: [],
      latestSummary: summary,
      next: "explore",
    });
    expect(block.length).toBeLessThanOrEqual(BOOTSTRAP_MAX_CHARS);
    expect(block).toContain(`… [truncated 700 chars]`);
    const summaryLine = block
      .split("\n")
      .find((line) => line.startsWith("latestSummary: "));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThanOrEqual(
      "latestSummary: ".length + BOOTSTRAP_SUMMARY_MAX_CHARS + "… [truncated 700 chars]".length,
    );
    expect(summaryLine).toContain("s".repeat(BOOTSTRAP_SUMMARY_MAX_CHARS));
  });

  it("caps the whole block at 2000 chars with an explicit marker", () => {
    const works = Array.from({ length: 60 }, (_, index) => ({
      id: `work-${index}-22222222-2222-4222-8222-222222222222`,
      changeId: `change-${index}`,
    }));
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/tmp/root-a",
      works,
      latestSummary: "short summary",
      next: "explore",
    });
    expect(block.length).toBeLessThanOrEqual(BOOTSTRAP_MAX_CHARS);
    expect(block).toMatch(/… \[truncated \d+ chars\]/);
  });

  it("renders empty works and a missing summary without a marker", () => {
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/tmp/root-a",
      works: [],
      latestSummary: null,
      next: "explore",
    });
    expect(block).toContain("works: (none)");
    expect(block).toContain("latestSummary: (none)");
    expect(block).not.toMatch(/… \[truncated \d+ chars\]/);
  });

  it("carries the static bilingual natural-trigger hints", () => {
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/tmp/root-a",
      works: [],
      latestSummary: null,
      next: "explore",
    });
    expect(block).toContain("nuevo trabajo");
    expect(block).toContain("work_start");
    expect(block).toContain("continúa la sesión anterior");
    expect(block).toContain("session_resume");
  });
});

/**
 * Slice D bootstrap wiring (change harness-operability, task D.3 RED).
 *
 * `session_start` and `session_resume` append the capped block from
 * `renderBootstrapBlock` to their existing text output (JSON continuation
 * from Slice C unaffected). A tokenless turn carrying trigger-like text
 * still attaches to nothing.
 */
describe("slice D bootstrap block on start/resume", () => {
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
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-bootstrap-"));
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
    const client = new Client({ name: "workspace-mcp-bootstrap-client", version: "1.0.0" });
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

  it("appends the bootstrap block to session_start text with the token first", async () => {
    const session = await connectWithHarness();
    try {
      const started = await callTool(session, "session_start", { workspace: "alpha" });
      expect(started.isError).toBe(false);
      expect(firstLine(started.text)).toMatch(UUID_RE);
      expect(started.text).toContain("works: (none)");
      expect(started.text).toContain("latestSummary: (none)");
      expect(started.text).toContain("next: explore");
      expect(started.text).toContain("nuevo trabajo");
      expect(started.text).toContain("continúa la sesión anterior");
      expect(started.text).not.toMatch(/… \[truncated \d+ chars\]/);
    } finally {
      await closeHarness(session);
    }
  });

  it("appends the block to session_resume text with works, summary, and next", async () => {
    const session = await connectWithHarness();
    try {
      const sessionToken = firstLine((await callTool(session, "session_start", {})).text);
      const workToken = firstLine(
        (await callTool(session, "work_start", { session: sessionToken, changeId: "change-1" })).text,
      );
      const staged = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        stage: "spec",
        body: "spec body for bootstrap",
      });
      expect(staged.isError).toBe(false);
      const checked = await callTool(session, "checkpoint", {
        session: sessionToken,
        work: workToken,
        completedStage: "spec",
        artifactId: firstLine(staged.text),
        summary: "spec checkpoint summary",
      });
      expect(checked.isError).toBe(false);
      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain(`session: ${sessionToken}`);
      expect(resumed.text).toContain(workToken);
      expect(resumed.text).toContain("change-1");
      expect(resumed.text).toContain("spec checkpoint summary");
      expect(resumed.text).toContain("next: design");
      expect(resumed.text).toContain("nuevo trabajo");
      expect(resumed.text).not.toMatch(/… \[truncated \d+ chars\]/);
    } finally {
      await closeHarness(session);
    }
  });

  it("marks a truncated oversized summary in session_resume output", async () => {
    const session = await connectWithHarness();
    try {
      const sessionToken = firstLine((await callTool(session, "session_start", {})).text);
      const workToken = firstLine(
        (await callTool(session, "work_start", { session: sessionToken })).text,
      );
      const staged = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        stage: "spec",
        body: "spec body for oversized bootstrap",
      });
      expect(staged.isError).toBe(false);
      const checked = await callTool(session, "checkpoint", {
        session: sessionToken,
        work: workToken,
        completedStage: "spec",
        artifactId: firstLine(staged.text),
        summary: "s".repeat(1200),
      });
      expect(checked.isError).toBe(false);
      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain("… [truncated 700 chars]");
    } finally {
      await closeHarness(session);
    }
  });

  it("attaches a tokenless trigger-text turn to nothing", async () => {
    const session = await connectWithHarness();
    try {
      const tokenless = await callTool(session, "session_resume", {});
      expect(tokenless.isError).toBe(true);
      expect(tokenless.text).toMatch(/session/i);
    } finally {
      await closeHarness(session);
    }
  });
});

/**
 * Slice E lifecycle v2 (change harness-operability, task E.1 RED).
 *
 * Store-level contract: a second `session_end` still rejects; every write
 * (work, stage artifact, task list, checkpoint) against an ended session
 * rejects with the existing `closed-session` code plus a `session_reopen`
 * hint; `resume` on an ended session returns read-only data (never throws,
 * never marks live); `deriveSessionState` labels freshly ended sessions
 * `idle` and sessions ended longer than `ARCHIVED_AFTER_DAYS` ago
 * `archived`; `reopenSession` revives explicitly with a notice while keeping
 * `ended_at` and setting `reopened_at`; `purgeExpiredSessions` stays on the
 * `ended_at` 90-day rule with live sessions (including reopened ones) never
 * purged.
 *
 * NOTE: this supersedes the hard-close contract pinned by "closes sessions
 * explicitly and never revives them" and "reports closed sessions without
 * reviving them" above — `resume` no longer throws on ended sessions. Those
 * two tests are migrated at GREEN step E.2.
 */
describe("slice E lifecycle v2: ended writes reject, reads snapshot, reopen is explicit (store)", () => {
  let sandbox: string;
  let rootA: string;
  let rootB: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-lifecycle-"));
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

  function seedEndedSession(): { sessionId: string; workId: string } {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-1");
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-1",
      stage: "spec",
      body: "spec body for lifecycle",
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
    active().endSession(session.id);
    return { sessionId: session.id, workId: work.id };
  }

  function closedSessionCode(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      return (error as HarnessStoreError).code;
    }
    throw new Error("expected a closed-session rejection");
  }

  it("still rejects a second session_end on an ended session", () => {
    const session = active().startSession(rootA);
    active().endSession(session.id);
    expect(closedSessionCode(() => active().endSession(session.id))).toBe("closed-session");
  });

  it("rejects writes against an ended session with the closed-session code plus a session_reopen hint", () => {
    const { sessionId, workId } = seedEndedSession();
    const attempts: Array<() => unknown> = [
      () => active().startWork(sessionId, rootA, "change-2"),
      () =>
        active().writeStageArtifact({
          sessionId,
          workId,
          workspace: rootA,
          changeId: "change-1",
          stage: "design",
          body: "design body after end",
        }),
      () =>
        active().writeTaskList({
          sessionId,
          workId,
          workspace: rootA,
          changeId: "change-1",
          body: "- [ ] task after end",
          supersedes: null,
        }),
      () =>
        active().checkpoint({
          sessionId,
          workId,
          workspace: rootA,
          changeId: "change-1",
          completedStage: "spec",
          artifactId: "00000000-0000-4000-8000-000000000000",
          summary: "checkpoint after end",
        }),
    ];
    expect(attempts.length).toBe(4);
    for (const attempt of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(HarnessStoreError);
      expect((error as HarnessStoreError).code).toBe("closed-session");
      expect((error as HarnessStoreError).message).toMatch(/session_reopen/);
    }
  });

  it("returns ended resume data without marking the session live", () => {
    const { sessionId, workId } = seedEndedSession();
    const resumed = active().resume(sessionId, workId);
    expect(resumed.session.id).toBe(sessionId);
    expect(resumed.latestCheckpoint?.summary).toBe("spec checkpoint summary");
    expect(deriveSessionState(resumed.session)).toBe("idle");
    expect(closedSessionCode(() => active().startWork(sessionId, rootA))).toBe(
      "closed-session",
    );
  });

  it("labels ended sessions idle, then archived past ARCHIVED_AFTER_DAYS", () => {
    expect(ARCHIVED_AFTER_DAYS).toBe(30);
    const session = active().startSession(rootA);
    active().endSession(session.id);
    expect(deriveSessionState(active().resume(session.id).session)).toBe("idle");
    // Age the first-ended audit timestamp past the threshold with a raw
    // update (the store never rewrites ended_at itself), then read the label
    // through a fresh store instance.
    active().close();
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 31 * 86400000).toISOString(), session.id);
    } finally {
      raw.close();
    }
    const aged = openHarnessStore({ dbPath, workspaceRoots: [rootA] });
    aged.open();
    try {
      expect(deriveSessionState(aged.resume(session.id).session)).toBe("archived");
    } finally {
      aged.close();
    }
    store = openHarnessStore({ dbPath, workspaceRoots: [rootA, rootB] });
    store.open();
  });

  it("reopens explicitly with a notice while keeping ended_at and setting reopened_at", () => {
    const { sessionId } = seedEndedSession();
    const before = active().resume(sessionId).session;
    expect(before.endedAt).not.toBeNull();
    const reopened = active().reopenSession(sessionId);
    expect(reopened.notice).toMatch(/ended.*reopened/i);
    expect(reopened.session.endedAt).toBe(before.endedAt);
    expect(reopened.session.reopenedAt).not.toBeNull();
    expect(deriveSessionState(reopened.session)).toBe("live");
    const work = active().startWork(sessionId, rootA, "change-2");
    expect(work.sessionId).toBe(sessionId);
  });

  it("keeps purge on the ended_at 90-day rule with live sessions never purged", () => {
    const live = active().startSession(rootA);
    const { sessionId: endedId } = seedEndedSession();
    const reopened = active().startSession(rootA);
    active().endSession(reopened.id);
    active().reopenSession(reopened.id);
    const purged = active().purgeExpiredSessions(
      new Date(Date.now() + 120 * 86400000).toISOString(),
    );
    expect(purged).toContain(endedId);
    expect(purged).not.toContain(live.id);
    expect(purged).not.toContain(reopened.id);
    expect(deriveSessionState(active().resume(reopened.id).session)).toBe("live");
  });
});

/**
 * Slice E lifecycle v2 over the transport (change harness-operability, task
 * E.1 RED): `session_resume`/`harness_status` on ended sessions return
 * read-only snapshots (state, latest checkpoint, derived next, reopen
 * guidance) instead of throwing; `session_resume` without `session_reopen`
 * never marks the session live; `session_reopen` returns the explicit
 * ended-then-reopened notice and restores writes.
 */
describe("slice E lifecycle v2 over the transport: snapshots and session_reopen", () => {
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
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-lifecycle-transport-"));
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
    const client = new Client({ name: "workspace-mcp-lifecycle-client", version: "1.0.0" });
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

  async function startSeededSession(session: HarnessClient): Promise<{
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
      body: "spec body for lifecycle snapshots",
    });
    expect(staged.isError).toBe(false);
    const checked = await callTool(session, "checkpoint", {
      session: sessionToken,
      work: workToken,
      workspace: "alpha",
      completedStage: "spec",
      artifactId: firstLine(staged.text),
      summary: "spec checkpoint summary",
    });
    expect(checked.isError).toBe(false);
    const ended = await callTool(session, "session_end", { session: sessionToken });
    expect(ended.isError).toBe(false);
    return { sessionToken, workToken };
  }

  it("still rejects a second session_end on an ended session", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken } = await startSeededSession(session);
      const second = await callTool(session, "session_end", { session: sessionToken });
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/closed-session/);
    } finally {
      await closeHarness(session);
    }
  });

  it("rejects writes against an ended session with a session_reopen hint", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededSession(session);
      const write = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        stage: "design",
        body: "design body after end",
      });
      expect(write.isError).toBe(true);
      expect(write.text).toMatch(/closed-session/);
      expect(write.text).toMatch(/session_reopen/);
    } finally {
      await closeHarness(session);
    }
  });

  it("serves session_resume as a read-only snapshot with reopen guidance", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededSession(session);
      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.text).toContain("state: idle");
      expect(resumed.text).toContain("spec checkpoint summary");
      expect(resumed.text).toContain("next: design");
      expect(resumed.text).toMatch(/session_reopen/);
      expect(resumed.text).not.toContain("nuevo trabajo");
    } finally {
      await closeHarness(session);
    }
  });

  it("serves harness_status as a read-only snapshot with reopen guidance", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededSession(session);
      const status = await callTool(session, "harness_status", {
        session: sessionToken,
        work: workToken,
      });
      expect(status.isError).toBe(false);
      expect(status.text).toContain("state: idle");
      expect(status.text).toContain("spec checkpoint summary");
      expect(status.text).toContain("next: design");
      expect(status.text).toMatch(/session_reopen/);
    } finally {
      await closeHarness(session);
    }
  });

  it("never marks an ended session live through resume", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededSession(session);
      const resumed = await callTool(session, "session_resume", {
        session: sessionToken,
        work: workToken,
      });
      expect(resumed.isError).toBe(false);
      const write = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        stage: "design",
        body: "design body without reopen",
      });
      expect(write.isError).toBe(true);
      expect(write.text).toMatch(/closed-session/);
    } finally {
      await closeHarness(session);
    }
  });

  it("reopens through session_reopen with an explicit notice and restores writes", async () => {
    const session = await connectWithHarness();
    try {
      const { sessionToken, workToken } = await startSeededSession(session);
      const reopened = await callTool(session, "session_reopen", {
        session: sessionToken,
      });
      expect(reopened.isError).toBe(false);
      expect(reopened.text).toMatch(/ended.*reopened/i);
      const write = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        workspace: "alpha",
        stage: "design",
        body: "design body after reopen",
      });
      expect(write.isError).toBe(false);
    } finally {
      await closeHarness(session);
    }
  });
});
