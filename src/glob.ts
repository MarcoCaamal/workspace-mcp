import path from "node:path";

/**
 * Minimal glob support: `**`, `*`, `?`, `{a,b}` and `[abc]` character classes.
 * Patterns are matched against workspace-relative paths.
 *
 * - `*` matches any run of characters except `/`
 * - `?` matches a single character except `/`
 * - `**` matches any run of characters including `/`
 * - `{a,b}` matches any of the comma-separated alternatives
 * - `[abc]`, `[a-z]`, `[!abc]` match a single character from a class
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

/**
 * Matches a workspace-relative path against a glob pattern.
 *
 * Patterns without a `/` are matched against the basename as well, so
 * `*.ts` matches `src/index.ts` (the same convention used by ripgrep -g).
 * Patterns containing a `/` are matched against the full relative path.
 */
export function matchGlob(pattern: string, relativePath: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedPath = normalizePath(relativePath);

  if (normalizedPattern === "" || normalizedPattern === "**") {
    return true;
  }

  const regex = globToRegExp(normalizedPattern);
  if (normalizedPattern.includes("/")) {
    return regex.test(normalizedPath);
  }
  return regex.test(normalizedPath) || regex.test(path.posix.basename(normalizedPath));
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function normalizePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  return normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index += 1;
        }
        if (pattern[index + 1] === "/") {
          index += 2;
          source += "(?:[^/]*/)*";
        } else {
          index += 1;
          source += ".*";
        }
      } else {
        index += 1;
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      index += 1;
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const closing = findClosingBrace(pattern, index);
      if (closing === -1) {
        index += 1;
        source += escapeRegExp(char);
        continue;
      }
      const body = pattern.slice(index + 1, closing);
      const alternatives = splitTopLevel(body);
      source += `(?:${alternatives.map((alternative) => globToRegExpSource(alternative)).join("|")})`;
      index = closing + 1;
      continue;
    }

    if (char === "[") {
      const closing = findClosingBracket(pattern, index);
      if (closing === -1) {
        index += 1;
        source += escapeRegExp(char);
        continue;
      }
      const body = pattern.slice(index + 1, closing);
      source += characterClassSource(body);
      index = closing + 1;
      continue;
    }

    source += escapeRegExp(char);
    index += 1;
  }

  return source;
}

function findClosingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findClosingBracket(pattern: string, openIndex: number): number {
  for (let index = openIndex + 1; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && index > openIndex + 1) {
      return index;
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of body) {
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function characterClassSource(body: string): string {
  if (body === "") {
    return "\\[";
  }
  const negated = body.startsWith("!") || body.startsWith("^");
  const content = (negated ? body.slice(1) : body).replace(/\\/g, "\\\\");
  return `[${negated ? "^" : ""}${content}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
