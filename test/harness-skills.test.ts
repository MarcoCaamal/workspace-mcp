import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, HARNESS_CHAT_SKILLS, buildInstructions } from "../src/server.js";
import { renderBootstrapBlock } from "../src/tools/recall.js";
import { STAGE_SKILLS } from "../src/session-store.js";
import { HARNESS_STAGES } from "../src/session-store.js";
import { defaultSkillsDir, resolveSkillsDir } from "../src/config.js";
import {
  SKILL_BODY_MAX_CHARS,
  registerHarnessSkillTool,
} from "../src/tools/harness-skill.js";
import type { HarnessStore } from "../src/session-store.js";
import { openHarnessStore } from "../src/session-store.js";
import type { WorkspaceConfig } from "../src/workspaces.js";
import { WorkspaceRegistry } from "../src/workspaces.js";

/**
 * ODD harness-chat-skills, T1 (TDD RED): the linear harness chat needs its
 * own MCP-local skills folder plus a `harness_skill` list/get tool. Skills
 * live outside the repo (`~/.config/workspace-mcp/skills/`); the tool only
 * reads them. Nothing here may become repo-local state.
 */

const SETUP_BODY = `---\nname: work-setup\ndescription: "Trigger: work_start. Ask mode and delivery options."\n---\n\n# Work setup\n\nAsk interactive/automatic and single-pr/chained.\n`;
const WUC_BODY = "# Work unit commits\n\nKeep tests and docs with the unit they verify.\n";

let skillsDir: string;
let sandbox: string;

async function seedSkills(): Promise<void> {
  await mkdir(path.join(skillsDir, "work-setup"), { recursive: true });
  await writeFile(path.join(skillsDir, "work-setup", "SKILL.md"), SETUP_BODY);
  await mkdir(path.join(skillsDir, "work-unit-commits"), { recursive: true });
  await writeFile(path.join(skillsDir, "work-unit-commits", "SKILL.md"), WUC_BODY);
  await mkdir(path.join(skillsDir, "huge-skill"), { recursive: true });
  await writeFile(path.join(skillsDir, "huge-skill", "SKILL.md"), `x`.repeat(SKILL_BODY_MAX_CHARS + 500));
}

async function callSkill(skills: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server: McpServer = new McpServer({ name: "skills-red-client", version: "test" });
  registerHarnessSkillTool(server, skills);
  const client = new Client({ name: "skills-red-caller", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "harness_skill", arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return { text: content.map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("harness skills dir resolution", () => {
  it("defaults outside the repo and honors explicit config", () => {
    expect(defaultSkillsDir({})).toBe(path.join(process.env.HOME ?? "", ".config", "workspace-mcp", "skills"));
    expect(defaultSkillsDir({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/workspace-mcp/skills");
    expect(resolveSkillsDir(undefined, {})).toBe(defaultSkillsDir({}));
    expect(resolveSkillsDir("/tmp/custom-skills", {})).toBe("/tmp/custom-skills");
  });
});

describe("harness_skill tool", () => {
  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-"));
    skillsDir = path.join(sandbox, "skills");
    await mkdir(skillsDir, { recursive: true });
    await seedSkills();
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("lists seeded skill names", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "list" });
    expect(isError).toBe(false);
    expect(text).toContain("work-setup");
    expect(text).toContain("work-unit-commits");
  });

  it("returns the exact body on get", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "get", name: "work-setup" });
    expect(isError).toBe(false);
    expect(text).toBe(SETUP_BODY);
  });

  it("rejects unknown skills explicitly", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "get", name: "nope-missing" });
    expect(isError).toBe(true);
    expect(text).toMatch(/unknown skill/i);
  });

  it("rejects traversal names without touching the filesystem outside", async () => {
    for (const name of ["../escape", "a/b", ".."]) {
      const { isError } = await callSkill(skillsDir, { action: "get", name });
      expect(isError).toBe(true);
    }
  });

  it("returns empty plus hint when the dir is missing, and truncates huge bodies", async () => {
    const missing = await callSkill(path.join(sandbox, "absent"), { action: "list" });
    expect(missing.isError).toBe(false);
    expect(missing.text).toMatch(/no skills/i);
    const huge = await callSkill(skillsDir, { action: "get", name: "huge-skill" });
    expect(huge.isError).toBe(false);
    expect(huge.text).toMatch(/truncated \d+ chars/);
    expect(huge.text.length).toBeLessThanOrEqual(SKILL_BODY_MAX_CHARS + 100);
  });
});

describe("harness_skill registration gate", () => {
  let store: HarnessStore;
  let dbDir: string;
  const workspaces: WorkspaceConfig[] = [{ name: "ws", path: "" }];

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-gate-"));
    workspaces[0]!.path = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-ws-"));
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [workspaces[0]!.path] });
    store.open();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(workspaces[0]!.path, { recursive: true, force: true });
  });

  async function toolNames(harness: { session?: boolean; recall?: boolean } | undefined): Promise<string[]> {
    const server: McpServer = createServer({
      workspaces,
      version: "test",
      harness: harness === undefined ? undefined : { ...harness, store, skillsDir },
    });
    const client = new Client({ name: "skills-gate-caller", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const tools = await client.listTools();
      return tools.tools.map((tool) => tool.name);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  it("registers harness_skill only under harness.session", async () => {
    expect(await toolNames({ session: true })).toContain("harness_skill");
    expect(await toolNames(undefined)).not.toContain("harness_skill");
    expect(await toolNames({ recall: true })).not.toContain("harness_skill");
  });
});

describe("chat skills catalog in instructions", () => {
  let wsRoot: string;

  beforeAll(async () => {
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-catalog-"));
  });

  afterAll(async () => {
    await rm(wsRoot, { recursive: true, force: true });
  });

  function instructions(harness: { session?: boolean } | undefined): string {
    const registry = new WorkspaceRegistry([{ name: "ws", path: wsRoot }]);
    return buildInstructions(registry, undefined, harness);
  }

  it("lists every catalog skill with its trigger under harness.session", () => {
    const text = instructions({ session: true });
    expect(HARNESS_CHAT_SKILLS.length).toBeGreaterThan(0);
    for (const skill of HARNESS_CHAT_SKILLS) {
      expect(text).toContain(skill.name);
      expect(text).toContain(skill.trigger);
    }
    expect(text).toContain("harness_skill");
  });

  it("catalog covers all ported skills", () => {
    const names = HARNESS_CHAT_SKILLS.map((skill) => skill.name);
    for (const expected of [
      "work-setup",
      "work-unit-commits",
      "jira-task",
      "jira-epic",
      "cognitive-doc-design",
      "issue-creation",
      "comment-writer",
      "github-pr",
      "chained-pr",
      "sdd-explore",
      "sdd-propose",
      "sdd-spec",
      "sdd-design",
      "sdd-tasks",
      "sdd-apply",
      "sdd-verify",
      "sdd-archive",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("omits the catalog without harness.session", () => {
    expect(instructions(undefined)).not.toContain("Chat skills");
    expect(instructions({})).not.toContain("Chat skills");
  });

  it("bootstrap block carries the catalog on the always-visible channel", () => {
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/ws",
      works: [],
      latestSummary: null,
      next: "explore",
    });
    for (const skill of HARNESS_CHAT_SKILLS) {
      expect(block).toContain(skill.name);
    }
    expect(block).toContain("harness_skill");
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});

describe("skill load telemetry (E1 RED)", () => {
  let store: HarnessStore;
  let dbDir: string;
  let wsRoot: string;

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-loads-"));
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-loads-ws-"));
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [wsRoot] });
    store.open();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  it("stage map covers every harness stage with an sdd skill", () => {
    expect(Object.keys(STAGE_SKILLS).sort()).toEqual([...HARNESS_STAGES].sort());
    for (const stage of HARNESS_STAGES) {
      expect(STAGE_SKILLS[stage]).toBe(`sdd-${stage}`);
    }
  });

  it("records and reads back a skill load scoped to session and work", () => {
    const session = store.startSession(wsRoot);
    const work = store.startWork(session.id, wsRoot, "e1");
    expect(store.getSkillLoad(session.id, work.id, "sdd-explore")).toBeNull();
    store.recordSkillLoad({ sessionId: session.id, workId: work.id, skillName: "sdd-explore", revision: "abc123" });
    expect(store.getSkillLoad(session.id, work.id, "sdd-explore")).toMatchObject({ revision: "abc123" });
    expect(store.getSkillLoad(session.id, null, "sdd-explore")).toBeNull();
  });

  it("rejects loads against unknown sessions", () => {
    expect(() =>
      store.recordSkillLoad({ sessionId: "nope", workId: null, skillName: "sdd-explore", revision: "r" }),
    ).toThrow(/unknown session/);
  });
});

describe("skill announce + get telemetry (E2 RED)", () => {
  let store: HarnessStore;
  let dbDir: string;
  let wsRoot: string;
  let dir: string;

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-e2-"));
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-e2-ws-"));
    dir = path.join(dbDir, "skills");
    await mkdir(path.join(dir, "sdd-explore"), { recursive: true });
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), "# Explore\n\nInvestigate.\n");
    await mkdir(path.join(dir, "work-setup"), { recursive: true });
    await writeFile(path.join(dir, "work-setup", "SKILL.md"), "# Setup\n\nAsk mode.\n");
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [wsRoot] });
    store.open();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  async function startAndResume(): Promise<{ startText: string; resumeText: string; sessionId: string; workId: string }> {
    const server: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client = new Client({ name: "skill-e2-caller", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const started = await client.callTool({ name: "session_start", arguments: { workspace: "ws" } });
      const startText = (started.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      const sessionId = startText.split("\n")[0] ?? "";
      const worked = await client.callTool({ name: "work_start", arguments: { session: sessionId, workspace: "ws" } });
      const workId = ((worked.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n").split("\n")[0] ?? "").trim();
      const resumed = await client.callTool({ name: "session_resume", arguments: { session: sessionId, work: workId } });
      const resumeText = (resumed.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      return { startText, resumeText, sessionId, workId };
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  it("fresh start announces work-setup as required and not loaded", async () => {
    const { startText } = await startAndResume();
    expect(startText).toContain("requiredSkill: work-setup");
    expect(startText).toContain("skillLoaded: false");
    expect(startText).toContain("nextAction: harness_skill get work-setup");
  });

  it("records a get with session/work and announces loaded on resume", async () => {
    const { resumeText, sessionId, workId } = await startAndResume();
    expect(resumeText).toContain("requiredSkill: sdd-explore");
    expect(resumeText).toContain("skillLoaded: false");
    const server: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client = new Client({ name: "skill-e2-getter", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const got = await client.callTool({ name: "harness_skill", arguments: { action: "get", name: "sdd-explore", session: sessionId, work: workId } });
      expect(got.isError).not.toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    const server2: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client2 = new Client({ name: "skill-e2-rechecker", version: "1.0.0" });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct2), server2.connect(st2)]);
    try {
      const resumed = await client2.callTool({ name: "session_resume", arguments: { session: sessionId, work: workId } });
      const text = (resumed.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      expect(text).toContain("requiredSkill: sdd-explore");
      expect(text).toContain("skillLoaded: true");
    } finally {
      await client2.close().catch(() => undefined);
      await server2.close().catch(() => undefined);
    }
  });

  it("flags skill_updated after the file changes", async () => {
    const { sessionId, workId } = await startAndResume();
    const server: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client = new Client({ name: "skill-e2-updater", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      await client.callTool({ name: "harness_skill", arguments: { action: "get", name: "sdd-explore", session: sessionId, work: workId } });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), "# Explore\n\nInvestigate thoroughly now.\n");
    const server2: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client2 = new Client({ name: "skill-e2-rechecker2", version: "1.0.0" });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct2), server2.connect(st2)]);
    try {
      const resumed = await client2.callTool({ name: "session_resume", arguments: { session: sessionId, work: workId } });
      const text = (resumed.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      expect(text).toContain("skillLoaded: false");
      expect(text).toContain("skill_updated");
    } finally {
      await client2.close().catch(() => undefined);
      await server2.close().catch(() => undefined);
    }
  });
});

describe("skill gates on stage writes (F1 RED)", () => {
  let gated: HarnessStore;
  let plain: HarnessStore;
  let dbDir: string;
  let wsRoot: string;
  let dir: string;
  const exploreBody = "# Explore\n\nInvestigate for gates.\n";

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-gate-"));
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-gate-ws-"));
    dir = path.join(dbDir, "skills");
    await mkdir(path.join(dir, "sdd-explore"), { recursive: true });
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), exploreBody);
    const opts = { dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [wsRoot] };
    plain = openHarnessStore(opts);
    plain.open();
    gated = openHarnessStore({ ...opts, skillsDir: dir });
    gated.open();
  });

  afterAll(async () => {
    gated.close();
    plain.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  function freshWork(store: HarnessStore): { sessionId: string; workId: string } {
    const session = store.startSession(wsRoot);
    const work = store.startWork(session.id, wsRoot, "gate");
    return { sessionId: session.id, workId: work.id };
  }

  it("rejects stage_write without a loaded skill, naming the exact get call", () => {
    const { sessionId, workId } = freshWork(gated);
    let message = "";
    try {
      gated.writeStageArtifact({ sessionId, workId, workspace: wsRoot, changeId: "gate", stage: "explore", body: "b" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/skill-required/);
    expect(message).toContain("sdd-explore");
    expect(message).toContain(sessionId);
    expect(message).toContain(workId);
    expect(message).toContain("harness_skill");
  });

  it("allows stage_write after the load and rejects again after the file changes", async () => {
    const { sessionId, workId } = freshWork(gated);
    const { skillRevision } = await import("../src/session-store.js");
    gated.recordSkillLoad({ sessionId, workId, skillName: "sdd-explore", revision: skillRevision(exploreBody) });
    const artifact = gated.writeStageArtifact({ sessionId, workId, workspace: wsRoot, changeId: "gate", stage: "explore", body: "b" });
    expect(artifact.stage).toBe("explore");
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), "# Explore\n\nChanged file.\n");
    let message = "";
    try {
      gated.checkpoint({ sessionId, workId, workspace: wsRoot, changeId: "gate", completedStage: "explore", artifactId: artifact.id, summary: "s" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/skill-required/);
    expect(message).toMatch(/skill_updated/);
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), exploreBody);
  });

  it("grandfathers pre-enforcement flows: prior checkpoint plus no loads stays allowed", () => {
    const session = plain.startSession(wsRoot);
    const work = plain.startWork(session.id, wsRoot, "legacy");
    const first = plain.writeStageArtifact({ sessionId: session.id, workId: work.id, workspace: wsRoot, changeId: "legacy", stage: "explore", body: "old" });
    plain.checkpoint({ sessionId: session.id, workId: work.id, workspace: wsRoot, changeId: "legacy", completedStage: "explore", artifactId: first.id, summary: "old" });
    const second = plain.writeStageArtifact({ sessionId: session.id, workId: work.id, workspace: wsRoot, changeId: "legacy", stage: "explore", body: "older" });
    const again = gated.checkpoint({ sessionId: session.id, workId: work.id, workspace: wsRoot, changeId: "legacy", completedStage: "explore", artifactId: second.id, summary: "older" });
    expect(again.completedStage).toBe("explore");
  });

  it("leaves unconfigured stores on Phase-0 behavior", () => {
    const { sessionId, workId } = freshWork(plain);
    const artifact = plain.writeStageArtifact({ sessionId, workId, workspace: wsRoot, changeId: "plain", stage: "explore", body: "b" });
    const done = plain.checkpoint({ sessionId, workId, workspace: wsRoot, changeId: "plain", completedStage: "explore", artifactId: artifact.id, summary: "s" });
    expect(done.completedStage).toBe("explore");
  });
});

describe("skill gate surfacing over MCP (F2)", () => {
  let store: HarnessStore;
  let dbDir: string;
  let wsRoot: string;
  let dir: string;

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-f2-"));
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skill-f2-ws-"));
    dir = path.join(dbDir, "skills");
    await mkdir(path.join(dir, "sdd-explore"), { recursive: true });
    await writeFile(path.join(dir, "sdd-explore", "SKILL.md"), "# Explore\n\nF2.\n");
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [wsRoot], skillsDir: dir });
    store.open();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  it("stage_write rejection carries the exact harness_skill get invocation", async () => {
    const server: McpServer = createServer({ workspaces: [{ name: "ws", path: wsRoot }], version: "test", harness: { session: true, store, skillsDir: dir } });
    const client = new Client({ name: "skill-f2-caller", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const started = await client.callTool({ name: "session_start", arguments: { workspace: "ws" } });
      const sessionId = ((started.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n").split("\n")[0] ?? "").trim();
      const worked = await client.callTool({ name: "work_start", arguments: { session: sessionId, workspace: "ws" } });
      const workId = ((worked.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n").split("\n")[0] ?? "").trim();
      const written = await client.callTool({ name: "stage_write", arguments: { session: sessionId, work: workId, workspace: "ws", stage: "explore", body: "unloaded" } });
      const text = (written.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
      expect(written.isError).toBe(true);
      expect(text).toContain('harness_skill { action: "get", name: "sdd-explore"');
      expect(text).toContain(sessionId);
      expect(text).toContain(workId);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
