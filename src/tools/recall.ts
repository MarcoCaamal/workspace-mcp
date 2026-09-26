import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNotes } from "../state.js";
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

export function renderHarnessRecall(input: {
  stages: readonly StageArtifactRecord[];
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
