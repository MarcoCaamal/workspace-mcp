# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0]

### Added

- Multi-workspace support: one server process can serve several named roots.
  `--root <dir>` registers the primary workspace named `default`, and
  `--workspace <name>=<path>` (repeatable) registers additional workspaces.
- Optional `workspace` argument on every path or state tool, defaulting to the
  primary workspace.
- `workspace_list` read-only tool showing each workspace name, absolute root,
  primary marker, state directory presence and active change.
- Per-root isolation of containment, journal, notes and change tracking.
- `scripts/tunnel.sh` supports `--workspace <name>=<path>` (repeatable).

## [1.4.1]

### Fixed

- Serialized change and state read-modify-write operations with an in-process
  mutex, so parallel tool calls from one client can no longer lose updates.

## [1.4.0]

### Added

- Change tracking (SDD-lite): `change_create`, `change_activate`, `change_doc`,
  `change_status`, `task_add`, `task_update`, `constraint_add`.
- Change records at `.workspace-mcp/changes/<id>.json` plus stage documents
  (`proposal.md`, `spec.md`, `design.md`, `notes.md`) written on demand.
- Journal entries tagged with the active change id, and a `change` filter on
  `work_log`.
- Derived suggested next action in `change_status`.

## [1.3.0]

### Added

- Workspace activity journal (`work_log`), persistent notes (`remember`,
  `recall`) and read-only `git_status` / `git_diff` tools that work without the
  shell.
- Journal and notes rotation via `WORKSPACE_MCP_JOURNAL_MAX_BYTES` (default
  5 MiB) with bounded reads.

## [1.2.0]

### Added

- Background jobs: `start_job`, `job_status`, `job_kill`. Detached processes
  with per-job log files, `maxRuntimeMs` bounds, process-group kills at
  shutdown, and survival across client disconnects.

## [1.1.0]

### Added

- Opt-in `run_command` tool for tests, linters and builds; not registered
  unless explicitly enabled.

## [1.0.0]

### Added

- Initial release: `read_file`, `write_file`, `edit_file`, `patch`, `grep` and
  `list_files` scoped to a workspace root, with path containment.

[Unreleased]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/MarcoCaamal/workspace-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/MarcoCaamal/workspace-mcp/releases/tag/v1.0.0
