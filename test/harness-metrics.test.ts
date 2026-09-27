import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HarnessStoreError,
  openHarnessStore,
  type HarnessStore,
  type MetricsSnapshot,
} from "../src/session-store.js";
import { formatMetricsHuman, formatMetricsJson } from "../src/harness-metrics.js";

/**
 * Slice B metrics (change harness-operability, tasks B.1-B.3 RED).
 *
 * Operator-local SELECT-only snapshot over the outside-repo store: six
 * deterministic signals, empty-store zeros, rubber-stamp cadence visibility,
 * zero writes, store-unavailable failure, advisory-only semantics, and pure
 * human/JSON formatting that always carries the advisory caveat. These tests
 * fail until the `getMetricsSnapshot` store method and the
 * `src/harness-metrics.ts` formatter land; nothing here may ever become an
 * MCP tool (binding override).
 */

describe("harness metrics snapshot from the external store", () => {
  let sandbox: string;
  let rootA: string;
  let dbPath: string;
  let store: HarnessStore | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-harness-metrics-"));
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

  function rowCounts(): Record<string, number> {
    const db = new DatabaseSync(dbPath);
    try {
      const counts: Record<string, number> = {};
      for (const table of ["sessions", "works", "stage_artifacts", "harness_tasks", "checkpoints"]) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        counts[table] = row.n;
      }
      return counts;
    } finally {
      db.close();
    }
  }

  /** Seeds one work with explore+spec artifacts, both checkpointed in order. */
  function seedOrderedWork(changeId = "change-1"): { sessionId: string; workId: string } {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, changeId);
    for (const stage of ["explore", "spec"] as const) {
      const artifact = active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId,
        stage,
        body: `${stage} body for metrics`,
      });
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId,
        completedStage: stage,
        artifactId: artifact.id,
        summary: `${stage} checkpoint summary`,
      });
    }
    return { sessionId: session.id, workId: work.id };
  }

  it("returns the full six-signal snapshot deterministically across two runs", () => {
    const { sessionId, workId } = seedOrderedWork();
    seedOrderedWork("change-tmp");
    active().writeTaskList({
      sessionId,
      workId,
      workspace: rootA,
      changeId: "change-1",
      body: "- [ ] metrics task",
      supersedes: null,
    });
    const first: MetricsSnapshot = active().getMetricsSnapshot();
    const second: MetricsSnapshot = active().getMetricsSnapshot();
    expect(second).toEqual(first);
    expect(first.coverage.total).toBeGreaterThan(0);
    expect(first.coverage.withCheckpoint).toBe(first.coverage.total);
    expect(first.order.total).toBe(4);
    expect(first.order.bypasses).toBe(0);
    expect(first.order.compliant).toBe(4);
    expect(first.hygiene.live).toBe(2);
    expect(first.hygiene.ended).toBe(0);
    expect(first.hygiene.oldestLiveAgeMs).not.toBeNull();
    expect(first.cadenceMs.length).toBeGreaterThan(0);
    expect(first.taskUsage.find((entry) => entry.workId === workId)?.taskRows).toBe(1);
    expect(first.advisoryCaveat.length).toBeGreaterThan(0);
  });

  it("returns zeros on an empty store without failure", () => {
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    expect(snapshot.coverage).toEqual({ withCheckpoint: 0, total: 0 });
    expect(snapshot.order).toEqual({ compliant: 0, total: 0, bypasses: 0 });
    expect(snapshot.hygiene).toEqual({ live: 0, ended: 0, oldestLiveAgeMs: null });
    expect(snapshot.cadenceMs).toEqual([]);
    expect(snapshot.rework).toEqual([]);
    expect(snapshot.taskUsage).toEqual([]);
    expect(snapshot.advisoryCaveat.length).toBeGreaterThan(0);
  });

  it("keeps short cadence deltas visible alongside perfect coverage and order", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-rubber");
    for (const stage of ["explore", "propose", "spec"] as const) {
      const artifact = active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-rubber",
        stage,
        body: `${stage} body`,
      });
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-rubber",
        completedStage: stage,
        artifactId: artifact.id,
        summary: "done",
      });
    }
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    expect(snapshot.coverage.withCheckpoint).toBe(snapshot.coverage.total);
    expect(snapshot.coverage.total).toBe(3);
    expect(snapshot.order.bypasses).toBe(0);
    const cadence = snapshot.cadenceMs.find((entry) => entry.workId === work.id);
    expect(cadence, "rubber-stamp work must carry cadence deltas").toBeDefined();
    expect(cadence!.deltasMs).toHaveLength(2);
    for (const delta of cadence!.deltasMs) {
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(60_000);
    }
  });

  it("counts backward checkpoint transitions as bypasses", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-bypass");
    for (const stage of ["spec", "explore"] as const) {
      const artifact = active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-bypass",
        stage,
        body: `${stage} body`,
      });
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-bypass",
        completedStage: stage,
        artifactId: artifact.id,
        summary: `${stage} summary`,
      });
    }
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    expect(snapshot.order.total).toBe(2);
    expect(snapshot.order.bypasses).toBe(1);
    expect(snapshot.order.compliant).toBe(1);
  });

  it("reports repeated checkpoints for the same stage as rework", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-rework");
    for (let i = 0; i < 2; i += 1) {
      const artifact = active().writeStageArtifact({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-rework",
        stage: "spec",
        body: `spec attempt ${i}`,
      });
      active().checkpoint({
        sessionId: session.id,
        workId: work.id,
        workspace: rootA,
        changeId: "change-rework",
        completedStage: "spec",
        artifactId: artifact.id,
        summary: `spec attempt ${i}`,
      });
    }
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    expect(snapshot.rework).toContainEqual({ workId: work.id, stage: "spec", count: 2 });
  });

  it("reports live versus ended hygiene with the oldest live age", () => {
    const live = active().startSession(rootA);
    const ended = active().startSession(rootA);
    active().endSession(ended.id);
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    expect(snapshot.hygiene.live).toBe(1);
    expect(snapshot.hygiene.ended).toBe(1);
    expect(snapshot.hygiene.oldestLiveAgeMs).not.toBeNull();
    expect(snapshot.hygiene.oldestLiveAgeMs!).toBeGreaterThanOrEqual(0);
    expect(live.id.length).toBeGreaterThan(0);
  });

  it("performs zero writes against a reachable store", () => {
    seedOrderedWork();
    const before = rowCounts();
    active().getMetricsSnapshot();
    active().getMetricsSnapshot();
    expect(rowCounts()).toEqual(before);
  });

  it("fails with an explicit store-unavailable error when the store is unreachable", () => {
    const unopened = openHarnessStore({
      dbPath: path.join(sandbox, "never-opened.db"),
      workspaceRoots: [rootA],
    });
    expect(() => unopened.getMetricsSnapshot()).toThrowError(HarnessStoreError);
    try {
      unopened.getMetricsSnapshot();
      expect.unreachable("expected store-unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessStoreError);
      expect((error as HarnessStoreError).code).toBe("store-unavailable");
    }
  });

  it("never blocks stage progression on poor metrics", () => {
    const session = active().startSession(rootA);
    const work = active().startWork(session.id, rootA, "change-poor");
    const before = active().getMetricsSnapshot();
    expect(before.coverage.total).toBe(0);
    const artifact = active().writeStageArtifact({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-poor",
      stage: "explore",
      body: "explore with zero prior coverage",
    });
    const record = active().checkpoint({
      sessionId: session.id,
      workId: work.id,
      workspace: rootA,
      changeId: "change-poor",
      completedStage: "explore",
      artifactId: artifact.id,
      summary: "explore done despite poor metrics",
    });
    expect(record.seq).toBeGreaterThan(0);
  });

  it("formats human output with values and the advisory caveat", () => {
    seedOrderedWork();
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    const text = formatMetricsHuman(snapshot);
    expect(text).toContain(snapshot.advisoryCaveat);
    expect(text).toMatch(/coverage/i);
    expect(text).toMatch(/order/i);
    expect(text).toMatch(/hygiene/i);
    expect(text).toMatch(/cadence/i);
    expect(text).toMatch(/rework/i);
  });

  it("formats JSON output that parses and carries the advisory caveat", () => {
    seedOrderedWork();
    const snapshot: MetricsSnapshot = active().getMetricsSnapshot();
    const parsed = JSON.parse(formatMetricsJson(snapshot)) as MetricsSnapshot;
    expect(parsed).toEqual(snapshot);
    expect(parsed.advisoryCaveat.length).toBeGreaterThan(0);
  });
});
