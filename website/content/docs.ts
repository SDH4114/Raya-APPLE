export type DocBlock =
  | { type: "p"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "list"; items: string[] }
  | { type: "callout"; tone: "note" | "tip" | "warning" | "security" | "limitation"; title: string; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export type DocSection = { id: string; title: string; blocks: DocBlock[] };
export type DocPage = { slug: string; title: string; description: string; sections: DocSection[] };

const p = (text: string): DocBlock => ({ type: "p", text });
const code = (value: string, language = "bash"): DocBlock => ({ type: "code", code: value, language });
const list = (...items: string[]): DocBlock => ({ type: "list", items });
const callout = (tone: Extract<DocBlock, { type: "callout" }>["tone"], title: string, text: string): DocBlock => ({ type: "callout", tone, title, text });
const table = (headers: string[], rows: string[][]): DocBlock => ({ type: "table", headers, rows });

export const docs: DocPage[] = [
  {
    slug: "quickstart",
    title: "Quickstart",
    description: "Go from a clean terminal to your first Plan and Build session.",
    sections: [
      { id: "prerequisites", title: "Prerequisites", blocks: [p("Raya supports Windows, macOS, and Linux and requires Node.js 22 or newer. The installers can provision Node through winget on Windows or nvm on macOS/Linux when needed."), callout("note", "Provider setup is optional", "The first run lets you skip provider setup. Connect one later with raya login, or register a local OpenAI-compatible endpoint.")] },
      { id: "install", title: "1. Install Raya", blocks: [p("Windows PowerShell:"), code("$p = Join-Path $env:TEMP 'raya-install.ps1'\nirm https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.ps1 -OutFile $p\n& $p", "powershell"), p("macOS or Linux:"), code("curl -fsSL https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.sh -o /tmp/raya-install.sh\nbash /tmp/raya-install.sh"), p("The installer is downloaded first so it can be inspected before execution. It clones Raya into a temporary directory, builds a package tarball with npm lifecycle scripts disabled, installs it globally, initializes only missing state, and removes the checkout.")] },
      { id: "first-run", title: "2. Start the first session", blocks: [code("raya"), p("Choose a provider, or press Enter to continue without one. When connected, open Raya in the project directory you want it to understand."), code("cd ~/projects/my-app\nraya\n\n[Plan] > map this project and explain its architecture", "text")] },
      { id: "plan-build", title: "3. Plan, then Build", blocks: [p("Raya begins in Plan by default. Review the investigation, press Tab to switch the current session to Build, then ask for a focused implementation."), code("[Build] > implement the first step and run the relevant tests", "text"), callout("security", "Review consequential work", "Standard security asks before consequential Build actions. Full mode removes that prompt but does not turn Raya into a sandbox.")] },
      { id: "explore", title: "4. Explore the environment", blocks: [code("/profile\n/sessions\n/skills\n/mcps\n/security\n/about", "text"), p("Use /profile for isolated personal agents, /sessions for profile- and workspace-bound conversations, /skills to attach reusable instructions, /mcps to inspect connected servers, and /about for the runtime capability map.")] }
    ]
  },
  {
    slug: "installation",
    title: "Installation",
    description: "Install Raya from GitHub, build it for development, and troubleshoot PATH.",
    sections: [
      { id: "supported-platforms", title: "Supported platforms", blocks: [table(["Platform", "Status", "Requirement"], [["Windows 10/11", "Supported", "PowerShell 5.1+, Node.js 22+; winget for automatic prerequisites"], ["macOS", "Supported", "Node.js 22+"], ["Linux", "Supported", "Node.js 22+"]]), callout("tip", "Windows Terminal", "Use Windows Terminal for the best multiline input, key-chord, Unicode, color, and resize behavior in Raya's interactive TUI.")] },
      { id: "installer", title: "GitHub installer", blocks: [p("Windows PowerShell:"), code("$p = Join-Path $env:TEMP 'raya-install.ps1'\nirm https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.ps1 -OutFile $p\n& $p", "powershell"), p("macOS or Linux:"), code("curl -fsSL https://raw.githubusercontent.com/SDH4114/Raya-APPLE/prime/install.sh -o /tmp/raya-install.sh\nbash /tmp/raya-install.sh"), p("The Windows installer uses existing Node.js 22+ and Git, or provisions missing prerequisites through winget. The Unix installer verifies the commit-pinned nvm bootstrap with SHA-256 when Node is missing. Both disable npm lifecycle scripts, install a packed archive, preserve existing state, initialize only a fresh installation, and avoid links into the temporary checkout."), p("The normal update path creates a complete local checkpoint before selecting install.ps1 on Windows or install.sh on macOS/Linux. Both receive the exact checked Git commit and a disposable RAYA_HOME. Older clients get the same compatibility checkpoint before replacement."), callout("note", "npm publication", "The source currently documents the npm package name @sdh4114/raya, but GitHub remains the working pre-publication install path.")] },
      { id: "development", title: "Development install", blocks: [code("git clone https://github.com/SDH4114/Raya-APPLE.git\ncd Raya-APPLE\nnpm install\nnpm run build\nnpm link\nraya") ] },
      { id: "update", title: "Update, backup, and uninstall", blocks: [p("raya update checks the current GitHub commit and version, asks for explicit confirmation, and then requires a complete local checkpoint before installation. The same commit is used for metadata, installer download, and repository checkout."), code("raya update\n# checkpoint: ~/raya-backups/update-<current>-to-<target>-<timestamp>/\nraya backup --setup\nraya backup\nraya backup --list\nraya backup --restore <reference>\nraya uninstall"), p("During update the installer receives a disposable temporary RAYA_HOME, so the user's real ~/.raya is not created, replaced, migrated, synchronized, or deleted. If checkpoint creation fails, installation never starts. Update checkpoints include local credentials and must remain private."), p("Every local version contains all of RAYA_HOME. GitHub snapshots exclude .env, auth.json, and literal MCP header/environment values while retaining safe placeholders; restore installs its archive with lifecycle scripts disabled. Use a private repository because remaining state may still be personal."), callout("warning", "Complete local removal", "raya uninstall requires typing UNINSTALL, removes the global package, launchers, RAYA_HOME, and local backups. Add --keep-backups to preserve backup history. Developer source repositories, Node.js, and remote GitHub repositories are not removed.")] },
      { id: "path", title: "PATH troubleshooting", blocks: [p("Windows PowerShell:"), code("Get-Command raya\nnpm.cmd prefix -g\n$env:Path -split ';'", "powershell"), p("macOS or Linux:"), code("command -v raya\nnpm prefix -g"), p("Windows installs npm's raya.cmd shim in the global npm prefix and adds that directory to the user PATH when missing. The Unix installer tries a writable PATH entry, then falls back to ~/.local/bin and updates existing zsh or bash startup files. Open a new terminal only if another process still holds the older PATH.")] }
    ]
  },
  {
    slug: "cli",
    title: "CLI and terminal UI",
    description: "Interactive sessions, one-shot prompts, attachments, history, and direct commands.",
    sections: [
      { id: "entrypoints", title: "Ways to run Raya", blocks: [code("raya                         # interactive TUI\nraya \"explain this repository\" # one-shot request\nraya web                     # localhost Web app\nraya gateway --start         # Telegram gateway"), p("The same agent assembly supports these interfaces. Provider, model, tools, MCP runtime, and persistent state come from the same Raya configuration.")] },
      { id: "input", title: "Input and attachments", blocks: [list("Type @ to choose workspace files or folders; selections become @file or @folder markers.", "Paste images to create numbered image attachments when the selected model supports them.", "Shift+Enter inserts a real newline. Enter submits or selects a menu item.", "Outside menus, Up and Down move through submitted prompt history for single-line input.", "Start a line with ! to execute it directly without sending it to the model or storing it in the conversation."), callout("security", "Direct shell is direct", "A ! command runs with your operating-system permissions. It is an explicit local terminal action, not an agent request.")] },
      { id: "hotkeys", title: "Default hotkeys", blocks: [table(["Action", "Default", "Purpose"], [["toggleMode", "Tab", "Switch Plan / Build for this session"], ["cancel", "Escape", "Close a menu or cancel the active run"], ["exit", "Ctrl+C", "Exit Raya"], ["clearScreen", "Ctrl+L", "Clear terminal scrollback"]]), code("raya config --hotkey toggleMode=ctrl+m\nraya config --reset-hotkeys") ] },
      { id: "rendering", title: "Readable work output", blocks: [p("Answers render Markdown in the terminal. Tool activity appears in compact panels; writes show unified diffs and shell activity shows command, output, and exit code. The footer keeps context usage, model, reasoning level, working directory, and Raya version visible.")] },
      { id: "shortcuts", title: "Direct shortcuts", blocks: [code("raya yt                    # opens YouTube\nraya yt terminal agents    # searches YouTube\nraya search Model Context Protocol\nraya git\nraya open Safari"), p("raya serach is kept as an alias for raya search. The git shortcut stages all changes, asks for a commit message, commits, and pushes; review the working tree before invoking it.")] }
    ]
  },
  {
    slug: "configuration",
    title: "Configuration",
    description: "Validated settings, separate secrets, and the RAYA_HOME state boundary.",
    sections: [
      { id: "home", title: "RAYA_HOME", blocks: [p("Raya stores state under ~/.raya by default. Set RAYA_HOME before launching Raya to isolate or relocate the complete state directory."), code("export RAYA_HOME=/path/to/raya-state\nraya status"), list("config.json — validated settings without CLI-supplied secret values", ".env — owner-only provider, API, Telegram, backup, and MCP secrets", "profiles/<name>/ — SOUL.md, AGENTS.md, MEMORY.md, metadata, and readable sessions", "sessions.json — structured conversations bound to profile and workspace", "USER.md — durable preferences shared by every profile", "commands.json, scheduled.json, web.json — shared feature stores", "skills/ and plugins/ — shared installed extensions")] },
      { id: "backups", title: "Backups and rollback", blocks: [code("raya backup --setup                    # interactive local/GitHub choice\nraya backup --local \"before-upgrade\"   # local setup plus named backup\nraya backup --github <private-repo-url> # explicit GitHub setup\nraya backup                            # create a named version\nraya backup --list\nraya backup --restore <reference>       # always asks GitHub or Local"), p("Each local version is an independent ~/raya-backups/<name>/ folder. Code, .raya, manifest.json, and raya-package.tgz are stored directly inside it, with no date folder, snapshot wrapper, or local Git repository. Later backups are sibling folders and duplicate names are rejected. --list prints separate GitHub and Local sections with names, Raya versions, creation dates, and restore commands. Old nested local snapshots remain restorable."), p("Restore always asks which source to use, then requires typing RESTORE. GitHub credentials are handled by Git itself; Raya stores the exact target owner-only in .env, keeps credential files out of Git commits, and deletes its temporary checkout after create, list, or restore."), callout("security", "Remote state is sensitive", "Use a private repository. GitHub mode excludes .env and auth.json, but sessions, memory, SOUL.md, and configuration can still contain personal information.")] },
      { id: "update-checkpoints", title: "Automatic update checkpoints", blocks: [p("Every confirmed update writes a unique local checkpoint before installing anything, regardless of whether normal backups are unconfigured, Local, or GitHub. A same-timestamp collision receives a suffix instead of replacing the earlier checkpoint."), code("~/raya-backups/update-0.1.4-to-0.1.5-20260723T101112Z/\n├── .raya/\n├── manifest.json\n└── raya-package.tgz", "text"), callout("security", "Update cannot touch RAYA_HOME", "The update command avoids startup migrations and skill synchronization, then runs the installer against a temporary state directory. The user's existing .raya remains outside that process.")] },
      { id: "backup-layout", title: "Exact backup layout", blocks: [code("~/raya-backups/\n├── before-upgrade/\n│   ├── .raya/\n│   ├── src/\n│   ├── builtin-skills/\n│   ├── package.json\n│   ├── manifest.json\n│   └── raya-package.tgz\n└── after-upgrade/\n    ├── .raya/\n    ├── src/\n    ├── builtin-skills/\n    ├── package.json\n    ├── manifest.json\n    └── raya-package.tgz", "text"), p("The source keeps its normal internal folders, but Raya adds no timestamp directory and no snapshot, snapshots, backups, raya-source, raya-home, or .git wrapper. A duplicate name is rejected, and an incomplete named folder is removed if creation fails."), table(["Operation", "Local", "GitHub"], [["Create", "Writes ~/raya-backups/<name> directly", "Clones temporarily, commits .raya-backup, pushes, deletes clone"], ["List", "Scans named folders under ~/raya-backups", "Clones temporarily and reads remote commit manifests"], ["Restore", "Reads the chosen named folder", "Checks out the chosen remote commit temporarily"], ["Secrets", "Includes complete .raya state", "Excludes .env, auth.json, literal MCP values"]])] },
      { id: "common", title: "Common changes", blocks: [code("raya config --provider openai-codex --model gpt-5.4\nraya config --mode plan --thinking medium\nraya config --security standard\nraya config --theme ocean --design small"), p("The CLI updates only requested fields. Unknown keys in a valid config object are preserved for forward compatibility.")] },
      { id: "command-policy", title: "Shell command policy", blocks: [code('{\n  "autoApproveCommands": ["npm test", "git status"],\n  "blockedCommands": ["rm", "rm -rf"]\n}', "json"), callout("security", "Defense in depth", "Blocked prefixes are checked across common wrappers and chains, but a deny-list is not an operating-system sandbox.")] },
      { id: "invalid-json", title: "Malformed configuration", blocks: [p("Raya validates stored JSON before use. Keep secrets out of config.json. If you edit the file manually, preserve a top-level JSON object and use the documented fields from the configuration reference.")] }
    ]
  },
  {
    slug: "providers",
    title: "Providers and models",
    description: "Connect OAuth or API-key providers and select a model without coupling Raya to one vendor.",
    sections: [
      { id: "types", title: "Provider types", blocks: [table(["Type", "Examples", "Credential"], [["OAuth", "OpenAI Codex", "ChatGPT Plus / Pro / Codex OAuth"], ["API key", "OpenAI API, Moonshot AI, Anthropic, OpenRouter, OpenCode Zen, Hugging Face", "Provider-specific key or token"], ["Local OpenAI-compatible", "Ollama, LM Studio, vLLM, llama.cpp", "Keyless by default"]])] },
      { id: "connect", title: "Connect and inspect", blocks: [code("raya login\nraya login openai      # API key: GPT-5.6 family\nraya login moonshotai  # API key: Kimi K3\nraya providers\nraya models --provider openai\nraya status\nraya logout openai"), p("The interactive /providers menu can connect or update credentials and select a provider. /models lists models across configured providers.")] },
      { id: "latest-models", title: "GPT-5.6 and Kimi K3", blocks: [p("The direct OpenAI API catalog includes gpt-5.6 (the Sol alias), gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna. OpenAI Codex OAuth also lists gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna when they are available to the connected account. The Moonshot AI catalog includes kimi-k3. These entries retain their provider-specific context, image, reasoning, output-limit, and token-cost metadata."), code("raya config --provider openai --model gpt-5.6\nraya config --provider openai-codex --model gpt-5.6-sol\nraya config --provider moonshotai --model kimi-k3") ] },
      { id: "model-settings", title: "Model settings", blocks: [p("After you choose a model in /models, Raya reads that model's provider metadata and immediately opens a second picker containing only its supported reasoning levels. This includes max where the provider exposes it. /thinking uses the same model-specific list, and incompatible stored levels are corrected when a model or session is loaded. Raya also records context window and maximum output tokens."), callout("limitation", "Reasoning is not orchestration", "The selected model provides reasoning. Raya supplies system context, tools, skills, memory, sessions, approvals, and interfaces.")] }
    ]
  },
  {
    slug: "local-models",
    title: "Local models",
    description: "Register an already-running OpenAI-compatible endpoint.",
    sections: [
      { id: "lifecycle", title: "What Raya does", blocks: [p("Raya registers and calls local OpenAI-compatible chat-completions endpoints. It does not download a model or start Ollama, LM Studio, vLLM, or llama.cpp for you."), callout("warning", "Start the server first", "Confirm the endpoint and exact model ID in the local runtime before adding it to Raya.")] },
      { id: "ollama", title: "Ollama", blocks: [code("ollama pull qwen3:8b\nraya local add qwen3:8b\nraya config --provider ollama --model qwen3:8b"), p("Ollama defaults to http://127.0.0.1:11434/v1.")] },
      { id: "other", title: "LM Studio, vLLM, and llama.cpp", blocks: [code("raya local add local-model-id \\\n  --provider lmstudio \\\n  --base-url http://127.0.0.1:1234/v1 \\\n  --name \"My LM Studio model\"\n\nraya local add Qwen/Qwen3-Coder-30B-A3B-Instruct \\\n  --provider vllm \\\n  --base-url http://127.0.0.1:8000/v1 \\\n  --context-window 131072 \\\n  --max-tokens 16384") ] },
      { id: "manage", title: "Manage entries", blocks: [code("raya local list\nraya local remove qwen3:8b --provider ollama"), callout("limitation", "Capability varies", "A server may answer normal chat but still lack reliable tool calling or vision. That is a model/runtime capability, not an automatic Raya guarantee.")] }
    ]
  },
  {
    slug: "plan-build",
    title: "Plan and Build",
    description: "Use investigation and mutation as two explicit phases of work.",
    sections: [
      { id: "plan", title: "Plan", blocks: [p("Plan is investigation-oriented. Raya can inspect workspace files, search public web text, read sessions and memory, load skills, and use read-only MCP tools. Common mutating shell operations are restricted."), code("[Plan] > trace how authentication reaches the provider runtime and propose a safe change", "text")] },
      { id: "build", title: "Build", blocks: [p("Build exposes file writing, application control, and skill authoring in addition to the read-oriented toolset. Standard security requests approval for consequential actions; Full skips that interactive prompt."), code("[Build] > implement the approved change, run focused tests, and show the diff", "text")] },
      { id: "session-state", title: "Mode belongs to the session", blocks: [p("Tab changes the active session mode without discarding the current input. Each saved session restores its own Plan or Build mode. Theme remains a global preference."), callout("security", "Mode is not a sandbox", "Plan reduces mutation opportunities, but Raya still runs on your machine with your user permissions. Work only in trusted directories.")] }
    ]
  },
  {
    slug: "tools",
    title: "Built-in tools",
    description: "The executable capabilities exposed through the RayaTool contract.",
    sections: [
      { id: "catalog", title: "Tool catalog", blocks: [table(["Tool", "Capability", "Mode"], [["list_files", "List paths under the workspace", "Plan + Build"], ["read_file", "Read workspace files", "Plan + Build"], ["shell", "Run bounded shell commands with policy checks", "Plan restricted; Build normal"], ["web", "DuckDuckGo text search and public URL fetch", "Plan + Build"], ["memory", "Update USER.md or MEMORY.md", "Plan + Build"], ["sessions", "List, search, and read saved sessions", "Plan + Build"], ["schedule", "Create, list, or cancel reminders", "Plan + Build"], ["use_skill", "Load full skill instructions", "Plan + Build"], ["subagent", "Delegate one bounded task with inherited context and policy", "Plan + Build"], ["write_file", "Create or replace a workspace file and produce a diff", "Build"], ["app_control", "Open or close desktop applications", "Build"], ["create_skill", "Write a reusable skill with approval", "Build"]])] },
      { id: "boundaries", title: "Capability boundaries", blocks: [p("Workspace file operations resolve real paths and reject escapes beyond the active workspace. The web tool blocks local and private network targets. Shell output and duration are bounded by configuration."), callout("security", "Tools execute locally", "Tool checks reduce accidents; they do not create process, filesystem, or network isolation.")] },
      { id: "extensions", title: "Extended tools", blocks: [p("Connected MCP servers add namespaced executable tools plus resource and prompt adapters. The subagent tool is assembled separately so a delegated agent inherits the current model, mode, workspace policy, and MCP runtime.")] }
    ]
  },
  {
    slug: "mcp",
    title: "MCP",
    description: "Extend Raya with stdio, Streamable HTTP, and legacy SSE servers.",
    sections: [
      { id: "stdio", title: "Add a stdio server", blocks: [code("raya mcp add filesystem \\\n  --command npx \\\n  --arg=-y \\\n  --arg @modelcontextprotocol/server-filesystem \\\n  --arg \"$PWD\"\nraya mcp test filesystem") ] },
      { id: "remote", title: "Add an HTTP or SSE server", blocks: [code("export MY_MCP_TOKEN=\"...\"\nraya mcp add company \\\n  --url https://mcp.example.com/mcp \\\n  --header 'Authorization=Bearer ${MY_MCP_TOKEN}'\n\nraya mcp add legacy \\\n  --url https://mcp.example.com/sse \\\n  --transport sse"), p("Remote endpoints require HTTPS; HTTP is allowed only on loopback. Environment placeholders are expanded at connection time, and literal --header/--env values are moved to owner-only secret storage.")] },
      { id: "manage", title: "Manage and test", blocks: [code("raya mcp list\nraya mcp test filesystem\nraya mcp disable filesystem\nraya mcp enable filesystem\nraya mcp remove filesystem"), p("Enabled servers connect once when the host starts and close on teardown. One unavailable optional server is reported without preventing the others from starting; the test command is intentionally strict.")] },
      { id: "capabilities", title: "Tools, resources, and prompts", blocks: [p("Tool names are collision-safe, for example mcp_filesystem_read_file. Resources and prompts are exposed through mcp_list_resources, mcp_read_resource, mcp_list_prompts, and mcp_get_prompt."), callout("security", "External trust boundary", "Plan blocks executable MCP tools by default. Use --trust-read-only only after reviewing a server; then Plan may use tools carrying readOnlyHint. Standard Build still follows always, writes, or never approval policy.")] }
    ]
  },
  {
    slug: "skills",
    title: "Skills",
    description: "Progressively loaded instructions for repeatable workflows.",
    sections: [
      { id: "sources", title: "Skill sources", blocks: [list("Built-in skills packaged with Raya", "User skills under ~/.raya/skills/<name>/SKILL.md", "Workspace skills under .agents/skills/<name>/SKILL.md", "Skills contributed by supported Pi packages"), p("Only a compact catalog is added at session start. The use_skill tool loads full instructions and referenced resources when they become relevant.")] },
      { id: "attach", title: "Attach a skill", blocks: [p("Open /skills and choose a skill. Raya inserts an @skill:<name> marker into the current input. Repeat the picker to attach more than one skill before submitting."), code("@skill:debugging @skill:implementation fix this failure", "text")] },
      { id: "sync", title: "Synchronize built-ins", blocks: [code("raya skills list\nraya skills sync\nraya skills sync --force"), p("Normal sync installs only missing built-ins and preserves user edits. --force deliberately replaces installed built-in folders with packaged versions.")] },
      { id: "author", title: "Create a skill", blocks: [p("In Build mode, create_skill can write a persistent skill when you explicitly ask Raya to teach itself a reusable workflow. Standard security asks before the write."), callout("note", "Instructions, not permissions", "A skill changes context and procedure. It does not execute code, add an operating-system permission, or bypass Plan, Build, or approval rules.")] }
    ]
  },
  {
    slug: "profiles",
    title: "Profiles",
    description: "Run named Raya roles with isolated identity, instructions, memory, and sessions.",
    sections: [
      { id: "model", title: "What a profile isolates", blocks: [p("A profile is a managed directory under ~/.raya/profiles/<name>. It owns SOUL.md, AGENTS.md, MEMORY.md, metadata, and readable session transcripts. Structured sessions are additionally tagged with the profile, so /sessions cannot cross role boundaries."), callout("note", "Shared connections", "Providers, credentials, MCP servers, skills, commands, schedules, USER.md, and visual settings remain shared. Profiles are roles and continuity boundaries, not operating-system sandboxes.")] },
      { id: "manage", title: "Create and switch", blocks: [code("raya profile --list                  # explicit list alias\nraya profile                         # list and show active\nraya profile create coder            # fresh profile\nraya profile create work --clone     # copy SOUL + AGENTS\nraya profile create twin --clone-all # also copy MEMORY\nraya profile coder                   # switch\nraya profile show coder"), p("The explicit form raya profile use coder is equivalent. --clone-from selects another source profile. /profile opens a searchable TUI picker; /profile create <name> clones the active identity and activates the new profile.")] },
      { id: "lifecycle", title: "Lifecycle and migration", blocks: [code("raya profile rename coder engineer\nraya profile delete engineer"), p("The default profile cannot be renamed or deleted, and an active profile cannot be deleted. Deletion requires typed confirmation in the CLI or interactive approval in the TUI."), p("On first profile-aware startup, legacy root SOUL.md, AGENTS.md, and MEMORY.md are copied into profiles/default and preserved at their old paths as a recoverable migration source.")] },
      { id: "switch", title: "What happens on switch", blocks: [p("Raya saves the current session, selects the profile, rebuilds the agent so the new system prompt and frozen memory snapshot take effect, and starts a clean session. The startup dashboard and permanent footer identify the active profile.")] }
    ]
  },
  {
    slug: "sessions",
    title: "Sessions",
    description: "Workspace-bound conversation state with readable transcripts.",
    sections: [
      { id: "storage", title: "What a session stores", blocks: [p("Structured state lives in ~/.raya/sessions.json. Each saved session also receives a Markdown transcript under ~/.raya/profiles/<profile>/sessions/YYYY-MM-DD/<session-id>.md."), list("Conversation messages", "Canonical workspace and profile binding", "Readable name derived from the first prompt", "Per-session Plan or Build mode", "Provider/model configuration snapshot")] },
      { id: "lifecycle", title: "Lifecycle", blocks: [p("A normal raya launch begins with a transient empty session bound to the current directory and active profile. It is persisted only after the first message. /sessions shows only sessions matching both boundaries."), code("/sessions new\n/sessions open <id>\n/sessions delete <id>", "text"), p("In the picker, dd requests deletion and then opens confirmation.")] },
      { id: "difference", title: "Sessions are not memory", blocks: [callout("note", "Two kinds of continuity", "Sessions preserve profile-bound conversation state. Global USER.md and the active profile's MEMORY.md preserve compact durable facts that can be useful across sessions.")] }
    ]
  },
  {
    slug: "memory",
    title: "Durable memory",
    description: "Compact, user-owned facts across sessions—not an unlimited transcript.",
    sections: [
      { id: "files", title: "Memory files", blocks: [table(["File", "Purpose", "Prompt snapshot limit"], [["USER.md", "Global preferences and durable user facts shared by profiles", "1,375 characters"], ["profiles/<name>/MEMORY.md", "Profile-specific decisions and reusable lessons", "2,200 characters"]]), p("The memory tool can add, replace, or remove durable entries. Changes are persisted immediately and become available to later sessions of the same profile.")] },
      { id: "good-memory", title: "What belongs in memory", blocks: [list("Stable preferences", "Corrections that prevent repeat errors", "Long-lived project decisions", "Reusable lessons from completed work"), callout("limitation", "Raya does not remember everything", "Conversation transcripts stay in sessions. Durable memory is intentionally compact and selective.")] },
      { id: "portability", title: "Ownership and portability", blocks: [p("Memory is ordinary Markdown under RAYA_HOME. You can inspect, edit, back up, or relocate it with the rest of Raya state.")] }
    ]
  },
  {
    slug: "context-files",
    title: "AGENTS.md and SOUL.md",
    description: "Separate project instructions from the personality you own.",
    sections: [
      { id: "agents", title: "AGENTS.md", blocks: [p("The active profile's AGENTS.md carries durable role instructions. Raya also loads the nearest workspace AGENTS.md separately for project conventions, testing requirements, safety rules, scope boundaries, and repository maps.")] },
      { id: "soul", title: "SOUL.md", blocks: [p("Each profile's SOUL.md defines its user-authored tone, style, and character. It is deliberately visible and editable—not a hidden system prompt."), code("/character\n# replaces only the active profile's SOUL.md", "text"), p("Choosing a character rebuilds the current agent so the change applies immediately. Existing profile files are never reset during normal startup.")] },
      { id: "resolution", title: "Prompt order", blocks: [code("~/.raya/profiles/<active>/SOUL.md\n~/.raya/profiles/<active>/AGENTS.md\n<nearest-workspace>/AGENTS.md", "text"), callout("tip", "Predictable identity", "Workspace SOUL.md does not override the selected profile. Switch profiles explicitly with /profile or raya profile <name>.")] }
    ]
  },
  {
    slug: "telegram",
    title: "Telegram gateway",
    description: "Reach the local Raya process from your own Telegram bot.",
    sections: [
      { id: "setup", title: "Setup", blocks: [p("Create a bot with @BotFather, copy its token, then configure Raya."), code("raya gateway --setup\nraya gateway --start"), p("Use --restart to establish a fresh Telegram connection in the current terminal.")] },
      { id: "availability", title: "Local process requirement", blocks: [callout("limitation", "Not a hosted service", "The bot works only while the Raya TUI or gateway process is running on your computer. Closing the process or turning off the machine makes it unavailable.")] },
      { id: "approvals", title: "Remote approvals", blocks: [p("Dangerous Telegram-originated actions wait for inline Approve or Deny buttons. Timeout and denial stop the action, and only the same Telegram user who initiated the request can approve it."), callout("security", "Restricted by default", "An allowed chat ID is mandatory. Messages from every other chat are ignored.")] }
    ]
  },
  {
    slug: "scheduling",
    title: "Scheduling",
    description: "Persist one-time and daily tasks for Telegram delivery.",
    sections: [
      { id: "model", title: "Task model", blocks: [p("The schedule tool creates, lists, and cancels one-time or daily tasks. They are stored in ~/.raya/scheduled.json and loaded again when Raya starts."), list("One-time task at a specific time", "Daily repeating task", "Telegram delivery", "Optional browser notification for Web reminders")] },
      { id: "delivery", title: "Delivery and retry", blocks: [p("Every scheduled task requires Telegram delivery. If Telegram is unavailable or sending fails, Raya leaves the task pending for retry. Web reminders additionally create browser notifications."), callout("limitation", "A process must be running", "Scheduling is persistent, but execution is not a hosted daemon. A Raya process must be active to dispatch due work.")] }
    ]
  },
  {
    slug: "web",
    title: "Raya Web",
    description: "A localhost browser workspace backed by the same agent core.",
    sections: [
      { id: "start", title: "Start the app", blocks: [code("raya web\nraya web --port 5000\nraya web --no-open"), p("The server binds to 127.0.0.1 and defaults to port 4177. Every run generates a private URL-fragment token required by all API calls; Host and Origin are also validated.")] },
      { id: "workspace", title: "Workspace surface", blocks: [list("Chat and saved sessions", "Plan / Build switching and browser approvals", "Calendar, reminders, and scheduled tasks", "Registered workspaces and file listing", "AGENTS.md and SOUL.md editing per workspace", "Connected notes with [[Note title]] bidirectional links"), p("Web-specific state is stored in owner-only ~/.raya/web.json.")] },
      { id: "security", title: "Local security", blocks: [p("The Web server rejects cross-origin requests and serves a restrictive content-security policy. Files are resolved from registered workspace roots."), callout("security", "Localhost is not a sandbox", "The Web interface controls the same local tools. Standard approvals remain important, especially for Build mode.")] }
    ]
  },
  {
    slug: "security",
    title: "Security",
    description: "Understand Raya's trust model before granting an agent local tools.",
    sections: [
      { id: "trust", title: "Trust model", blocks: [p("Raya is a local agent harness. Shell and filesystem tools execute with the permissions of the user who started Raya. Use it only in workspaces and with providers, skills, packages, and MCP servers you trust."), callout("security", "Raya is not a sandbox", "Plan restrictions, confirmations, path checks, and blocked commands reduce risk. They do not provide operating-system isolation.")] },
      { id: "modes", title: "Standard, Full, and Plan", blocks: [table(["Control", "Behavior"], [["Plan", "Restricts common mutation and exposes read-oriented tools"], ["Build + Standard", "Enables mutation and asks before consequential actions"], ["Build + Full", "Skips interactive approval; blocked commands still apply"]]), code("/security standard\nraya config --security standard", "text")] },
      { id: "shell", title: "Shell and filesystem", blocks: [p("Workspace writes resolve paths and symlinks to stay within the active root. Shell commands are checked against blocked prefixes, including common wrappers and chains. autoApproveCommands can bypass routine confirmations for trusted prefixes."), callout("warning", "Deny-lists are incomplete by nature", "A permitted interpreter, package script, or executable can still perform indirect mutation. Review commands and avoid Full mode for unfamiliar repositories.")] },
      { id: "external", title: "MCP, Web, and Telegram", blocks: [p("MCP servers are independent trust domains; read-only annotations are ignored unless explicitly trusted per server. Telegram requires an allowed chat ID and binds approvals to the requesting user. Raya Web requires a random per-run API token and validates Host and Origin."), p("Provider, API, Telegram, backup, and CLI-supplied MCP secrets live in owner-only .env storage. Writes are atomic and cross-process serialized; Windows applies an owner-only ACL.")] },
      { id: "recommendations", title: "Safe operating habits", blocks: [list("Start in Plan and review the proposed scope.", "Use Standard security for everyday work.", "Keep destructive prefixes in blockedCommands.", "Run inside a focused, version-controlled workspace.", "Inspect skills and MCP configuration before enabling them.", "Keep an allowed Telegram chat ID configured.", "Review diffs and test output before publishing changes.")] }
    ]
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "How the CLI, model runtime, tools, context, and interfaces fit together.",
    sections: [
      { id: "flow", title: "Runtime flow", blocks: [code("User\n  ↓\nCLI / Raya Web / Telegram\n  ↓\nRaya orchestration\n  ├─ model runtime (reasoning)\n  ├─ tools + MCP (actions)\n  ├─ skills (procedures)\n  ├─ sessions + memory (continuity)\n  └─ workspace + apps + public web", "text"), p("src/cli/index.ts parses commands and assembles the selected interface. Provider runtime selects a model, MCP connects enabled servers, and create-agent combines system context with the applicable tools.")] },
      { id: "source-map", title: "Source map", blocks: [table(["Area", "Ownership"], [["src/cli", "Commands, setup, uninstall guards, process lifecycle"], ["src/backup", "Local/GitHub snapshots, package archives, listing, and restore"], ["src/providers", "Authentication, model discovery, runtime adapters"], ["src/profiles", "Named identity, instruction, memory, and session boundaries"], ["src/agent", "System context and pi-agent-core assembly"], ["src/tools", "Built-in capability contracts and policy metadata"], ["src/tui", "Streaming terminal rendering and input"], ["src/mcp", "External server lifecycle and adapters"], ["src/skills + builtin-skills", "Progressive instruction discovery"], ["src/session + src/memory", "Conversation and durable continuity"], ["src/telegram + src/scheduler", "Remote messages and due-task delivery"], ["src/web", "Local browser application and storage"]])] },
      { id: "boundaries", title: "Important boundaries", blocks: [list("Raya is the harness; the model provides reasoning.", "Tools and MCP provide executable capabilities; skills provide instructions.", "Sessions preserve conversations; memory preserves compact durable facts.", "Interfaces collect approvals; tools declare and enforce capability policy.", "Built-in skill source is packaged, while installed folders are user-owned.")] }
    ]
  },
  {
    slug: "limitations",
    title: "Known limitations",
    description: "The current product boundaries, stated plainly.",
    sections: [
      { id: "current", title: "Current boundaries", blocks: [list("Windows, macOS, and Linux are supported; Windows Terminal is recommended for the complete TUI experience.", "Shell and filesystem access are not sandboxed.", "The web tool performs text search and fetch, not browser clicking or form automation.", "Telegram and scheduled delivery require a running local Raya process.", "Registering a local model does not download or start its server.", "Native Pi CLI extensions require a Raya adapter.", "Tool-calling and vision quality depend on the selected provider and model.", "MCP servers may fail, return untrusted content, or mislabel mutating tools.")] },
      { id: "roadmap", title: "Documented later work", blocks: [p("The repository lists provider-specific setup improvements, real sandboxing, browser automation, optional post-session consolidation, and a more complete plugin loader as later roadmap items—not current capabilities.")] }
    ]
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Build and validate Raya from source before proposing a change.",
    sections: [
      { id: "setup", title: "Development setup", blocks: [code("git clone https://github.com/SDH4114/Raya-APPLE.git\ncd Raya-APPLE\nnpm install\nnpm run build\nnpm test\nnpm run typecheck") ] },
      { id: "map", title: "Choose the owning module", blocks: [p("Start from the architecture page and the repository source map. Keep provider, tool, interface, and persistence responsibilities separate. Add a regression test for behavior that changes.")] },
      { id: "checks", title: "Before opening an issue or contribution", blocks: [code("npm test\nnpm run typecheck\nnpm run build"), list("Use an isolated RAYA_HOME for smoke tests.", "Do not write secrets into config, fixtures, logs, or skills.", "Preserve user-owned skills and unknown config fields.", "Document honest limitations and runtime requirements."), p("Use the project issue tracker for bugs and proposals.")] }
    ]
  },
  {
    slug: "reference/commands",
    title: "Commands reference",
    description: "Every built-in top-level and interactive command in the current capability catalog.",
    sections: [
      { id: "cli", title: "Top-level CLI", blocks: [table(["Command", "Purpose"], [["raya", "Start the interactive TUI"], ["raya <prompt>", "Run a one-shot request"], ["raya login / logout", "Manage provider authentication"], ["raya providers / models", "Inspect providers and models"], ["raya local add|remove|list", "Manage local endpoints"], ["raya config / status", "Change or inspect configuration"], ["raya update", "Checkpoint locally, preserve RAYA_HOME, and install the pinned GitHub commit"], ["raya backup --setup|--list|--restore", "Configure, save, inspect, or restore Raya backups"], ["raya uninstall", "Completely remove Raya after typed confirmation"], ["raya web", "Start the localhost Web app"], ["raya gateway --setup|--start|--restart", "Configure or run Telegram"], ["raya mcp list|add|enable|disable|remove|test", "Manage MCP servers"], ["raya skills list|sync", "Inspect or synchronize skills"], ["raya plugin install|list", "Manage supported Pi packages"], ["raya commands add|list|show|remove", "Manage personal direct commands"], ["raya yt [text]", "Open YouTube, or search it with text"], ["raya search / serach <text>", "Open web search"], ["raya git", "Stage, commit, and push"], ["raya open", "Open a desktop application"]])] },
      { id: "slash", title: "Interactive slash commands", blocks: [table(["Command", "Purpose"], [["/help", "Show commands and shortcuts"], ["/providers", "Connect, update, or choose providers"], ["/models", "Browse and choose models"], ["/thinking", "Set the reasoning level"], ["/character", "Choose Raya's personality"], ["/theme", "Choose Ocean Blue or Sunset Red"], ["/security", "Choose Standard or Full"], ["/sessions", "Create, open, or delete sessions"], ["/mcps", "Show configured MCP servers"], ["/skills", "Attach skills to the message"], ["/about", "Show the complete capability map"], ["/status", "Show runtime status"], ["/clear", "Clear the current conversation"], ["/exit", "Exit Raya"], ["!<command>", "Run a direct terminal line"]])] },
      { id: "personal", title: "Personal direct commands", blocks: [code("raya commands add serve --description \"Start development\" -- npm run dev\nraya serve --port 3000\nraya commands show serve\nraya commands remove serve"), p("Raya stores the executable and argument vector separately and launches without a shell. Extra invocation arguments are appended. Reserved built-in names cannot be replaced.")] }
    ]
  },
  {
    slug: "reference/configuration",
    title: "Configuration reference",
    description: "The validated fields accepted in ~/.raya/config.json.",
    sections: [
      { id: "fields", title: "Core fields", blocks: [table(["Field", "Type / values", "Default"], [["provider", "string", "openai-codex"], ["model", "string", "gpt-5.4"], ["mode", "plan | build", "plan"], ["thinkingLevel", "off | minimal | low | medium | high | xhigh | max", "minimal"], ["securityMode", "standard | full", "standard"], ["headerStyle", "small | large", "small"], ["theme", "ocean | sunset", "ocean"], ["shellTimeoutMs", "positive integer", "120000"], ["webTimeoutMs", "positive integer", "15000"], ["webMaxChars", "positive integer", "12000"]])] },
      { id: "collections", title: "Collections", blocks: [table(["Field", "Purpose"], [["hotkeys", "toggleMode, cancel, exit, clearScreen chords"], ["autoApproveCommands", "Trusted shell prefixes"], ["blockedCommands", "Denied shell prefixes; defaults to rm"], ["localModels", "Registered OpenAI-compatible endpoints"], ["piPackages", "Installed supported package names"], ["mcpServers", "Named stdio, HTTP, or SSE server configs"], ["backup", "Local/GitHub mode, display name, optional local root, sanitized repository, setup time"]])] },
      { id: "mcp-shape", title: "MCP server shape", blocks: [code('{\n  "mcpServers": {\n    "filesystem": {\n      "enabled": true,\n      "transport": "stdio",\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/project"],\n      "env": {},\n      "approval": "writes",\n      "trustReadOnlyAnnotations": false,\n      "timeoutMs": 30000,\n      "toolTimeoutMs": 120000\n    }\n  }\n}', "json"), p("Remote entries replace command/args/env with url/headers and transport http or sse. Compatibility normalization also accepts type as an alias and can infer transport from command or url.")] }
    ]
  }
];

export const docsBySlug = new Map(docs.map((page) => [page.slug, page]));
