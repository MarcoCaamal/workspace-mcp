import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { openHarnessStore, type HarnessStore } from "../src/session-store.js";

/**
 * ODD skills-phase3, H1 (TDD RED): tokenless semantic continuation.
 * `work_find` (changeId/summary search), `work_recent` (activity order),
 * `feature_resume` (aggregate + requiredSkills + nextAction, no side effects).
 */

let store: HarnessStore;
let dbDir: string;
let wsA: string;
let wsB: string;

async function seedFood47(): Promise<void> {
  const s1 = store.startSession(wsA);
  const w1 = store.startWork(s1.id, wsA, "FOOD-47-order-kds");
  const a1 = store.writeStageArtifact({ sessionId: s1.id, workId: w1.id, workspace: wsA, changeId: "FOOD-47-order-kds", stage: "explore", body: "exp" });
  store.checkpoint({ sessionId: s1.id, workId: w1.id, workspace: wsA, changeId: "FOOD-47-order-kds", completedStage: "explore", artifactId: a1.id, summary: "backend explored, next design" });
  const s2 = store.startSession(wsB);
  const w2 = store.startWork(s2.id, wsB, "FOOD-47-order-kds");
  const a2 = store.writeStageArtifact({ sessionId: s2.id, workId: w2.id, workspace: wsB, changeId: "FOOD-47-order-kds", stage: "explore", body: "exp-fe" });
  store.checkpoint({ sessionId: s2.id, workId: w2.id, workspace: wsB, changeId: "FOOD-47-order-kds", completedStage: "explore", artifactId: a2.id, summary: "frontend explored" });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server: McpServer = createServer({ workspaces: [{ name: "a", path: wsA }, { name: "b", path: wsB }], version: "test", harness: { session: true, store } });
  const client = new Client({ name: "discovery-caller", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n"), isError: result.isError === true };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("semantic continuation discovery", () => {
  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-discovery-"));
    wsA = await mkdtemp(path.join(tmpdir(), "workspace-mcp-discovery-a-"));
    wsB = await mkdtemp(path.join(tmpdir(), "workspace-mcp-discovery-b-"));
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [wsA, wsB] });
    store.open();
    await seedFood47();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(wsA, { recursive: true, force: true });
    await rm(wsB, { recursive: true, force: true });
  });

  it("work_find returns both FOOD-47 works without any token", async () => {
    const { text, isError } = await callTool("work_find", { query: "FOOD-47" });
    expect(isError).toBe(false);
    expect(text).toContain("FOOD-47-order-kds");
    expect(text).toMatch(/backend explored|frontend explored/);
  });

  it("work_recent orders by activity and filters by workspace", async () => {
    const { text, isError } = await callTool("work_recent", {});
    expect(isError).toBe(false);
    expect(text).toContain("FOOD-47-order-kds");
    const filtered = await callTool("work_recent", { workspace: "b" });
    expect(filtered.isError).toBe(false);
    expect(filtered.text).toContain(wsB);
    expect(filtered.text).not.toContain(wsA);
  });

  it("feature_resume aggregates without side effects and names required skills", async () => {
    const { text, isError } = await callTool("feature_resume", { query: "FOOD-47" });
    expect(isError).toBe(false);
    expect(text).toContain("FOOD-47-order-kds");
    expect(text).toContain("sdd-propose");
    expect(text).toContain("nextAction");
  });

  it("feature_resume reports no feature explicitly when nothing matches", async () => {
    const { text, isError } = await callTool("feature_resume", { query: "NOPE-000" });
    expect(isError).toBe(true);
    expect(text).toMatch(/no feature|not found/i);
  });
});

describe("advisory fixes (H4 RED)", () => {
  let store2: HarnessStore;
  let dbDir2: string;
  let ws2: string;

  beforeAll(async () => {
    dbDir2 = await mkdtemp(path.join(tmpdir(), "workspace-mcp-discovery-h4-"));
    ws2 = await mkdtemp(path.join(tmpdir(), "workspace-mcp-discovery-h4-ws-"));
    store2 = openHarnessStore({ dbPath: path.join(dbDir2, "harness.db"), workspaceRoots: [ws2] });
    store2.open();
    const s1 = store2.startSession(ws2);
    store2.startWork(s1.id, ws2, "H4-live-one");
    const s2 = store2.startSession(ws2);
    store2.startWork(s2.id, ws2, "H4-live-two");
    const s3 = store2.startSession(ws2);
    const w3 = store2.startWork(s3.id, ws2, "H4-done");
    store2.endSession(s3.id);
    void w3;
  });

  afterAll(async () => {
    store2.close();
    await rm(dbDir2, { recursive: true, force: true });
    await rm(ws2, { recursive: true, force: true });
  });

  it("state filter applies before the limit", () => {
    const ended = store2.recentWorks({ state: "idle", limit: 1 });
    expect(ended.length).toBe(1);
    expect(ended[0]?.changeId).toBe("H4-done");
  });

  it("feature_resume header names every distinct reference", async () => {
    const server: McpServer = createServer({ workspaces: [{ name: "ws", path: ws2 }], version: "test", harness: { session: true, store: store2 } });
    const client = new Client({ name: "h4-caller", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const result = await client.callTool({ name: "feature_resume", arguments: { query: "H4-" } });
      const text = (result.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      expect(result.isError ?? false).toBe(false);
      expect(text).toContain("H4-live-one");
      expect(text).toContain("H4-done");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
