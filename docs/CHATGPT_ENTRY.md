# ChatGPT Guided Entry (Slice 1)

First-run path for a ChatGPT operator landing on one primary workspace with
minimal friction. This slice is docs, tunnel preset, and config defaults only:
no protocol change, no new harness state.

## Quick path

1. Start the tunnel with the pinned single-workspace preset:
   `scripts/tunnel.sh --preset chatgpt --root /path/to/project`
2. Run `workspace_list` to confirm the binding, then `change_status` to orient.
3. Keep one running session convention per task: `work_log` progress notes,
   `recall` for context, `change_status` to re-orient, `remember` for durable facts.

## Details

| Topic | Decision |
|-------|----------|
| Primary workspace | The preset binds exactly one primary workspace (`--root`, one `--workspace`, or the config-file primary). An explicit `workspace` argument on any tool call overrides the default for that call. With no primary configured, every call needs an explicit workspace argument; the server never guesses. |
| Tunnel flags | `--preset chatgpt` pins the single-workspace first run. `--config PATH` drives everything from a file. Shell stays **disabled by default**; `--shell` (allowlist) or `--shell-any` (unrestricted) enable it explicitly per run. `--shell-any` can run any executable as your OS user. |
| Shell allowlist | Built-in allowlist is `pnpm`, `npm`, `npx`, `node`. Anything else (including `git`) needs an explicit allow entry via config `shell.allow`, `WORKSPACE_MCP_SHELL_ALLOW`, or `--shell-allow`. Deny entries always win; no flag can remove a restriction. This is an accident guardrail, not a sandbox: `node -e` and `npx` run arbitrary code. |
| Session convention | `work_log` for progress notes, `recall`/`readNotes` for context, `change_status` to re-orient, `remember` for durable facts. Legacy change tools (`change_create`, `change_doc`, `task_add`) track the unit of work. |
| Repo-local writes disclosure | The legacy writers `change_create`, `change_doc`, `task_add`, `work_log`, and `remember` create repo-local state under `<root>/.workspace-mcp/` (change records, stage documents, journal lines, notes). That is normal for this flow, and it is visible in the bound repository. |
| No-artifacts promise | The no-artifacts workflow is not available in this slice. A future stateful slice will persist harness session/work/stage state outside repositories; until then, assume every legacy-writing tool above leaves state under `<root>/.workspace-mcp/`. |
| Tunnel identity | The `tunnel_id` is transport routing only. It is never session or conversation identity: continuity comes from explicit workspace selection and, in later slices, server-issued session tokens. |

## Checklist

- [ ] `workspace_list` shows the expected primary workspace before doing work.
- [ ] Shell is off unless you passed `--shell`/`--shell-any` (or config `shell.mode`) on purpose.
- [ ] You expect `<root>/.workspace-mcp/` writes from `change_create`, `change_doc`, `task_add`, `work_log`, and `remember`.
- [ ] You do not treat the `tunnel_id` as who you are talking to.

## Next step

Full tunnel reference: `scripts/tunnel.sh --help`. Multi-workspace selection and
the JSON config profile are documented in `README.md` (Multiple workspaces,
Configuration file).

When `harness.session` is enabled, the stateful flow (`session_start`,
`work_start`, `stage_write`, `task_write`, `checkpoint`, `harness_status`)
persists its records in the outside-repo store described in `README.md`
(Harness sessions) and `docs/ARCHITECTURE.md`. The legacy-tool disclosure
above still applies to the legacy tools themselves.
