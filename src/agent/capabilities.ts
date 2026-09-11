import { formatCustomCommand, listCustomCommands } from "../commands/store.js";

export const RAYA_CLI_COMMANDS = [
  ["raya", "Start the interactive TUI"],
  ["raya <prompt>", "Run a one-shot agent request"],
  ["raya profile [--list]|<name>|list|use|create|show|rename|delete", "Manage isolated Raya profiles; --list explicitly lists them"],
  ["raya commands add|list|show|remove", "Create and manage personal direct commands"],
  ["raya local add|remove|list", "Manage local OpenAI-compatible models"],
  ["raya web", "Start the local Web application demo"],
  ["raya login / logout", "Manage provider authentication"],
  ["raya gateway --setup|--start|--restart", "Configure or run Telegram"],
  ["raya plugin install|list", "Manage supported Pi packages"],
  ["raya mcp list|add|enable|disable|remove|test", "Manage MCP servers"],
  ["raya skills list|sync", "Inspect or synchronize built-in skills"],
  ["raya update", "Create a local checkpoint, preserve RAYA_HOME, and install the pinned GitHub update after confirmation"],
  ["raya backup --setup|--list|--restore", "Configure, create, inspect, or restore local and GitHub backups"],
  ["raya uninstall", "Remove Raya, local state, launchers, and backups after typed confirmation"],
  ["raya providers / models", "Inspect providers and models"],
  ["raya config / status", "Change or inspect Raya configuration"],
  ["raya yt / search / serach", "Open YouTube or web searches"],
  ["raya git", "Stage, commit, and push the current repository"],
  ["raya open", "Open a desktop application"]
] as const;

export const RAYA_SLASH_COMMANDS = [
  ["/help", "Show available commands"],
  ["/providers", "Connect, update, or choose providers"],
  ["/models", "Choose a model, then choose one of its provider-reported reasoning levels"],
  ["/thinking", "Set the model reasoning level"],
  ["/character", "Choose Raya's personality"],
  ["/profile", "Create, inspect, or switch isolated Raya profiles"],
  ["/theme", "Choose and apply the global theme"],
  ["/security", "Choose Standard or Full access"],
  ["/sessions", "Create, open, or delete sessions"],
  ["/mcps", "Show configured MCP servers"],
  ["/skills", "Attach one or more skills to a message"],
  ["/about", "Show Raya's complete capability overview"],
  ["/status", "Show current runtime status"],
  ["/clear", "Clear the current conversation"],
  ["/exit", "Exit Raya"]
] as const;

function customCommandLines(): string[] {
  return listCustomCommands().map((command) =>
    `- raya ${command.name} [args...]: ${command.description ?? `runs ${formatCustomCommand(command)}`}`
  );
}

export function rayaCapabilityContext(): string {
  const custom = customCommandLines();
  return `# Raya capability map

User-facing CLI:
${RAYA_CLI_COMMANDS.map(([syntax, description]) => `- ${syntax}: ${description}.`).join("\n")}
${custom.length ? `\nInstalled personal commands:\n${custom.join("\n")}\n` : ""}
Interactive TUI commands:
${RAYA_SLASH_COMMANDS.map(([syntax, description]) => `- ${syntax}: ${description}.`).join("\n")}
- !<command>: run a direct terminal line without sending it to the model.

Agent tools:
- list_files, read_file: inspect files under the active workspace.
- shell: run bounded shell commands under the active workspace with blocked-command checks.
- web: search public web text or fetch a public URL; private and local addresses are blocked.
- memory: add, replace, or remove global USER.md preferences and active-profile MEMORY.md knowledge.
- sessions: list, search, or read saved Raya sessions.
- schedule: create, list, or cancel one-time and daily Telegram reminders.
- use_skill: progressively load a matching instruction skill.
- subagent: delegate one bounded task with the current model, mode, workspace, and MCP access.
- write_file, app_control, create_skill: Build-only mutation capabilities for files, applications, and reusable skills.
- Connected MCP servers may add namespaced tools plus mcp_list_resources, mcp_read_resource, mcp_list_prompts, and mcp_get_prompt.

Interfaces and persistence:
- The same agent core supports the TUI, one-shot CLI, local Web app, Telegram gateway, scheduler, and subagents.
- Raya runs on Windows, macOS, and Linux. Windows installation and updates use PowerShell; shell execution uses the host command processor; URL, application, clipboard, npm launcher, backup, restore, update, and uninstall paths are platform-aware.
- Providers include configured cloud models and local OpenAI-compatible endpoints such as Ollama, LM Studio, vLLM, or llama.cpp.
- State is separated across config.json, owner-only .env credentials, commands.json, sessions.json, global USER.md, scheduled.json, web.json, plugins, skills, and profiles/<name> under RAYA_HOME (normally ~/.raya). Provider/API/Telegram credentials and CLI-supplied MCP values are stored atomically in .env; Windows private files receive an owner-only ACL. Every profile owns SOUL.md, AGENTS.md, MEMORY.md, and readable session transcripts; session records are filtered by active profile.
- raya backup stores each local version directly in its own ~/raya-backups/<name> folder. GitHub snapshots deliberately exclude .env, auth.json, and literal MCP headers/environment values, retain environment placeholders, and use a temporary clone deleted after create, list, or restore.
- Before installing an update, Raya must successfully create a complete local update checkpoint under ~/raya-backups. The installer receives a disposable RAYA_HOME and the exact checked Git commit, so no existing file or directory under the user's RAYA_HOME is created, replaced, migrated, or deleted by the update.
- The active profile's AGENTS.md supplies durable profile instructions and SOUL.md supplies its user-authored personality. The nearest workspace AGENTS.md is loaded separately for project-specific rules. Profiles isolate identity, memory, and sessions, but do not create an OS sandbox or duplicate shared providers, credentials, MCP, skills, commands, or schedules.

Boundaries:
- Raya is the orchestration product, not the selected language model.
- Plan is investigation-oriented; Build enables mutation. Standard asks before consequential actions; Full skips that prompt but not blocked-command checks.
- Skills are instructions, MCP adds capabilities, and personal raya commands are explicit local executable shortcuts. None of them creates an OS sandbox.
- Remote MCP endpoints require HTTPS except on loopback. Server readOnlyHint metadata is not trusted in Plan unless trustReadOnlyAnnotations is explicitly enabled for that server.
- Raya Web binds to loopback and requires a random per-run API token in addition to strict Host/Origin checks. Telegram requires an allowed chat ID and binds each approval to the user who requested it.
- raya uninstall requires the exact word UNINSTALL. It removes the installed package, RAYA_HOME, installer launchers, and normally ~/raya-backups, but does not delete Node.js, unrelated developer source checkouts, or a remote GitHub repository.
- Do not claim browser automation, hosted 24/7 operation, native Pi-extension execution, or any capability absent from the running tools.`;
}

export function rayaAboutMarkdown(): string {
  return [
    "# Raya A.P.P.L.E.",
    "",
    "**Adaptive Personal Processing and Logic Engine**",
    "",
    "Raya is the orchestration layer around selectable AI models, local tools, MCP servers, skills, memory, sessions, personal commands, and terminal, Web, or Telegram interfaces.",
    "",
    rayaCapabilityContext()
  ].join("\n");
}
