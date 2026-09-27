import type { MetricsSnapshot } from "./session-store.js";

/**
 * Slice B metrics formatting (change harness-operability).
 *
 * Pure rendering of {@link MetricsSnapshot} for the operator-local CLI only.
 * This module MUST stay CLI-only: it is imported by `src/index.ts` and by
 * tests, never by any MCP tool handler (`src/tools/*`, `src/server.ts`),
 * so no metric value can reach a chat-visible surface through it. Every
 * rendering carries the advisory caveat; metrics never gate behavior.
 */

/** Human-readable multi-line rendering; always ends with the advisory caveat. */
export function formatMetricsHuman(snapshot: MetricsSnapshot): string {
  const lines = [
    "harness metrics (operator-local, advisory only)",
    `coverage: ${snapshot.coverage.withCheckpoint}/${snapshot.coverage.total} stage artifacts carry a checkpoint`,
    `order: ${snapshot.order.compliant}/${snapshot.order.total} compliant transitions, ${snapshot.order.bypasses} bypasses`,
    snapshot.hygiene.oldestLiveAgeMs === null
      ? `hygiene: ${snapshot.hygiene.live} live, ${snapshot.hygiene.ended} ended`
      : `hygiene: ${snapshot.hygiene.live} live, ${snapshot.hygiene.ended} ended, oldest live age ${snapshot.hygiene.oldestLiveAgeMs}ms`,
    snapshot.cadenceMs.length === 0
      ? "cadence: no consecutive checkpoints"
      : `cadence: ${snapshot.cadenceMs
          .map((entry) => `${entry.workId} [${entry.deltasMs.map((delta) => `${delta}ms`).join(", ")}]`)
          .join("; ")}`,
    snapshot.rework.length === 0
      ? "rework: none"
      : `rework: ${snapshot.rework
          .map((entry) => `${entry.workId} ${entry.stage} x${entry.count}`)
          .join("; ")}`,
    snapshot.taskUsage.length === 0
      ? "task usage: no task rows"
      : `task usage: ${snapshot.taskUsage
          .map((entry) => `${entry.workId} ${entry.taskRows} rows`)
          .join("; ")}`,
    snapshot.advisoryCaveat,
  ];
  return lines.join("\n");
}

/** Machine-readable rendering; parses back to the originating snapshot. */
export function formatMetricsJson(snapshot: MetricsSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
