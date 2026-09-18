import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "../src/server.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "../src/shell.js";
import { parseWorkspaceFlags, WorkspaceError } from "../src/workspaces.js";

interface ToolResponse {
  text: string;
  isError: boolean;
}

interface Session {
  client: Client;
  server: McpServer;
}

async function connect(options: CreateServerOptions): Promise<Session> {
  const server = createServer(options);
  const client = new Client({ name: "workspace-mcp-workspaces-test-client", version: "1.0.0" });
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

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function optionsFor(a: string, b: string, extra: Omit<Partial<CreateServerOptions>, "workspaces"> = {}): CreateServerOptions {
  return {
    workspaces: [
      { name: "a", path: a },
      { name: "b", path: b },
    ],
    version: "test",
    ...extra,
  };
}

let parent: string;

async function makePair(label: string): Promise<{ a: string; b: string }> {
  const base = path.join(parent, label);
  const a = path.join(base, "alpha");
  const b = path.join(base, "beta");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  return { a, b };
}

beforeAll(async () => {
  parent = await mkdtemp(path.join(tmpdir(), "workspace-mcp-workspaces-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("workspace_list", () => {
  let session: Session;
  let a: string;
  let b: string;

  beforeAll(async () => {
    ({ a, b } = await makePair("list"));
    await writeFile(path.join(a, "hello.txt"), "hi\n");
    session = await connect(optionsFor(a, b));
    await callTool(session, "change_create", { title: "Listed change", workspace: "a" });
  });

  afterAll(async () => {
    await close(session);
  });

  it("is read-only and needs no arguments", async () => {
    const listed = await session.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "workspace_list");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema?.required ?? []).not.toContain("workspace");
  });

  it("shows name, path, primary marker, state presence and the active change", async () => {
    const response = await callTool(session, "workspace_list", {});
    expect(response.isError).toBe(false);
    expect(response.text).toContain("Workspaces (2):");
    expect(response.text).toContain(`- a  ${await realpath(a)}  (primary)  state: present  active change: listed-change`);
    expect(response.text).toContain(`- b  ${await realpath(b)}  state: absent  active change: none`);
  });
});

describe("per-workspace isolation", () => {
  let session: Session;
  let a: string;
  let b: string;

  beforeAll(async () => {
    ({ a, b } = await makePair("isolation"));
    session = await connect(optionsFor(a, b));
  });

  afterAll(async () => {
    await close(session);
  });

  it("writes to the primary workspace by default and reads it back explicitly", async () => {
    const written = await callTool(session, "write_file", { path: "note.txt", content: "from A" });
    expect(written.isError).toBe(false);
    expect(await readFile(path.join(a, "note.txt"), "utf8")).toBe("from A");

    const explicit = await callTool(session, "read_file", { path: "note.txt", workspace: "a" });
    expect(explicit.isError).toBe(false);
    expect(explicit.text).toBe("1: from A");
  });

  it("does not see another workspace's files", async () => {
    const response = await callTool(session, "read_file", { path: "note.txt", workspace: "b" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("file not found: note.txt");
  });

  it("rejects an unknown workspace listing the available names", async () => {
    const response = await callTool(session, "read_file", { path: "note.txt", workspace: "ghost" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe('unknown workspace "ghost". Available: a, b');
  });

  it("confines paths to the selected workspace even when they are valid elsewhere", async () => {
    await writeFile(path.join(a, "only-a.txt"), "secret\n");

    const escapeB = await callTool(session, "read_file", { path: "../alpha/only-a.txt", workspace: "b" });
    expect(escapeB.isError).toBe(true);
    expect(escapeB.text).toBe("path outside workspace root: ../alpha/only-a.txt");

    const absoluteB = await callTool(session, "read_file", { path: path.join(a, "only-a.txt"), workspace: "b" });
    expect(absoluteB.isError).toBe(true);
    expect(absoluteB.text).toBe(`path outside workspace root: ${path.join(a, "only-a.txt")}`);

    const absoluteA = await callTool(session, "read_file", { path: path.join(a, "only-a.txt"), workspace: "a" });
    expect(absoluteA.isError).toBe(false);
    expect(absoluteA.text).toBe("1: secret");
  });
});

describe("state isolation", () => {
  let session: Session;

  beforeAll(async () => {
    const { a, b } = await makePair("state");
    session = await connect(optionsFor(a, b));
  });

  afterAll(async () => {
    await close(session);
  });

  it("journals mutating operations per workspace", async () => {
    await callTool(session, "write_file", { path: "a.txt", content: "A", workspace: "a" });

    const logA = await callTool(session, "work_log", { workspace: "a" });
    expect(logA.isError).toBe(false);
    expect(logA.text).toContain("write_file");
    expect(logA.text).toContain("a.txt");

    const logB = await callTool(session, "work_log", { workspace: "b" });
    expect(logB.isError).toBe(false);
    expect(logB.text).toBe("no activity recorded yet");
  });

  it("keeps notes per workspace", async () => {
    await callTool(session, "remember", { text: "alpha memory", workspace: "a" });

    const recallB = await callTool(session, "recall", { workspace: "b" });
    expect(recallB.isError).toBe(false);
    expect(recallB.text).toBe("no notes match");

    const recallA = await callTool(session, "recall", { workspace: "a" });
    expect(recallA.isError).toBe(false);
    expect(recallA.text).toContain("alpha memory");
  });

  it("keeps changes and the active change per workspace", async () => {
    const created = await callTool(session, "change_create", { title: "Alpha Work", workspace: "a" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("created change alpha-work");

    const statusB = await callTool(session, "change_status", { all: true, workspace: "b" });
    expect(statusB.isError).toBe(false);
    expect(statusB.text).toBe("no changes yet");

    const statusA = await callTool(session, "change_status", { all: true, workspace: "a" });
    expect(statusA.isError).toBe(false);
    expect(statusA.text).toContain("alpha-work");
  });
});

describe("default workspace resolution", () => {
  it("targets the first workspace when none is provided", async () => {
    const { a, b } = await makePair("default-first");
    const session = await connect(optionsFor(a, b));
    try {
      await callTool(session, "write_file", { path: "where.txt", content: "first" });
      expect(await readFile(path.join(a, "where.txt"), "utf8")).toBe("first");
      await expect(readFile(path.join(b, "where.txt"), "utf8")).rejects.toThrow();
    } finally {
      await close(session);
    }
  });

  it("honors an explicit defaultWorkspace", async () => {
    const { a, b } = await makePair("default-explicit");
    const session = await connect(optionsFor(a, b, { defaultWorkspace: "b" }));
    try {
      await callTool(session, "write_file", { path: "where.txt", content: "second" });
      expect(await readFile(path.join(b, "where.txt"), "utf8")).toBe("second");
      await expect(readFile(path.join(a, "where.txt"), "utf8")).rejects.toThrow();
    } finally {
      await close(session);
    }
  });
});

describe("parseWorkspaceFlags", () => {
  it("registers --root as the default workspace", () => {
    expect(parseWorkspaceFlags({ root: "/roots/app", cwd: "/cwd" })).toEqual([{ name: "default", path: "/roots/app" }]);
  });

  it("uses --workspace values in order, so the first is primary without a root", () => {
    const configs = parseWorkspaceFlags({ workspaces: ["one=/roots/one", "two=/roots/two"], cwd: "/cwd" });
    expect(configs.map((config) => config.name)).toEqual(["one", "two"]);
    expect(configs[0]?.path).toBe("/roots/one");
  });

  it("combines --root with additional named workspaces", () => {
    const configs = parseWorkspaceFlags({ root: "/roots/app", workspaces: ["flyadd=/roots/fly"], cwd: "/cwd" });
    expect(configs).toEqual([
      { name: "default", path: "/roots/app" },
      { name: "flyadd", path: "/roots/fly" },
    ]);
  });

  it("resolves relative paths against cwd", () => {
    const configs = parseWorkspaceFlags({ workspaces: ["rel=sub/dir"], cwd: "/cwd" });
    expect(configs[0]?.path).toBe(path.resolve("/cwd", "sub/dir"));
  });

  it("rejects duplicate names, including --root plus --workspace default", () => {
    expect(() => parseWorkspaceFlags({ root: "/roots/app", workspaces: ["default=/roots/other"], cwd: "/cwd" })).toThrow(
      WorkspaceError,
    );
    expect(() => parseWorkspaceFlags({ root: "/roots/app", workspaces: ["default=/roots/other"], cwd: "/cwd" })).toThrow(
      /duplicate workspace name "default"/,
    );
    expect(() => parseWorkspaceFlags({ workspaces: ["one=/a", "one=/b"], cwd: "/cwd" })).toThrow(
      /duplicate workspace name "one"/,
    );
  });

  it("rejects invalid names", () => {
    expect(() => parseWorkspaceFlags({ workspaces: ["Bad=/roots/bad"], cwd: "/cwd" })).toThrow(/invalid workspace name/);
    expect(() => parseWorkspaceFlags({ workspaces: ["-lead=/roots/bad"], cwd: "/cwd" })).toThrow(/invalid workspace name/);
    expect(() => parseWorkspaceFlags({ workspaces: ["=empty"], cwd: "/cwd" })).toThrow(/invalid workspace name/);
  });

  it("rejects a value without =", () => {
    expect(() => parseWorkspaceFlags({ workspaces: ["/roots/nope"], cwd: "/cwd" })).toThrow(/expected <name>=<path>/);
  });

  it("defaults to cwd as the single workspace when nothing is passed", () => {
    expect(parseWorkspaceFlags({ cwd: "/somewhere" })).toEqual([{ name: "default", path: "/somewhere" }]);
  });
});

describe("git_status per workspace", () => {
  let session: Session;
  let a: string;
  let b: string;

  beforeAll(async () => {
    ({ a, b } = await makePair("git"));
    await git(a, ["init", "-b", "main"]);
    await git(b, ["init", "-b", "feature"]);
    await git(a, ["-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"]);
    await git(b, ["-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"]);
    session = await connect(optionsFor(a, b));
  });

  afterAll(async () => {
    await close(session);
  });

  it("runs git in the selected workspace", async () => {
    const statusA = await callTool(session, "git_status", { workspace: "a" });
    expect(statusA.isError).toBe(false);
    expect(statusA.text).toContain("branch: main");

    const statusB = await callTool(session, "git_status", { workspace: "b" });
    expect(statusB.isError).toBe(false);
    expect(statusB.text).toContain("branch: feature");
  });
});

describe("run_command per workspace", () => {
  const shell: ShellConfig = { enabled: true, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };
  let session: Session;
  let b: string;

  beforeAll(async () => {
    const pair = await makePair("run");
    b = pair.b;
    await mkdir(path.join(b, "sub"), { recursive: true });
    session = await connect(optionsFor(pair.a, pair.b, { shell }));
  });

  afterAll(async () => {
    await close(session);
  });

  it("resolves cwd inside the selected workspace", async () => {
    const response = await callTool(session, "run_command", {
      command: ["node", "-e", "console.log(process.cwd())"],
      cwd: "sub",
      workspace: "b",
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain(await realpath(path.join(b, "sub")));
  });

  it("still rejects cwd escapes relative to the selected workspace", async () => {
    const response = await callTool(session, "run_command", {
      command: ["node", "-e", "console.log(process.cwd())"],
      cwd: "../alpha",
      workspace: "b",
    });
    expect(response.isError).toBe(true);
    expect(response.text).toContain("path outside workspace root");
  });
});

describe("instructions", () => {
  it("lists every workspace and only adds the workspace hint when there are several", async () => {
    const { a, b } = await makePair("instructions");

    const multi = await connect(optionsFor(a, b));
    try {
      const instructions = multi.client.getInstructions() ?? "";
      expect(instructions).toContain("Workspaces:");
      expect(instructions).toContain(`a \u2192 ${await realpath(a)} (primary)`);
      expect(instructions).toContain(`b \u2192 ${await realpath(b)}`);
      expect(instructions).toContain('Pass workspace: "<name>" to operate on a specific workspace.');
    } finally {
      await close(multi);
    }

    const single = await connect({ workspaces: [{ name: "default", path: a }], version: "test" });
    try {
      const instructions = single.client.getInstructions() ?? "";
      expect(instructions).toContain(`default \u2192 ${await realpath(a)} (primary)`);
      expect(instructions).not.toContain("Pass workspace:");
    } finally {
      await close(single);
    }
  });
});
