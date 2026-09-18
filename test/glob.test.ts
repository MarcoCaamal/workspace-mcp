import { describe, expect, it } from "vitest";
import { globToRegExp, matchGlob } from "../src/glob.js";

describe("globToRegExp", () => {
  it("matches * without crossing directory separators", () => {
    const regex = globToRegExp("*.ts");
    expect(regex.test("index.ts")).toBe(true);
    expect(regex.test("src/index.ts")).toBe(false);
    expect(regex.test("index.tsx")).toBe(false);
  });

  it("matches ? as a single non-separator character", () => {
    const regex = globToRegExp("file?.txt");
    expect(regex.test("file1.txt")).toBe(true);
    expect(regex.test("file12.txt")).toBe(false);
    expect(regex.test("file/.txt")).toBe(false);
  });

  it("matches ** across directories", () => {
    const regex = globToRegExp("src/**/*.ts");
    expect(regex.test("src/index.ts")).toBe(true);
    expect(regex.test("src/tools/read.ts")).toBe(true);
    expect(regex.test("src/a/b/c/deep.ts")).toBe(true);
    expect(regex.test("test/index.ts")).toBe(false);
  });

  it("matches {a,b} alternation", () => {
    const regex = globToRegExp("**/*.{js,json}");
    expect(regex.test("a.js")).toBe(true);
    expect(regex.test("src/a.json")).toBe(true);
    expect(regex.test("src/a.ts")).toBe(false);
  });

  it("matches character classes including negated ones", () => {
    const regex = globToRegExp("file[abc].txt");
    expect(regex.test("filea.txt")).toBe(true);
    expect(regex.test("filec.txt")).toBe(true);
    expect(regex.test("filed.txt")).toBe(false);

    const negated = globToRegExp("file[!abc].txt");
    expect(negated.test("filed.txt")).toBe(true);
    expect(negated.test("filea.txt")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    const regex = globToRegExp("costs(1)+.md");
    expect(regex.test("costs(1)+.md")).toBe(true);
    expect(regex.test("costs1.md")).toBe(false);
  });
});

describe("matchGlob", () => {
  it("matches patterns without a slash against the basename at any depth", () => {
    expect(matchGlob("*.ts", "src/tools/read.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/tools/read.md")).toBe(false);
  });

  it("matches patterns containing a slash against the full relative path", () => {
    expect(matchGlob("src/*.ts", "src/read.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "lib/read.ts")).toBe(false);
    expect(matchGlob("src/**/*.ts", "src/a/b/read.ts")).toBe(true);
  });

  it("treats empty and ** patterns as match-all", () => {
    expect(matchGlob("", "any/path.txt")).toBe(true);
    expect(matchGlob("**", "any/path.txt")).toBe(true);
  });

  it("normalizes leading ./ and trailing slashes", () => {
    expect(matchGlob("./src/**", "src/a/b.ts")).toBe(true);
    expect(matchGlob("src/", "src")).toBe(true);
  });
});
