# Raya Capabilities and Limits

`src/agent/capabilities.ts` is the executable shared catalog injected into Raya's system prompt and rendered by `/about` and `/help`. It covers every built-in top-level command (`commands`, `local`, `web`, provider auth, Telegram gateway, plugins, MCP, skills, update, status/config, providers/models, search shortcuts, Git, and application opening), every slash command, every core tool, connected MCP resource/prompt adapters, persistent stores, and honest limits. Personal commands from `commands.json` are added to the prompt dynamically. Verify new functionality there as well as at its real registration point so Raya never describes stale or imaginary capabilities.

## Interfaces

- Interactive TUI: streaming chat, Plan/Build switching, configurable core hotkeys, slash menus, prompt history, direct terminal lines, themes, profiles, and sessions. The footer shows the active model, reasoning level, and profile. `/profile` creates or switches isolated roles, `/skills` attaches a selected skill to the current message as `@skill:<name>`, and `/about` is lowercase.
- One-shot CLI: run one prompt with the configured provider and tools.
- Direct CLI commands: built-ins such as `raya git` and `raya open`, plus user-created shortcuts managed with `raya commands add|list|show|remove`. Extra invocation arguments are appended to the saved argument vector.
- Profiles: `raya profile <name>` selects an existing profile; `raya profile --list` is the explicit list alias; `list`, `use`, `create`, `show`, `rename`, and confirmation-gated `delete` manage profile directories. `--clone` copies identity/instructions and `--clone-all` also copies memory.
- Updates: `raya update` reads the current commit from the official GitHub branch, reads that commit's version directly, and asks for explicit `y` or `yes`. It then requires a complete local checkpoint, runs that exact commit's installer with a disposable `RAYA_HOME`, and leaves the user's `.raya` byte ownership entirely outside the installer.
- Platforms: Windows, macOS, and Linux are supported. Windows installation and updates use `install.ps1` in PowerShell; host-native command, URL, application, clipboard, npm launcher, process-tree, backup, restore, and uninstall paths are selected at runtime.
- Backups: `raya backup --setup` chooses local or GitHub storage, plain `raya backup` creates a named version, and `--list` prints separate GitHub/Local tables with names, Raya versions, dates, and restore commands. Restore always asks which source to use, then reinstalls the archived package and state after `RESTORE` confirmation. Every local version is a sibling `~/raya-backups/<name>/` folder with code, `.raya`, manifest, and package archive directly inside; no date, snapshot, wrapper, or Git directory is added. Previous nested local snapshots remain compatible. GitHub operations use throwaway clones and keep no persistent local copy. `--local <name>` configures local mode and creates that named backup; `--github` provides explicit repository setup; `bakcup` is a typo-compatible alias. Read [backups.md](backups.md) for the complete storage and lifecycle contract.
- Uninstall: `raya uninstall` removes the global package, exact Raya launchers, `RAYA_HOME`, and normally `~/raya-backups` only after `UNINSTALL`; `--keep-backups` preserves local backup history. It never deletes a remote GitHub repository.
- Raya Web: loopback-only multi-pane chat, workspaces, AGENTS.md and SOUL.md editing, calendar, reminders, scheduled work, and linked notes. Every API request requires a random per-run token and strict Host/Origin validation; bootstrap exposes only the active mode, provider, and model.
- Telegram: local long-polling gateway requiring an allowed chat ID. Consequential actions use inline approval bound to both that chat and the user who initiated the request.
- Scheduler: persistent one-time and daily reminders delivered through the configured interface path.
- Subagents: bounded isolated agent work that inherits the current mode, model runtime, workspace policy, and connected MCP runtime.

## Core Tools

- Workspace file listing, reading, writing, and readable diffs.
- Approval-aware shell execution with blocked-command checks and bounded output.
- Public web text search and fetch with private/local network protection.
- Application open/close control where the operating system supports it.
- Profile-scoped session discovery, global USER.md and profile MEMORY.md writes, scheduling, skill loading, and Build-only skill authoring.

The authoritative list is `createDefaultTools` in `src/tools/index.ts`; mode and platform can change which tools are present.

## Extensibility

- MCP: stdio, Streamable HTTP, and legacy SSE servers can add tools, resources, prompts, and server instructions. Common `mcpServers` configs with omitted `transport` or a `type` alias are normalized.
- Skills: packaged, user, workspace, and supported package skills add progressive instructions. They do not execute code or grant permissions.
- Local models: OpenAI-compatible endpoints such as Ollama, LM Studio, vLLM, and llama.cpp can be registered without API keys.
- Pi packages: package skills are discoverable; native Pi extensions require an explicit Raya adapter.
- User commands: local executable shortcuts are stored separately from config and launched without a shell. They are appropriate for trusted repeatable commands, not secret storage or agent tool extension.

## Safety Model

- Plan restricts mutation. Build enables it.
- Standard security asks before consequential Build actions. Full security suppresses the interactive approval step.
- `blockedCommands`, path containment, private-network checks, credential separation, package validation, and atomic persistence are defense-in-depth controls.
- Raya is not an OS sandbox. Shell and filesystem tools run with the local user's permissions.
- GitHub backups exclude `.env` and `auth.json`, remove literal MCP header/environment credentials from JSON while preserving exact environment placeholders, abort on malformed JSON, touch only `.raya-backup` in the chosen repository, and should still use a private repository because other Raya state can be personal.

## Honest Limits

- Raya is active only while its local process is running; Telegram and reminders are not a hosted cloud service.
- Web research is text search/fetch, not full browser automation.
- Provider/model quality and tool-calling support vary.
- External MCP servers remain separate trust domains and can fail, return untrusted content, or mislabel mutating tools.
- Remote MCP endpoints require HTTPS except on loopback. Plan ignores `readOnlyHint` unless that server was explicitly trusted.
- Owner-only secret files protect against other local accounts and accidental publication, but they are not an operating-system keychain and remain readable to the same OS account.
- Native Pi extensions do not run without an adapter.
- Supported hosts are Windows, macOS, and Linux with Node.js 22 or newer. Windows Terminal is recommended for the complete TUI experience; automatic Windows prerequisite installation additionally requires `winget`.
