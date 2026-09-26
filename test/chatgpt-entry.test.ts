import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Slice 1 entry-docs honesty (change chatgpt-workspace-harness, tasks 1.1-1.2).
 *
 * The guided ChatGPT entry documents the legacy-tool flow. It MUST disclose
 * that the legacy writers create repo-local state, and MUST NOT promise the
 * no-artifacts workflow for that flow: the no-artifacts promise is delayed
 * until the first stateful slice.
 */
const ENTRY_DOC = path.join(process.cwd(), "docs", "CHATGPT_ENTRY.md");

function entryDoc(): string {
  return readFileSync(ENTRY_DOC, "utf8");
}

describe("Slice 1 entry docs honesty", () => {
  it("discloses that the legacy writers create repo-local state", () => {
    const doc = entryDoc();
    for (const tool of ["change_create", "change_doc", "task_add", "work_log", "remember"]) {
      expect(doc, `entry doc must name legacy writer ${tool}`).toContain(tool);
    }
    expect(doc).toContain("<root>/.workspace-mcp/");
    expect(doc).toMatch(/repo-local/i);
  });

  it("makes no no-artifacts promise for the legacy-tool flow", () => {
    const doc = entryDoc();
    expect(doc).not.toMatch(/artifact-free/i);
    expect(doc).not.toMatch(/without creating (any )?artifacts?/i);
    expect(doc).not.toMatch(/leaves? no artifacts?/i);
    expect(doc).not.toMatch(/creates? no files? (inside|in) (any|the|a) (repo|workspace)/i);
  });

  it("delays the no-artifacts promise to the stateful slice", () => {
    const doc = entryDoc();
    expect(doc).toMatch(/no-artifacts workflow is not available in this slice/i);
  });

  it("states that shell ships disabled with explicit opt-in only", () => {
    const doc = entryDoc();
    expect(doc).toMatch(/disabled by default/i);
    expect(doc).toContain("--shell");
  });

  it("is linked from the README guided-entry section", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("docs/CHATGPT_ENTRY.md");
  });

  it("states that no workspace is ever guessed when none is configured", () => {
    const doc = entryDoc();
    expect(doc).toMatch(/never guesses/i);
  });
});

describe("chatgpt tunnel preset", () => {
  const script = path.join(process.cwd(), "scripts", "tunnel.sh");
  let sandbox: string;

  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-preset-"));
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  /** Runs tunnel.sh far enough to hit argument validation (no tunnel-client needed). */
  function runPreset(args: string[]): { exit: number; stderr: string } {
    try {
      execFileSync("bash", [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: sandbox, HOME: sandbox },
      });
      return { exit: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { exit: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
    }
  }

  it("rejects an unknown preset name", () => {
    const result = runPreset(["--preset", "nope", "--root", sandbox]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/unknown preset/i);
  });

  it("rejects more than one workspace under the single-workspace preset", () => {
    const result = runPreset(["--preset", "chatgpt", "--workspace", "a=/x", "--workspace", "b=/y"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/exactly one workspace/i);
  });

  it("requires an explicit primary workspace source for the preset", () => {
    const result = runPreset(["--preset", "chatgpt"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/--preset chatgpt needs/i);
  });
});
