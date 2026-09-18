import { describe, expect, it } from "vitest";
import { applyReplacement, countOccurrences } from "../src/tools/edit.js";

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("a a a", "a")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("hello world", "world")).toBe(1);
    expect(countOccurrences("hello world", "missing")).toBe(0);
  });

  it("returns 0 for an empty needle", () => {
    expect(countOccurrences("abc", "")).toBe(0);
  });

  it("counts multi-line needles", () => {
    expect(countOccurrences("a\nb\na\nb\n", "a\nb")).toBe(2);
  });
});

describe("applyReplacement", () => {
  it("replaces only the first occurrence by default", () => {
    expect(applyReplacement("x = 1; x = 2;", "x", "y", false)).toBe("y = 1; x = 2;");
  });

  it("replaces every occurrence when replaceAll is true", () => {
    expect(applyReplacement("x = 1; x = 2;", "x", "y", true)).toBe("y = 1; y = 2;");
  });

  it("keeps dollar-sign sequences in the replacement literal", () => {
    expect(applyReplacement("value", "value", "$& $1 $$", false)).toBe("$& $1 $$");
    expect(applyReplacement("a a", "a", "$&", true)).toBe("$& $&");
  });

  it("supports deletion with an empty replacement", () => {
    expect(applyReplacement("keep-remove-keep", "-remove-", "", false)).toBe("keepkeep");
  });

  it("returns the content unchanged when the match is absent", () => {
    expect(applyReplacement("abc", "zzz", "y", false)).toBe("abc");
  });
});
