# Raya

Raya is an MIT-licensed, open-source personal AI PC assistant and coding-agent harness for Windows, macOS, and Linux. It is deliberately built for a useful daily workflow: one terminal session can work on code, inspect and edit local files, run shell commands, search the web, control applications, and optionally stay reachable through your own Telegram bot.

Raya supports **OpenAI Codex via ChatGPT Plus/Pro/Codex OAuth**, API-key providers through the `@earendil-works/pi-ai` adapter, and local OpenAI-compatible inference servers such as Ollama, LM Studio, vLLM, and llama.cpp. OpenAI Codex is optional: you can connect a different provider, use a local model, or skip provider setup until later. Raya uses `@earendil-works/pi-agent-core` rather than reimplementing an agent loop.

## Install

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "raya-install.ps1"
irm https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.ps1 -OutFile $installer
& $installer
```

The Windows installer uses Node.js 22+ and Git already on the machine, or installs missing prerequisites through `winget`. It builds and packs Raya, installs the package globally, adds npm's global command directory to the user `PATH`, and exposes `raya.cmd` in the current PowerShell session. Windows Terminal is recommended for the complete interactive TUI.

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.sh -o /tmp/raya-install.sh
bash /tmp/raya-install.sh
```

The Unix installer installs Node.js 22 with a commit-pinned, SHA-256-verified `nvm` bootstrap when needed. Both installers disable npm lifecycle scripts during dependency and global installation, download the repository into a temporary directory, build and pack Raya, preserve an existing `RAYA_HOME`, and make the command available on `PATH`. Downloading the installer first also lets you inspect it before execution. This GitHub-source approach works before the npm package is published. After publishing `@sdh4114/raya`, the equivalent install on every platform is:

```bash
npm install -g @sdh4114/raya
```

For development:

```bash
npm install
npm run build
npm link
raya
```

## First run

```bash
raya
```

If Raya has no configured provider, the first interactive launch displays the available providers. Choose any provider, or press Enter to skip setup. OpenAI Codex is not required. You can connect a provider later with `raya login`, or add a local OpenAI-compatible model with `raya local add`. Telegram setup is also optional and is offered only after a provider is ready.

```bash
raya login             # choose and connect a provider
raya login anthropic   # connect a specific provider
raya login openai      # connect an OpenAI API key for GPT-5.6
raya login moonshotai  # connect a Moonshot API key for Kimi K3
raya "explain this repository"  # one-shot prompt
raya status
raya models
raya local add qwen3:8b             # Ollama at 127.0.0.1:11434
raya local list
raya gateway --setup
raya gateway --start
raya gateway --restart
raya mcp list
raya skills list
raya profile list
raya profile --list          # explicit list alias
raya profile create coder --clone
raya profile coder      # select coder; same as: raya profile use coder
raya update            # confirm, checkpoint locally, then update Raya
raya backup --setup    # choose GitHub or local backup storage
raya backup            # save a named version after setup
raya backup --list     # list rollback references
raya commands list
raya web               # open the full local Web application demo
```

The terminal UI is intentionally English. Every submitted prompt is echoed as `[Plan] > …` or `[Build] > …`, followed by one `Raya` heading and a readable Markdown-rendered answer. Responses support headings, bold, italic, strikethrough, links, inline code, fenced code blocks, lists, task lists, blockquotes, tables, horizontal rules, and semantic terminal colors. Tool work appears immediately in compact activity panels. File writes show a unified diff with a dark red background and bright readable text for removed lines, a dark green background and bright readable text for added lines, and `+/-` totals. Shell panels show the command, readable output, and exit code instead of a raw JSON dump. This makes coding work reviewable before the next prompt while keeping concurrent actions visually separated.

Raya ships with two complete palettes:

- **Ocean Blue** — the original focused blue palette.
- **Sunset Red** — a high-contrast red, pink, and orange palette.

Enter `/theme` and press Enter to open the theme picker. Selecting a palette applies it immediately and saves it as the global theme without changing any other `config.json` setting. The theme can also be set directly:

```bash
raya config --theme ocean
raya config --theme sunset
```

The input prompt shows `[Plan]` or `[Build]`; the default Tab hotkey switches modes for the current session while preserving the input and cursor. Type `@` anywhere to open a searchable dropdown of workspace files and folders. Selecting an entry inserts `@file:"path"` or `@folder:"path"`; repeat `@` to attach any number of entries. Raya reads every attached file or lists every attached folder before answering. Generated and dependency trees (`.git`, `node_modules`, and `dist`) appear as selectable folders but are not recursively expanded in the dropdown. `Shift+Enter` creates a real new line in the input field, while Enter submits or selects. In multiline input, Up/Down move the cursor between lines and preserve its intended column. The editor supports Shift+arrows selection, Home/End, Ctrl/Option+Left/Right word movement, Ctrl/Cmd+A, Ctrl/Cmd+C/X/V, Ctrl+W, Ctrl+U/K/D, Option+Backspace/Delete, and Ctrl+Shift+K. `Ctrl+Backspace` and `Ctrl+Delete` deliberately remove the entire cursor line. Copy and paste use the native macOS, Windows, or Linux clipboard when available, with OSC 52 as a terminal fallback. Text is inserted atomically, so large and multiline pastes do not redraw once per character; real line breaks remain visible in the terminal and intact for the model. Pasted images become numbered `[Image 1]`, `[Image 2]`, … markers and are sent to the selected model as real image attachments. Pressing Backspace or Delete anywhere in an image marker removes the entire block and its image at once, then renumbers the remaining images. Regular terminal paste is also handled atomically through bracketed-paste mode. Modified-key input is decoded across macOS Terminal, iTerm2, Ghostty, Kitty/CSI-u, and Windows Terminal escape formats. Outside a menu, plain Up/Down arrows move through earlier submitted prompts when the current input is a single line and restore the unfinished draft at the newest position. Inside a `/` menu they move through choices. Plan exposes investigation-oriented tools; Build enables file and app changes, with an **Accept / Refuse** picker for consequential actions in Standard security. Start a line with `!` to run it directly in your terminal without sending it to Raya or saving it in the conversation. Type `/` elsewhere to open the command dropdown. Enter opens or selects, the cancel hotkey closes a menu or aborts an active run and rolls back unfinished messages, and the exit hotkey quits with `Bye bye`. In `/sessions`, `dd` requests deletion and then shows confirmation. A permanent footer shows context usage, the active model with its reasoning level such as `GPT-5.5 (medium)`, active profile, working directory, and Raya version. Changing `/thinking` or `/profile` updates this state immediately.

Core TUI hotkeys are configurable and shown with their active values on the startup dashboard and in `raya status`. Chords are case-insensitive and support `ctrl`, `meta` (Option on macOS), `shift`, named keys, letters, digits, and `F1`–`F12`. Bindings must be unique.

```bash
raya config --hotkey toggleMode=ctrl+m
raya config --hotkey cancel=ctrl+x --hotkey exit=ctrl+q
raya config --hotkey clearScreen=meta+l
raya config --reset-hotkeys
```

The defaults are `tab`, `escape`, `ctrl+c`, and `ctrl+l` for `toggleMode`, `cancel`, `exit`, and `clearScreen` respectively. They are stored under `hotkeys` in `~/.raya/config.json`.

The startup screen is a responsive Raya dashboard: the Raya logo is aligned to the left with live session state below it, beside Raya-specific workflow guidance and the currently configured controls. It becomes a stacked panel in narrow terminals. Use `raya config --design large` for the expanded ASCII identity panel, or `raya config --design small` for the compact core mark.

Useful interactive commands:

```text
/help
/providers
/models
/thinking
/character
/profile
/theme
/security
/sessions
/mcps
/skills
/about
/clear
/exit
```

`/models` is a two-step picker: choose a model first, then Raya reads that model's provider metadata and shows only its supported reasoning levels. `/thinking` uses the same model-specific list. If a stored level is incompatible with a newly loaded model, Raya moves it to the nearest supported level instead of sending an invalid setting to the provider. `/profile` opens the active profile list; selecting one rebuilds the agent with that profile's identity, instructions, memory, and clean session context.

`/skills` opens a compact searchable dropdown of all built-in, user, workspace, and package skills. The list displays short stable rows like `/providers`, while searching still matches both the skill name and its complete description. Selecting one inserts a visible `@skill:<name>` marker into the current input instead of sending the command immediately. Open `/skills` again anywhere in that input to attach more skills; existing markers are preserved, for example `@skill:debugging @skill:implementation fix this failure`. Raya loads every selected skill with `use_skill` before answering. The information command is lowercase: `/about`.

Direct shortcuts:

```text
raya yt [text]              Open YouTube, or search YouTube when text is supplied
raya search <text>          Open a web search in the browser
raya serach <text>          Alias for raya search (kept for convenience)
raya git                    git add ., ask for a commit name, commit, then push
raya open <application>     Open an application
```

Create your own direct commands without changing Raya's source:

```bash
raya commands add serve --description "Start the development server" -- npm run dev
raya serve
raya serve --port 3000 # extra arguments are appended

raya commands list
raya commands show serve
raya commands remove serve
```

The command name uses lowercase letters, numbers, and hyphens. Raya stores the executable and each argument separately in `~/.raya/commands.json`, then launches them without a shell. This preserves spaces and prevents shell interpolation. Use `--cwd <path>` to pin a command to one directory and `--force` only when deliberately replacing an existing custom command. Built-in names such as `git`, `open`, and `commands` cannot be replaced. Custom commands are local executable shortcuts: invoking one is an explicit request to run it with your operating-system permissions.

## Tools

All tools implement the same `RayaTool` contract (`name`, `description`, JSON schema, `execute()`), so more tools can later be added without changing the agent core.

- `shell` — executes commands in the workspace.
- `web` — DuckDuckGo text search and public URL fetch; local/private network addresses are blocked.
- `list_files`, `read_file`, `write_file` — workspace filesystem access. Writing is available in Build mode.
- `app_control` — opens applications and closes named apps/processes on Windows, macOS, and Linux.

Plan mode blocks common mutating shell commands; Build mode permits normal local work. This is a convenience policy, not a security sandbox.

## Local models

Raya can use any local server that implements the OpenAI-compatible chat-completions API. Registering a model does not download it or start its server; start Ollama, LM Studio, vLLM, or llama.cpp first, then add the model to Raya.

Ollama uses `http://127.0.0.1:11434/v1` by default:

```bash
ollama pull qwen3:8b
raya local add qwen3:8b
```

LM Studio commonly uses port 1234:

```bash
raya local add local-model-id \
  --provider lmstudio \
  --base-url http://127.0.0.1:1234/v1 \
  --name "My LM Studio model"
```

Custom vLLM or llama.cpp endpoints work the same way:

```bash
raya local add Qwen/Qwen3-Coder-30B-A3B-Instruct \
  --provider vllm \
  --base-url http://127.0.0.1:8000/v1 \
  --context-window 131072 \
  --max-tokens 16384
```

Manage local entries and select one:

```bash
raya local list
raya local remove qwen3:8b --provider ollama
raya config --provider ollama --model qwen3:8b
```

Local providers are keyless by default, have zero API cost metadata, appear in `/providers` as connected, and appear in `/models` alongside cloud models. Tool calling still depends on the capabilities and chat template of the model served by your local runtime.

## GPT-5.6 and Kimi K3

`raya login openai` enables the OpenAI API catalog, including `gpt-5.6` (the Sol alias), `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. The OpenAI Codex OAuth provider also includes `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; availability depends on your ChatGPT/Codex account. `raya login moonshotai` enables Moonshot AI, including `kimi-k3`. Choose any available model with `/models` or `raya config --provider <provider> --model <model>`. API-key billing belongs to the connected provider; Raya displays the current standard token-price metadata in its usage accounting.

## Profiles, AGENTS.md, SOUL.md, and MEMORY.md

Raya profiles are managed personal agents inspired by the profile workflow in Hermes Agent. Each profile has its own directory:

```text
~/.raya/profiles/<name>/
├── SOUL.md
├── AGENTS.md
├── MEMORY.md
├── profile.json
└── sessions/YYYY-MM-DD/<session-id>.md
```

- `SOUL.md` defines that profile's identity, tone, style, and character.
- `AGENTS.md` defines durable operating instructions and role-specific workflows.
- `MEMORY.md` contains compact facts and lessons visible only to that profile.
- sessions are filtered by both workspace and profile, so switching roles does not expose another profile's conversation history.

The original root `SOUL.md`, `AGENTS.md`, and `MEMORY.md` are copied into the managed `default` profile on first use and left untouched as a recoverable migration source. `USER.md` remains global because every profile serves the same human. Provider credentials, model configuration, MCP servers, skills, direct commands, schedules, and themes are also shared; a profile changes Raya's role and continuity, not operating-system permissions or connection setup.

```bash
raya profile                         # active profile and list
raya profile --list                  # explicit list alias
raya profile coder                   # select an existing profile
raya profile use coder               # explicit equivalent
raya profile create coder            # fresh identity, instructions, and memory
raya profile create work --clone     # copy SOUL.md + AGENTS.md; start empty memory
raya profile create twin --clone-all # also copy MEMORY.md
raya profile create qa --clone --clone-from coder
raya profile show coder
raya profile rename coder engineer
raya profile delete engineer         # typed confirmation; active/default cannot be deleted
```

Inside the TUI, `/profile` opens a searchable picker. `/profile create <name>` clones the active profile's `SOUL.md` and `AGENTS.md`, activates the new profile, and starts a clean session. `/character` now replaces only the active profile's `SOUL.md` and applies it immediately by rebuilding the agent.

The active profile's `AGENTS.md` and `SOUL.md` are always loaded. Raya additionally walks upward from the current workspace and loads the nearest workspace `AGENTS.md` as project-specific context. Workspace `SOUL.md` no longer overrides profile identity, keeping profile behavior predictable.

## Sessions and long-term-memory foundation

Structured session state is stored in `~/.raya/sessions.json`. Every save also creates a profile-owned readable Markdown transcript under:

```text
~/.raya/profiles/<profile>/sessions/YYYY-MM-DD/<session-id>.md
```

Every ordinary `raya` launch starts with a transient empty session bound to the directory and active profile where `raya` was opened. It is not written to disk until the first message is sent. At that point Raya stores the canonical workspace path and derives a readable session name from the first prompt instead of using a random identifier. `/sessions` only shows sessions belonging to both the current directory and active profile, so projects and roles cannot mix histories. Existing sessions created before workspace/profile binding migrate to the `default` profile. Every session preserves its own Plan/Build mode independently; opening another session restores that session's mode. The color theme remains global.

Raya can autonomously write global user preferences to `USER.md` and profile-specific durable facts to the active profile's `MEMORY.md` through her memory tool. `src/memory/skill.ts` remains an extension hook for optional post-session consolidation beyond the built-in model-driven behavior.

Set `RAYA_HOME=/path` to move config, OAuth credentials, sessions, and memory. Default model and mode are configured with `raya config --model <model> --mode plan|build`. OAuth credentials, API keys, Telegram tokens, backup targets, and literal MCP header/environment values added through the CLI are stored in owner-only `~/.raya/.env`; writes are atomic and serialized across processes. On Windows, Raya also applies an owner-only ACL.

## Backup, rollback, and uninstall

`raya backup --setup` interactively chooses GitHub or local storage. The first plain `raya backup` also starts setup automatically when no target exists. Backups live under `~/raya-backups`, contain Raya's source, an installable package archive, and Raya state, and use a name supplied for each saved version.

Every confirmed `raya update` first creates a required local checkpoint named like `~/raya-backups/update-0.1.4-to-0.1.5-20260723T101112Z/`. It contains the currently installed Raya package, source files available to that installation, a manifest, and a complete copy of `RAYA_HOME`, including local credentials. If checkpoint creation fails, installation does not begin. The updater then runs the installer with a disposable temporary `RAYA_HOME` and pins both the downloaded installer and repository checkout to the same Git commit used for the version check. Existing files and directories under the user's `.raya` are therefore not created, replaced, migrated, or deleted by the update. The installer also has a compatibility bridge for older Raya clients that did not pass the checkpoint marker: it creates the same local checkpoint before replacement, then proceeds only after the checkpoint is complete.

```bash
raya backup --setup
raya backup
raya backup --list
raya backup --restore <reference> # always asks GitHub or Local

# optional command-line setup/create
raya backup --local "before-upgrade"
raya backup --github https://github.com/owner/private-raya-backups.git
```

Every local version is one independent folder at `~/raya-backups/<backup-name>/`. Raya's code, `.raya`, `manifest.json`, and `raya-package.tgz` are stored directly inside it: no date folder, `snapshots`, `snapshot`, `backups`, `raya-source`, `raya-home`, or local Git repository is added. Later versions are sibling folders under `~/raya-backups`; an existing name is never overwritten. GitHub snapshots commit only `.raya-backup` inside the selected repository and deliberately exclude `.env`, `auth.json`, and literal MCP header/environment values while retaining safe `${ENV_VAR}` placeholders. Raya clones that repository into a temporary system directory for create, list, or restore and removes the checkout afterward, so GitHub backups are not retained under `~/raya-backups`. Use a private repository because sessions, memory, and other personal state may still be sensitive. `raya backup --list` shows separate **GitHub backups** and **Local backups** sections with the name, Raya version, creation time, and restore command. Restore always asks which source to use, requires typing `RESTORE`, reinstalls the saved package with lifecycle scripts disabled, and restores state. Backup metadata is merged into `~/.raya/config.json`; the exact local root or Git URL is also stored with owner-only permissions as `RAYA_BACKUP_TARGET` in `~/.raya/.env`. The misspelled `raya bakcup` remains an alias for convenience.

`raya uninstall` is the complete local removal command. It requires typing `UNINSTALL`, uninstalls `@sdh4114/raya`, removes installer-created Raya launchers, deletes `RAYA_HOME`, and deletes `~/raya-backups`. Use `raya uninstall --keep-backups` to preserve backups. It does not delete Node.js, unrelated developer source repositories, or a remote GitHub backup repository.

To bypass Build-mode approval for trusted shell command prefixes, or to prohibit a command entirely, add `autoApproveCommands` and `blockedCommands` in `~/.raya/config.json`:

```json
{
  "autoApproveCommands": ["npm test", "git status"],
  "blockedCommands": ["rm", "rm -rf"]
}
```

Blocked commands are checked before Raya invokes the shell, including common wrappers and command chains, in either mode. This deny-list is defense in depth rather than a complete shell sandbox. The `/thinking` picker only shows effort levels the active provider/model reports as supported.

## Skills

Raya ships with built-in `debugging`, `implementation`, `project-audit`, `web-research`, `raya-self-knowledge`, and `create-raya-skills` skills. The expanded self-knowledge package is Raya's internal map of her identity, runtime flow, source ownership, every CLI and slash command, interfaces, tools, configuration, hotkeys, MCP formats, personal commands, persistent stores, safety model, honest limitations, and self-maintenance workflow. The executable catalog in `src/agent/capabilities.ts` is shared by the system prompt, `/about`, and `/help`, so these surfaces stay aligned; installed personal commands are added dynamically. It explicitly separates Raya's orchestration from the selected model and separates executable MCP capabilities from instruction-only skills.

On a fresh installation with no existing Raya state, the installer copies built-ins into `~/.raya/skills/`; the first normal Raya startup performs the same missing-only sync as a fallback. If `RAYA_HOME` already exists or the installer is running as an update, installer initialization is skipped completely. Existing folders are never replaced automatically, so user edits remain yours. Use the explicit force command when you deliberately want every installed built-in, including `raya-self-knowledge`, replaced by the package's current version.

Raya discovers `SKILL.md` metadata from both `~/.raya/skills/<skill>/SKILL.md` and `<workspace>/.agents/skills/<skill>/SKILL.md`. Only the compact catalog is added at session start; complete instructions and requested references are loaded through `use_skill` when relevant. This keeps the model context small and makes skill activation visible in the TUI. Skills are context instructions, never executable code or additional permissions by themselves.

In Build mode Raya can create a persistent skill with the approval-aware `create_skill` tool when the user asks to teach her a reusable workflow. She may propose a skill after noticing a recurring process, but Standard security still asks before it is written. Existing skills are not overwritten unless that exact update was requested.

```bash
raya skills list       # built-in, user, workspace, and package skills
raya skills sync       # install any missing built-in skills
raya skills sync --force # replace installed built-ins with packaged versions
```

At startup Raya loads the active profile's `SOUL.md` and `AGENTS.md`, then independently loads the nearest workspace `AGENTS.md`. This keeps profile identity stable while preserving repository-specific guidance.

## MCP servers

Raya is an MCP client for local `stdio`, remote Streamable HTTP, and legacy SSE servers. Enabled servers connect once when Raya starts and close cleanly when Raya exits, including strict diagnostic runs that only partially connect. Their paginated tools are exposed with collision-safe names such as `mcp_filesystem_read_file`; MCP resources and prompts are available through `mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`, and `mcp_get_prompt`. Server instructions are included in the agent context. The same connected MCP tools are available in the terminal, Raya Web, Telegram gateway, and subagents.

Add and test a local server:

```bash
raya mcp add filesystem \
  --command npx \
  --arg=-y \
  --arg @modelcontextprotocol/server-filesystem \
  --arg "$PWD"
raya mcp test filesystem
```

Add a remote server. Environment placeholders keep the actual token out of `config.json`:

```bash
export MY_MCP_TOKEN="..."
raya mcp add company \
  --url https://mcp.example.com/mcp \
  --header 'Authorization=Bearer ${MY_MCP_TOKEN}'
raya mcp test company
```

For an older SSE endpoint, add `--transport sse`. Streamable HTTP remains the default:

```bash
raya mcp add legacy --url https://mcp.example.com/sse --transport sse
raya mcp test legacy
```

Raya also normalizes common MCP JSON copied from other clients: `type` may be used instead of `transport`, and a missing transport is inferred as `stdio` from `command` or `http` from `url`. Remote MCP endpoints must use HTTPS; plain HTTP is accepted only on loopback. Environment placeholders work in commands, arguments, paths, environment values, URLs, and headers. Literal `--header` and `--env` values are automatically moved to owner-only secret storage.

Manage configured servers:

```bash
raya mcp list
raya mcp disable filesystem
raya mcp enable filesystem
raya mcp remove filesystem
```

Servers are stored visibly under `mcpServers` in `~/.raya/config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/project"],
      "env": {},
      "approval": "writes",
      "trustReadOnlyAnnotations": false,
      "timeoutMs": 30000,
      "toolTimeoutMs": 120000
    },
    "company": {
      "enabled": false,
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" },
      "approval": "writes",
      "trustReadOnlyAnnotations": false,
      "timeoutMs": 30000,
      "toolTimeoutMs": 120000
    }
  }
}
```

`approval` may be `always`, `writes` (default), or `never`. Server-supplied read-only annotations are untrusted by default, so Plan blocks all executable MCP tools. Enable them for a server only after review with `--trust-read-only` or `trustReadOnlyAnnotations: true`; unannotated tools remain Build-only. In Standard Build mode, tools that are not explicitly trusted read-only follow the normal approval policy. Full access is the only explicit approval bypass. A server that fails to connect is reported once and does not prevent Raya or the other MCP servers from starting. `raya mcp test <name>` is strict: it returns a failing exit status and closes any other connection opened during the diagnostic.

## Subagents and pi packages

Raya exposes a `subagent` tool. The model can automatically delegate a bounded investigation or implementation task to an isolated agent with its own context and the current Plan/Build restrictions.

Install a package from [pi.dev/packages](https://pi.dev/packages):

```bash
raya plugin install npm:pi-subagents
raya plugin list
```

Skills shipped inside installed pi packages are loaded on the next session. Package install scripts are disabled. Native Pi CLI extensions use a different host API; they require a Raya adapter and are not executed blindly as arbitrary npm code.

## Persistent memory and scheduling

Raya injects bounded frozen snapshots from global `~/.raya/USER.md` (1,375 chars) and the active profile's `MEMORY.md` (2,200 chars). Raya autonomously saves durable preferences, corrections, project decisions, and reusable lessons through the `memory` tool; writes are persisted immediately and appear in the next session of that profile. She can also list, search, and read saved sessions from the active profile when earlier context is relevant.

The `schedule` tool stores one-time and daily tasks in `~/.raya/scheduled.json`. Every scheduled task is delivered through Telegram; a failed or unavailable Telegram delivery leaves the task pending for retry. Reminders created in Raya Web are sent to Telegram and additionally shown as browser notifications. Restarting Raya reloads pending tasks from disk.

## Raya Web

Run `raya web` to open the full local application on `127.0.0.1`. Use `raya web --port <port>` to choose another port or `raya web --no-open` to start without opening the browser. Each run generates an unpredictable browser access token in the URL fragment; API calls require it, Host and Origin are checked, and the token is removed from the address bar into tab-scoped storage.

Raya Web includes the existing agent and session workflow plus Calendar, Reminders, Scheduled tasks, Workspaces, and connected Notes. Each registered workspace folder can edit its own `AGENTS.md` and `SOUL.md`; selecting that workspace gives the chat agent the matching folder context and filesystem root. Notes create bidirectional graph links with `[[Note title]]`. Web data is kept in `~/.raya/web.json` with owner-only permissions.

Security can be selected interactively with `/security`, or configured as the default with `raya config --security standard|full`. Standard asks for consequential Build actions. Full skips approval prompts, while `blockedCommands` remains active as a defense-in-depth check.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), copy its token, then enter it during Raya's first interactive run. A configured bot receives messages only while the Raya CLI process is running on your computer; it is not a hosted 24/7 service. Closing Raya or turning off the computer makes the bot unavailable—this is an intentional v1 limitation.

Use `raya gateway --setup` to change the bot token or allowed chat ID. `raya gateway --start` starts the local Telegram gateway, useful when the TUI is not running. `raya gateway --restart` starts it again with a fresh Telegram connection.

Every dangerous tool action requested from Telegram—shell mutation, writing a file, or closing an application—waits for an inline **Approve** or **Deny** button. The action does not proceed on timeout or denial, and only the same Telegram user who initiated the request may use its approval button. An allowed chat ID is mandatory; messages from every other chat are ignored.

## Architecture

- `src/providers/runtime.ts` — cloud and local OpenAI-compatible provider adapters.
- `src/agent/` — system context and `pi-agent-core` loop wiring.
- `src/tools/` — extensible tool registry.
- `src/tui/` — streaming terminal UI using `pi-tui` utilities.
- `src/tui/hotkeys.ts` — validated configurable key chords and matching.
- `src/telegram/service.ts` — same-process Telegram long polling and approval buttons.
- `src/mcp/client.ts` — MCP transports, capability discovery, tool adapters, resources, prompts, and lifecycle.
- `src/skills/` and `builtin-skills/` — skill discovery and first-run built-in installation.
- `src/commands/` — validated storage and shell-free execution for user-created direct commands.
- `src/profiles/` — profile validation, migration, cloning, isolation, rename, and deletion.
- `src/session/` and `src/memory/` — JSON session state, Markdown transcripts, and memory-skill hook.
- `src/cli/index.ts` — command entry point and session lifecycle.

## Current assumptions and known limits

- OpenAI Codex uses OAuth; Anthropic, OpenRouter, OpenCode Zen, and Hugging Face use their respective API keys.
- Shell and filesystem access are **not sandboxed**; run Raya only in a trusted workspace.
- Web browsing is text search/fetch only: no browser clicking or form automation.
- Telegram runs in the local CLI process, not on a server.
- Native Pi CLI extensions still require a Raya adapter; MCP and instruction skills are supported directly.
- Windows uses PowerShell for installation and updates, `cmd.exe` for shell-tool commands unless `ComSpec` selects another command processor, native npm `.cmd` shims, Windows URL/application launchers, and Windows clipboard/process-tree commands.

## Later roadmap

- Provider-specific setup and local model discovery improvements.
- Real sandboxing and configurable local approvals.
- Browser automation.
- Optional post-session memory consolidation and a complete plugin loader.

## Publishing

Authenticate to npm as the `@sdh4114` maintainer, update the version, then run:

```bash
npm publish --access public
```

`prepack` runs the production build. GitHub remains the host for `install.sh` and `install.ps1`; npm is only the package registry.

## License

[MIT](./LICENSE)
