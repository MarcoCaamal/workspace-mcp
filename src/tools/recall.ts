import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNotes } from "../state.js";
import {
  BOOTSTRAP_MAX_CHARS,
  BOOTSTRAP_SUMMARY_MAX_CHARS,
} from "../session-store.js";
import type { CheckpointRecord, StageArtifactRecord } from "../session-store.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

export function registerRecallTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "recall",
    {
      title: "Recall notes",
      description:
        "Read the persistent notes saved with remember for this workspace, newest first. " +
        "Call it at the start of a session together with work_log to recover context from previous chats. " +
        "Filter by free-text query (case-insensitive substring) and/or tag. " +
        "This tool is read-only; use work_log for the automatic activity journal instead.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against the note text."),
        tag: z
          .string()
          .optional()
          .describe("Tag to filter by (case-insensitive, exact match)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum notes to return, newest first. Defaults to 20 and is capped at 100."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tag, limit, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        const notes = await readNotes(root, { query, tag, limit });
        if (notes.length === 0) {
          return textResult("no notes match");
        }
        return textResult(notes.map(renderNote).join("\n"));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function renderNote(note: { ts: string; text: string; tags: string[] }): string {
  const parts = [note.ts.slice(0, 10)];
  if (note.tags.length > 0) {
    parts.push(note.tags.map((tag) => `[#${tag}]`).join(" "));
  }
  parts.push(note.text);
  return parts.join("  ");
}

/**
 * Harness recall rendering (change chatgpt-workspace-harness, Slice 3).
 *
 * The legacy `recall` tool above is byte-compatible and untouched; everything
 * below serves the scoped `harness_recall` surface registered from
 * `src/tools/session.ts` and gated by `harness.recall` in `src/server.ts`.
 */

/** Optional enrichment sources; both stay optional and never block recall. */
export type RecallEnrichmentSource = "engram" | "obsidian";

/**
 * One enrichment result line. Enrichers MUST scope their own lines to the
 * presented session (and work, when the scope narrows to one); the handler
 * drops any line whose scope does not match before returning.
 */
export interface RecallEnrichedLine {
  text: string;
  sessionId: string;
  workId?: string;
}

export interface RecallEnrichment {
  source: RecallEnrichmentSource;
  lines: RecallEnrichedLine[];
  /** True when the source was reachable and contributed lines. */
  ok: boolean;
}

export interface RecallScope {
  sessionId: string;
  workId?: string;
}

export type RecallEnricher = (
  query: string,
  scope: RecallScope,
) => Promise<RecallEnrichment>;

/** Explicit marker appended whenever an optional source cannot enrich. */
export function degradedMarker(source: RecallEnrichmentSource): string {
  return `degraded: ${source}-unavailable`;
}

/**
 * Scope filter for enrichment lines: keeps only lines scoped to the
 * presented session (and work, when narrowed). Applied before return so an
 * enricher can never leak cross-session rows into local results.
 */
export function filterEnrichedLines(
  lines: readonly RecallEnrichedLine[],
  scope: RecallScope,
): RecallEnrichedLine[] {
  return lines.filter(
    (line) =>
      line.sessionId === scope.sessionId &&
      (scope.workId === undefined || line.workId === undefined || line.workId === scope.workId),
  );
}

/**
 * Slice C continuation lines (change harness-operability): shared rendering
 * of the derived continuation so the `harness_status` and `session_resume`
 * text paths print identical lines from the single store derivation.
 */
export function renderContinuationLines(status: {
  currentStage: string | null;
  next: string;
  reason: string;
}): string[] {
  return [
    `currentStage: ${status.currentStage ?? "(none)"}`,
    `next: ${status.next}`,
    `reason: ${status.reason}`,
  ];
}

/** Shared rendering of the latest-checkpoint text lines (Slice C). */
export function renderCheckpointLines(checkpoint: {
  seq: number;
  completedStage: string;
  summary: string;
} | null): string[] {
  if (checkpoint === null) {
    return ["latestCheckpoint: (none)"];
  }
  return [
    `latestCheckpoint: seq ${checkpoint.seq} stage ${checkpoint.completedStage}`,
    `summary: ${checkpoint.summary}`,
  ];
}

/** One work entry carried by the Slice D bootstrap block. */
export interface BootstrapWork {
  id: string;
  changeId: string | null;
}

/** Input for the Slice D bootstrap block renderer. */
export interface BootstrapBlockInput {
  sessionId: string;
  primaryWorkspace: string;
  works: readonly BootstrapWork[];
  latestSummary: string | null;
  next: string;
}

/**
 * Static bilingual natural-trigger hints (Slice D). Documented guidance
 * only: session resolution stays explicit-token, so a turn carrying trigger
 * text but no token still attaches to nothing.
 */
export const BOOTSTRAP_TRIGGER_HINTS =
  `triggers: "nuevo trabajo" → work_start; ` +
  `"continúa la sesión anterior" → session_resume with token`;

/**
 * Slice D bootstrap block (change harness-operability): pure capped renderer
 * for the dynamic context block appended to `session_start`/`session_resume`
 * text output. Postcondition: `result.length <= BOOTSTRAP_MAX_CHARS` with the
 * embedded summary capped at `BOOTSTRAP_SUMMARY_MAX_CHARS`. Any truncation
 * appends an explicit `… [truncated N chars]` marker and never cuts silently;
 * small sessions render complete with no marker. Carries no metric values.
 */
export function renderBootstrapBlock(input: BootstrapBlockInput): string {
  const summary = input.latestSummary ?? "(none)";
  const worksLine =
    input.works.length === 0
      ? "works: (none)"
      : `works: ${input.works.map((work) => `${work.id} (${work.changeId ?? "unbound"})`).join(", ")}`;
  const block = [
    `session: ${input.sessionId}`,
    `primaryWorkspace: ${input.primaryWorkspace}`,
    worksLine,
    `latestSummary: ${capBootstrapSummary(summary)}`,
    `next: ${input.next}`,
    BOOTSTRAP_TRIGGER_HINTS,
  ].join("\n");
  if (block.length <= BOOTSTRAP_MAX_CHARS) {
    return block;
  }
  const removed = block.length - BOOTSTRAP_MAX_CHARS;
  const marker = `… [truncated ${removed} chars]`;
  return `${block.slice(0, BOOTSTRAP_MAX_CHARS - marker.length)}${marker}`;
}

/** Caps the embedded bootstrap summary with an explicit truncation marker. */
function capBootstrapSummary(summary: string): string {
  if (summary.length <= BOOTSTRAP_SUMMARY_MAX_CHARS) {
    return summary;
  }
  const removed = summary.length - BOOTSTRAP_SUMMARY_MAX_CHARS;
  return `${summary.slice(0, BOOTSTRAP_SUMMARY_MAX_CHARS)}… [truncated ${removed} chars]`;
}

/**
 * Slice E lifecycle v2 (change harness-operability): reopen guidance carried
 * by every ended snapshot and ended-write rejection. Names the explicit
 * path only; carries no metric values.
 */
export const ENDED_SESSION_REOPEN_GUIDANCE =
  "session is ended; call session_reopen with the session token to reopen it";

export function renderHarnessRecall(input: {  stages: readonly StageArtifactRecord[];
  checkpoints: readonly CheckpointRecord[];
  enriched: readonly RecallEnrichedLine[];
  degraded: readonly RecallEnrichmentSource[];
}): string {
  const lines: string[] = [];
  if (
    input.stages.length === 0 &&
    input.checkpoints.length === 0 &&
    input.enriched.length === 0
  ) {
    lines.push("no harness results match");
  }
  for (const stage of input.stages) {
    lines.push(`stage ${stage.stage} ${stage.id} [${stage.workspace}]: ${stage.body}`);
  }
  for (const checkpoint of input.checkpoints) {
    lines.push(
      `checkpoint ${checkpoint.seq} ${checkpoint.completedStage} [${checkpoint.workspace}]: ${checkpoint.summary}`,
    );
  }
  for (const line of input.enriched) {
    lines.push(line.text);
  }
  for (const source of input.degraded) {
    lines.push(degradedMarker(source));
  }
  return lines.join("\n");
}
