# Backend Code Standards

This file is the source of truth for backend code generation and review. Before writing, modifying, refactoring, or reviewing backend code, coding agents must read this file once per session and apply its rules. If this file changes during the session, agents must read it again before making more backend changes.

## 1. Purpose

`workspace-mcp` is a small, security-focused MCP server: one workspace root, a small set of typed tools, stdio/HTTP transports. Optimize for auditability, explicit error messages and a small dependency surface - not for framework sophistication.

## 2. Stack

- Node.js >= 22, ESM only (`"type": "module"`, `module: NodeNext`).
- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- `@modelcontextprotocol/sdk` and `zod` are the only runtime dependencies; do not add more without a strong reason.
- Vitest for tests, pnpm for scripts (`build`, `typecheck`, `test`).

## 3. Selected architecture mode

`basic`, with a flat module layout. Files map one-to-one to capabilities; no layered ceremony.

## 4. Folder structure

```txt
src/
  index.ts        CLI parsing, transports, process lifecycle
  server.ts       server assembly, tool registration, instructions
  files.ts        file-level helpers and limits
  paths.ts        workspace path containment (single choke point)
  glob.ts         glob matcher
  shell.ts        opt-in command execution (spawn, capture, scrub, timeout)
  tools/          one file per MCP tool
test/             e2e over InMemoryTransport + focused unit tests
scripts/          operator scripts
```

Every new tool lives in `src/tools/<tool>.ts` and exports `register<Tool>Tool(server, root, ...)`.

## 5. File naming

kebab-case, responsibility suffix. `*.test.ts` for tests, `*.ts` for modules. No `helper.ts`, `utils.ts` or `common.ts`; name the behavior (`shell.ts`, `paths.ts`, `shared.ts` for tool result helpers).

## 6. Class naming

PascalCase with a responsibility suffix: `OutputAccumulator`, `WorkspacePathError`, `FileToolError`. Plain functions otherwise.

## 7. Interfaces and types

- No `I` prefix; `interface` for object contracts (`ShellConfig`, `CreateServerOptions`), `type` for unions/aliases (`ShellMode`).
- Use `readonly` and `as const` for constant tables.
- No `any`; use `unknown` for untrusted values and narrow explicitly.

## 8. Controllers

Not applicable: MCP tool handlers are the "controllers". Keep them thin: validate input, call a helper, format the result. No business logic in `tools/`.

## 9. Services and use cases

Not applicable. Execution/domain logic lives in top-level modules (`shell.ts`, `paths.ts`, `files.ts`) and is called by handlers.

## 10. DTOs and validation

Every tool input is validated by a zod schema in the `inputSchema` of `server.registerTool`. Add `.min()/.max()` bounds to numeric inputs; treat schema rejection as the first line of defense and still validate filesystem state before use.

## 11. Domain layer

Not applicable.

## 12. Application layer

Not applicable.

## 13. Infrastructure layer

Process execution, filesystem access and path resolution are the infrastructure. They must not leak raw error objects to clients; map them to short, actionable messages.

## 14. Presentation layer

Tool descriptions and result text are the presentation. Tool descriptions are in English, state when to use the tool and when not to, and list limits. Tool results use `textResult`/`errorResult` from `src/tools/shared.ts`.

## 15. Persistence and repositories

Not applicable; the filesystem is the only persistence and is accessed through `src/files.ts` and `src/paths.ts`.

## 16. Error handling

- Expected failures use `FileToolError` or `WorkspacePathError`; their messages are client-safe and specific (`file not found: <path>`).
- Unknown errors are logged with stack to stderr and reported as one short sentence via `describeError`.
- Never return stack traces, raw `ENOENT` dumps, or secrets to the client.

## 17. Logging

`process.stderr.write` only (stdout is the protocol stream in stdio mode). Never log tokens or API keys. Diagnostics use the `[workspace-mcp]` prefix.

## 18. Configuration

- CLI parsing in `src/index.ts` with `node:util` `parseArgs`; env vars are fallbacks and CLI flags win.
- No hardcoded secrets. Sensitive env vars (`CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `MCP_TOKEN`) must never be forwarded to child processes.
- Security-relevant defaults are off (`shell.enabled` defaults to false).

## 19. Imports and module boundaries

- Relative ESM imports with the `.js` extension (NodeNext).
- `tools/*` may import `files.ts`, `paths.ts`, `glob.ts`, `shell.ts` and `tools/shared.ts`; shared modules must not import `tools/*` (no cycles).
- Single containment choke point: every user path goes through `resolveSafe`.

## 20. Testing

- Real temporary workspaces (`fs.mkdtemp`) and real MCP `Client` over `InMemoryTransport`; no mocks for the filesystem or processes.
- Cover the happy path, the failure path and the boundary (limits, timeouts, truncation).
- Tests must leave no temp state behind and must not depend on the network.

## 21. Security

- Treat all tool input as untrusted.
- Path confinement is mandatory for every path argument.
- Command execution is argv-only, `shell: false`, opt-in, allowlist-first, with a scrubbed environment and bounded output capture.
- Document honestly when a mechanism is a guardrail and not a sandbox.

## 22. Checklist before coding

- [ ] Read this file in the session.
- [ ] File in the right folder with the right suffix?
- [ ] Zod schema bounds on new inputs?
- [ ] Errors short, specific and secret-free?
- [ ] Paths through `resolveSafe`?
- [ ] No new runtime dependencies without justification?
- [ ] Tests updated (real processes/filesystem, no mocks)?
- [ ] `pnpm build && pnpm typecheck && pnpm test` green?
