import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Engine floor (change chatgpt-workspace-harness, task 2.1).
 *
 * The harness store persists session/work/stage/task/checkpoint state in the
 * Node.js built-in `node:sqlite` module. That module is unavailable in
 * Node 22.0-22.4 and requires the experimental flag until 22.13, where it
 * becomes available unflagged but remains experimental. The package floor
 * MUST therefore be `>=22.13`, and the operator docs MUST state the floor
 * plus the experimental status.
 */
const ROOT = process.cwd();

function packageEnginesNode(): string {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  return pkg.engines?.node ?? "";
}

/** Extracts the minimum minor version from a `>=22.<minor>` range. */
function floorMinor(range: string): number | null {
  const match = range.match(/>=\s*22\.(\d+)/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

describe("engine floor for node:sqlite", () => {
  it("declares engines.node >=22.13", () => {
    const range = packageEnginesNode();
    const minor = floorMinor(range);
    expect(range, "package.json engines.node must pin the 22.13 floor").toContain("22.13");
    expect(minor, "engine floor minor must be at least 13").not.toBeNull();
    expect(minor as number).toBeGreaterThanOrEqual(13);
  });

  it("imports node:sqlite unflagged (DatabaseSync smoke)", async () => {
    const sqlite = await import("node:sqlite");
    expect(typeof sqlite.DatabaseSync).toBe("function");
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE smoke(id TEXT PRIMARY KEY); INSERT INTO smoke(id) VALUES ('ok');");
      const row = db.prepare("SELECT id FROM smoke").get() as { id: string } | undefined;
      expect(row?.id).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("documents the >=22.13 floor in the README requirements", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme, "README must state the 22.13 floor").toContain("22.13");
  });

  it("documents node:sqlite as experimental in the README", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme, "README must mention node:sqlite").toMatch(/node:sqlite/);
    expect(readme, "README must flag the experimental status").toMatch(/experimental/i);
  });
});
