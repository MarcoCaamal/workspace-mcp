import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, METRICS_BOUNDARY_SENTENCE } from "../src/server.js";
import {
  HARNESS_STAGE_CONTRACTS,
  HARNESS_STAGES,
  openHarnessStore,
  type HarnessStore,
} from "../src/session-store.js";
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
  harness?: { session?: boolean; recall?: boolean; store?: HarnessStore };
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

  it("registers the nine harness tools when the harness flag is on", async () => {
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
        "session_reopen",
        "work_start",
        "session_resume",
        "stage_write",
        "task_write",
        "checkpoint",
        "harness_status",
        "work_find",
        "work_recent",
        "feature_resume",
      ]) {
        expect(names, `expected harness tool ${expected}`).toContain(expected);
      }
      expect(names).toHaveLength(31);
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

describe("slice B metrics zero-leak wiring: never an MCP tool", () => {
  async function connectWithStore(
    dirName: string,
    extra?: { recall?: boolean; shell?: ShellConfig },
  ): Promise<Session> {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, dirName);
    await mkdir(root, { recursive: true });
    const store = openHarnessStore({ dbPath: path.join(base, `${dirName}.db`), workspaceRoots: [root] });
    store.open();
    return connect({
      workspaces: [{ name: "default", path: root }],
      shell: extra?.shell,
      harness: { session: true, recall: extra?.recall, store },
    });
  }

  async function toolNamesAndDescriptions(session: Session): Promise<{ names: string[]; descriptions: string[] }> {
    const listed = await session.client.listTools();
    return {
      names: listed.tools.map((tool) => tool.name),
      descriptions: listed.tools.map((tool) => tool.description ?? ""),
    };
  }

  it("exposes no metrics surface when the harness flag is off", async () => {
    const root = path.join(base, "metrics-off");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const session = await connect({ workspaces: [{ name: "default", path: root }] });
    try {
      const { names, descriptions } = await toolNamesAndDescriptions(session);
      expect(names).toHaveLength(19);
      for (const name of names) {
        expect(name, `tool name ${name} must not expose metrics`).not.toMatch(/metric/i);
      }
      for (const description of descriptions) {
        expect(description, "tool description must not expose metrics").not.toMatch(/metric/i);
      }
    } finally {
      await close(session);
    }
  });

  it("exposes no metrics tool under any harness/shell flag combination", async () => {
    const combos: Array<{ dir: string; extra?: { recall?: boolean; shell?: ShellConfig } }> = [
      { dir: "metrics-session" },
      { dir: "metrics-recall", extra: { recall: true } },
      {
        dir: "metrics-shell",
        extra: { shell: { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] } },
      },
      {
        dir: "metrics-all",
        extra: { recall: true, shell: { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] } },
      },
    ];
    for (const combo of combos) {
      const session = await connectWithStore(combo.dir, combo.extra);
      try {
        const { names, descriptions } = await toolNamesAndDescriptions(session);
        expect(names, `flag combo ${combo.dir} must not register harness_metrics`).not.toContain("harness_metrics");
        for (const name of names) {
          expect(name, `flag combo ${combo.dir}: tool name ${name} must not expose metrics`).not.toMatch(/metric/i);
        }
        for (const description of descriptions) {
          expect(description, `flag combo ${combo.dir}: tool description must not expose metrics`).not.toMatch(
            /metric/i,
          );
        }
      } finally {
        await close(session);
      }
    }
  });

  it("publishes exactly one static boundary sentence and no metrics query syntax in instructions", async () => {
    const root = path.join(base, "boundary-instructions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    expect(text, "harness instructions must carry the metrics boundary sentence").toContain(
      METRICS_BOUNDARY_SENTENCE,
    );
    const withoutBoundary = text.replace(METRICS_BOUNDARY_SENTENCE, "");
    expect(withoutBoundary, "instructions must not describe a metrics surface").not.toMatch(/metric/i);
    expect(withoutBoundary, "instructions must not document a metrics query path").not.toContain("--harness-metrics");
    expect(withoutBoundary, "instructions must not document metrics SQL").not.toMatch(/\bSELECT\b/i);
    expect(withoutBoundary, "instructions must not name the snapshot method").not.toContain("getMetricsSnapshot");
  });

  it("keeps every chat-visible renderer free of metric values", async () => {
    const session = await connectWithStore("metrics-renderers");
    try {
      const started = await callTool(session, "session_start", {});
      expect(started.isError).toBe(false);
      const sessionToken = started.text.split("\n")[0]!.trim();
      const workStarted = await callTool(session, "work_start", { session: sessionToken });
      expect(workStarted.isError).toBe(false);
      const workToken = workStarted.text.split("\n")[0]!.trim();
      const staged = await callTool(session, "stage_write", {
        session: sessionToken,
        work: workToken,
        stage: "explore",
        body: "explore body for leak checks",
      });
      expect(staged.isError).toBe(false);
      const artifactId = staged.text.split("\n")[0]!.trim();
      const checked = await callTool(session, "checkpoint", {
        session: sessionToken,
        work: workToken,
        completedStage: "explore",
        artifactId,
        summary: "explore complete",
      });
      expect(checked.isError).toBe(false);
      const status = await callTool(session, "harness_status", { session: sessionToken, work: workToken });
      expect(status.isError).toBe(false);
      const resumed = await callTool(session, "session_resume", { session: sessionToken, work: workToken });
      expect(resumed.isError).toBe(false);
      for (const [label, output] of [
        ["harness_status", status.text],
        ["session_resume", resumed.text],
        ["checkpoint", checked.text],
      ] as const) {
        expect(output, `${label} must not leak metric values`).not.toMatch(/coverag|order|hygiene|rework|cadence/i);
        expect(output, `${label} must not carry the advisory caveat`).not.toMatch(/advisor|gameable/i);
      }
    } finally {
      await close(session);
    }
  });

  it("keeps the boundary sentence free of tools, values, and query syntax", () => {
    expect(METRICS_BOUNDARY_SENTENCE, "boundary names categories only").toMatch(/coverage/i);
    expect(METRICS_BOUNDARY_SENTENCE).toMatch(/cadence/i);
    expect(METRICS_BOUNDARY_SENTENCE).toMatch(/hygiene/i);
    expect(METRICS_BOUNDARY_SENTENCE).toMatch(/rework/i);
    expect(METRICS_BOUNDARY_SENTENCE, "boundary redirects to the operator").toMatch(/Marco/);
    expect(METRICS_BOUNDARY_SENTENCE, "boundary names no tool").not.toMatch(/tool|harness_metrics|metric\b/i);
    expect(METRICS_BOUNDARY_SENTENCE, "boundary carries no values").not.toMatch(/\d|%|query|SELECT|--/);
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

describe("slice C continuation table: single source, no drift, zero metrics", () => {
  async function registeredToolNames(dirName: string, recall?: boolean): Promise<string[]> {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, dirName);
    await mkdir(root, { recursive: true });
    const store = openHarnessStore({
      dbPath: path.join(base, `${dirName}.db`),
      workspaceRoots: [root],
    });
    store.open();
    const session = await connect({
      workspaces: [{ name: "default", path: root }],
      harness: { session: true, recall, store },
    });
    try {
      return (await session.client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await close(session);
    }
  }

  it("keys the per-stage table exactly to HARNESS_STAGES", () => {
    expect(Object.keys(HARNESS_STAGE_CONTRACTS).sort()).toEqual([...HARNESS_STAGES].sort());
    for (const stage of HARNESS_STAGES) {
      expect(
        HARNESS_STAGE_CONTRACTS[stage].allowedActions.length,
        `stage ${stage} must allow at least one action`,
      ).toBeGreaterThan(0);
      expect(
        HARNESS_STAGE_CONTRACTS[stage].artifact.length,
        `stage ${stage} must name its artifact`,
      ).toBeGreaterThan(0);
    }
  });

  it("names only real registered tools in every stage contract", async () => {
    for (const [dir, recall] of [
      ["contracts-session", undefined],
      ["contracts-recall", true],
    ] as const) {
      const names = await registeredToolNames(dir, recall);
      for (const stage of HARNESS_STAGES) {
        for (const action of HARNESS_STAGE_CONTRACTS[stage].allowedActions) {
          expect(names, `stage ${stage}: ${action} must be a registered tool`).toContain(action);
        }
      }
    }
  });

  it("keeps enriched continuation payloads free of metric values and surfaces", () => {
    expect(JSON.stringify(HARNESS_STAGE_CONTRACTS)).not.toMatch(
      /coverag|cadence|hygiene|rework|gameable|advisor|metric|SELECT|%|harness_metrics|--harness-metrics/i,
    );
  });
});

/**
 * Slice E lifecycle v2 wiring (change harness-operability, task E.4 RED):
 * `session_reopen` is registered only under the existing `harness.session`
 * gate (no new flags), and the instructions carry the ended-state + reopen
 * boundary sentence.
 */
describe("slice E lifecycle v2 wiring: session_reopen registration gate", () => {
  it("registers session_reopen only under the harness session gate", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, "reopen-gate");
    await mkdir(root, { recursive: true });
    const store = openHarnessStore({
      dbPath: path.join(base, "reopen-gate.db"),
      workspaceRoots: [root],
    });
    store.open();
    const session = await connect({
      workspaces: [{ name: "default", path: root }],
      harness: { session: true, store },
    });
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("session_reopen");
    } finally {
      await close(session);
    }

    const offRoot = path.join(base, "reopen-gate-off");
    await mkdir(offRoot, { recursive: true });
    const off = await connect({ workspaces: [{ name: "default", path: offRoot }] });
    try {
      const names = (await off.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toHaveLength(19);
      expect(names).not.toContain("session_reopen");
    } finally {
      await close(off);
    }
  });

  it("documents the ended-state plus reopen boundary in instructions", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, "reopen-instructions");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    expect(text).toContain("session_reopen");
    expect(text).toMatch(/ended/i);
    expect(text).toMatch(/snapshot|read-only/i);
  });
});

/**
 * Slice D bootstrap hints (change harness-operability, task D.4 RED).
 *
 * `buildInstructions` surfaces the static bilingual natural-trigger hints
 * and the per-stage contract surface (derived from the single-source table).
 * Guidance only: no implicit resolution, no new registration flags.
 */
describe("slice D bootstrap hints in instructions", () => {
  it("publishes the bilingual trigger hints as documented guidance", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, "bootstrap-hints");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    expect(text).toContain("nuevo trabajo");
    expect(text).toContain("work_start");
    expect(text).toContain("continúa la sesión anterior");
    expect(text).toContain("session_resume");
    expect(text).toMatch(/explicit.*token|token.*explicit/i);
  });

  it("surfaces every stage contract from the single-source table", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = path.join(base, "bootstrap-contracts");
    await mkdir(root, { recursive: true });
    const text = instructionsWithHarness([{ name: "default", path: root }]);
    for (const stage of HARNESS_STAGES) {
      expect(text, `instructions must surface stage ${stage}`).toContain(stage);
      expect(text, `instructions must surface the ${stage} artifact`).toContain(
        HARNESS_STAGE_CONTRACTS[stage].artifact,
      );
    }
  });
});
