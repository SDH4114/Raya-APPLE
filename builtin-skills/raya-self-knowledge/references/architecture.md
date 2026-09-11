# Raya Architecture

## Identity and Purpose

Raya is a personal AI operating and coding assistant distributed as the `@sdh4114/raya` npm package. Her purpose is to make AI-assisted computer work understandable and controllable: inspect first, use the right local or remote capability, ask before consequential actions in standard security mode, preserve durable context, and verify outcomes.

Raya is not one model. She is the orchestration layer around selectable model providers, tools, interfaces, persistent state, MCP servers, and reusable skills.

## Runtime Flow

1. `src/cli/index.ts` parses built-in commands, registers validated user commands loaded by `src/commands/store.ts`, and starts the selected interface.
2. `src/config/` resolves `~/.raya`, validates config, loads secrets separately, and bootstraps packaged assets; `src/profiles/` resolves the active profile and migrates legacy root context into `default`.
3. `src/providers/` authenticates providers and selects the model runtime.
4. `src/mcp/` connects enabled MCP servers and exposes their tools, resources, and prompts.
5. `src/agent/create-agent.ts` assembles the agent, system prompt, built-in tools, and MCP tools.
6. `src/agent/capabilities.ts` supplies the shared capability map used by the system prompt, `/about`, and slash-command help; `src/agent/system-prompt.ts` adds stable operating rules, workspace instructions, memory, and the skill catalog.
7. `src/skills/loader.ts` discovers skill metadata; `use_skill` loads complete instructions only when needed.
8. Agent events stream to `src/tui/`, `src/web/`, or Telegram and sessions are persisted for later continuation.

## Ownership Boundaries

- CLI owns command parsing, provider login, process lifecycle, and assembly of interface-specific callbacks.
- Config owns validation and backward-compatible migration. Callers should use `normalizeConfig`, `loadConfig`, or `updateConfig`, not trust stored JSON.
- Agent assembly is the only place that should combine the system prompt, default tools, MCP tools, and subagent tool.
- Tools own capability-specific validation and approval metadata; interfaces own how approval is collected.
- Profile storage owns named SOUL.md, AGENTS.md, MEMORY.md, migration, cloning, and lifecycle. Session storage owns message history plus workspace/profile binding. Memory owns global USER.md and active-profile facts. Do not use one as a silent replacement for another.
- MCP runtime owns external server connections and must close every client it successfully opened, including partial strict-mode failures.
- Built-in skills are packaged source assets. Installed skill folders are user-owned and are not silently overwritten.

## Source Map

- `src/agent/`: agent assembly, identity, workspace instructions, compaction, and context.
- `src/agent/capabilities.ts`: single catalog of built-in CLI commands, slash commands, tools, interfaces, persistence, safety boundaries, and installed personal commands.
- `src/cli/`: commands, setup, config UX, and interface startup.
- `src/platform.ts`: host-native executable names, shell selection, PATH parsing, npm global command layout, and launcher names.
- `src/commands/`: schema-validated user command persistence and direct process execution without shell interpolation.
- `src/backup/`: local/GitHub snapshot creation, listing, package archives, and restore mechanics.
- `src/config/`: schema, paths, secrets, migration, and durable settings.
- `src/providers/`: model providers, authentication, discovery, and selection.
- `src/profiles/`: named profile validation, migration, cloning, lifecycle, and file paths.
- `src/tools/`: local tools and approval-aware actions.
- `src/mcp/`: Model Context Protocol clients, lifecycle, safety, and status.
- `src/skills/`: packaged-skill installation and progressive skill discovery.
- `src/memory/` and `src/session/`: durable knowledge and conversation history.
- `src/scheduler/` and `src/telegram/`: background tasks and Telegram interface.
- `src/tui/` and `src/web/`: terminal and browser interfaces.
- `builtin-skills/`: skills copied into `~/.raya/skills` on first setup without replacing user-customized files.
- `tests/`: behavioral and regression tests.

Important entrypoints include `src/cli/index.ts`, `src/agent/create-agent.ts`, `src/agent/system-prompt.ts`, `src/tools/index.ts`, `src/mcp/client.ts`, `src/tui/app.ts`, `src/web/server.ts`, and `src/telegram/service.ts`.

## Operating Modes and Safety

- Plan mode supports investigation and read-oriented work.
- Build mode exposes mutation tools such as file writing and skill creation.
- Standard security asks before consequential actions. Full security mode follows the user's explicit configuration.
- Secrets belong in protected secret storage or environment variables, not ordinary config or skills.
- Workspace path checks and symlink boundaries prevent accidental writes outside the intended scope.

## Persistent State

Raya normally stores config, auth, sessions, memory, scheduled work, plugins, and skills under `~/.raya`. Tests and smoke checks should set `RAYA_HOME` to an isolated temporary directory.

`config.json` is non-secret configuration and stores `activeProfile`. `.env` is owner-only credential storage: private atomic writes use `0600` on Unix and an owner-only ACL on Windows, with cross-process serialization for updates. This is file protection, not an OS keychain; the same OS account can read it. `commands.json`, `sessions.json`, `web.json`, `scheduled.json`, global `USER.md`, skills, and plugins are shared. Every `profiles/<name>/` owns `SOUL.md`, `AGENTS.md`, `MEMORY.md`, metadata, and readable transcripts.

Backup configuration is a typed `backup` object in `config.json`; the exact target is mirrored as `RAYA_BACKUP_TARGET` in `.env`. Each local version is a separate direct child of `~/raya-backups`, and that child directly contains code, `.raya`, manifest, and package archive. No date directory, snapshot wrapper, or local Git history is created. GitHub snapshots omit `.env` and `auth.json`, redact literal MCP `headers` and `env` values from JSON, retain exact environment placeholders, and write only the remote repository's `.raya-backup` directory through temporary clones that are removed after every operation. Malformed JSON stops remote backup. Local discovery scans direct backup children; the configured GitHub repository is queried remotely. Previous `snapshots/<id>` and local-Git layouts remain readable and restorable.

## Extension Points

- MCP servers add external tools, resources, and prompts through config.
- Skills add reusable instructions under `~/.raya/skills/<name>/SKILL.md`.
- User commands add direct `raya <name> [args...]` process shortcuts through `raya commands add`; they do not add agent capabilities or bypass operating-system permissions.
- Pi packages can contribute provider or skill capabilities.
- Profiles specialize durable identity, instructions, memory, and sessions. The nearest workspace `AGENTS.md` adds project-specific instructions; workspace `SOUL.md` does not replace profile identity.

## Source Versus Installed Raya

When source behavior differs from the `raya` command, compare `command -v raya`, `raya --version`, package metadata, and `node dist/cli/index.js`. Build before testing `dist`; reinstall the package only when the user actually wants the global installation updated.

## Lifecycle Invariants

- Enabled MCP servers connect once per running host and close during normal teardown.
- A failed optional MCP server is reported once and does not prevent other servers from working.
- A cancelled prompt rolls unfinished agent messages back before the next prompt.
- Session saves are serialized where multiple interfaces may write.
- Profile switches rebuild the agent and never reuse another profile's conversation messages.
- Workspace writes remain under the resolved workspace even through symlinks.
- Built-in assets may be bootstrapped, but user-customized files are preserved unless replacement was explicitly requested.
- Update is a read-only boundary for RAYA_HOME: create a complete checkpoint first, isolate installer state in a temporary RAYA_HOME, and install the exact commit used for metadata. Abort before installation if checkpoint creation fails.
- Host behavior remains native: `install.ps1`, PowerShell updates, npm `.cmd` shims, Windows PATH separators, process-tree termination, URL/application control, and uninstall launchers are used on Windows; Unix keeps `install.sh` and its native commands.
- Web binds to loopback, validates Host and Origin, and authenticates every API request with a random per-run token. Telegram requires an allowed chat ID and binds each approval to the initiating user.
- Remote MCP requires HTTPS outside loopback; server read-only annotations are ignored unless explicitly trusted.
- Backup restore and complete uninstall require typed confirmations. Uninstall removes installed/runtime Raya state and backups, but never guesses at or deletes unrelated source checkouts.
