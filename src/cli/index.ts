#!/usr/bin/env node

import { Command, Help } from "commander";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, normalizeConfig, updateConfig, type RayaConfig } from "../config/config.js";
import { RAYA_COMMANDS_PATH, RAYA_CONFIG_PATH, RAYA_HOME, RAYA_SKILLS_DIR } from "../config/paths.js";
import { readSecret, writeSecret } from "../config/secrets.js";
import {
  createProviderRuntime,
  clampModelThinkingLevel,
  getConfiguredModel,
  getModelThinkingLevels,
  getProvider,
  isProviderConfigured,
  loginProvider,
  logoutProvider
} from "../providers/runtime.js";
import { providerModelSuggestions } from "../providers/model-picker.js";
import { createRayaAgent, createRayaTools } from "../agent/create-agent.js";
import { RAYA_SLASH_COMMANDS, rayaAboutMarkdown } from "../agent/capabilities.js";
import { commandMatchesAutoApprovePrefix } from "../tools/shell.js";
import { formatToolActivity, renderAgentEvent } from "../tui/render-events.js";
import { notifyTui, requestTerminalApproval, runInteractiveTui } from "../tui/app.js";
import { DEFAULT_HOTKEYS } from "../tui/hotkeys.js";
import { color, setActiveTheme, theme, themeLabels, THEME_IDS, type ThemeId } from "../tui/theme.js";
import { renderMarkdown } from "../tui/markdown.js";
import { startTelegramService } from "../telegram/service.js";
import type { ToolExecutionPolicy } from "../types/tool.js";
import { startScheduler } from "../scheduler/store.js";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { commandInvocation } from "../platform.js";
import { RAYA_PLUGINS_DIR } from "../config/paths.js";
import { openApplication, openUrl, runGitShortcut, webSearchUrl, YOUTUBE_HOME_URL, youtubeSearchUrl } from "./shortcuts.js";
import { normalizePiPackageName } from "../plugins/package.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";
import { runWebServer } from "../web/server.js";
import { formatMcpStatusLines, McpRuntime } from "../mcp/client.js";
import { ensureBuiltinSkills } from "../skills/bootstrap.js";
import { listAvailableSkills } from "../skills/loader.js";
import { characterProfile, characterSuggestions } from "../character/catalog.js";
import { compareVersions, installGithubReleaseWithCheckpoint, isUpdateApproved, readGithubRelease } from "./update.js";
import {
  createBackup,
  discoverBackups,
  RAYA_BACKUP_ROOT,
  RAYA_BACKUP_TARGET_ENV,
  restoreDiscoveredBackup,
  setupGithubBackup,
  setupLocalBackup,
  type BackupListItem
} from "../backup/store.js";
import { isUninstallApproved, uninstallRaya } from "./uninstall.js";
import {
  addCustomCommand,
  formatCustomCommand,
  listCustomCommands,
  removeCustomCommand,
  runCustomCommand
} from "../commands/store.js";
import {
  createSession,
  deleteSessionsForProfile,
  deleteSession,
  findSession,
  getOrCreateActiveSession,
  listSessions,
  saveSession,
  renameSessionProfile,
  switchSession,
  type RayaSession
} from "../session/store.js";
import {
  createProfile,
  deleteProfile,
  ensureProfile,
  listProfiles,
  profilePaths,
  renameProfile
} from "../profiles/store.js";

const program = new Command();
const defaultHelp = new Help();
program.configureHelp({
  subcommandTerm: (command) => {
    const term = defaultHelp.subcommandTerm(command);
    return command.name() === "web" ? term.replace(/^web\b/, "web (demo)") : term;
  }
});
const VERSION = "0.1.5";
let builtinCommandNames = new Set<string>();
setActiveTheme(["uninstall", "update"].includes(process.argv[2] ?? "") ? "ocean" : loadConfig().theme);

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail.catch(() => undefined);
    this.tail = previous.then(() => gate);
    await previous;
    return release;
  }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try { return await operation(); }
    finally { release(); }
  }
}

async function promptWithAbort(agent: Agent, prompt: string, signal: AbortSignal): Promise<void> {
  const abort = (): void => agent.abort();
  if (signal.aborted) throw new Error("Telegram service stopped.");
  signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function formatDirectory(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~/${relative(home, path)}`.replace(/\/$/, "") : path;
}

const preferredProviders = [
  { id: "openai-codex", label: "OpenAI Codex", hint: "ChatGPT/Codex OAuth subscription login" },
  { id: "openai", label: "OpenAI API", hint: "OpenAI API key · GPT-5.6" },
  { id: "anthropic", label: "Anthropic", hint: "Anthropic API key" },
  { id: "moonshotai", label: "Moonshot AI / Kimi", hint: "Moonshot API key · Kimi K3" },
  { id: "openrouter", label: "OpenRouter", hint: "OpenRouter API key" },
  { id: "opencode", label: "OpenCode Zen", hint: "OpenCode API key" },
  { id: "huggingface", label: "Hugging Face", hint: "Hugging Face API token" }
];

function authLabel(provider: { auth: { oauth?: unknown; apiKey?: unknown } }): string {
  const labels = [];
  if (provider.auth.apiKey) labels.push("api");
  if (provider.auth.oauth) labels.push("oauth");
  return labels.join("+") || "unknown";
}

function availablePreferredProviders(runtime: ReturnType<typeof createProviderRuntime>) {
  const available = new Set(runtime.models.getProviders().map((provider) => provider.id));
  return preferredProviders.filter((item) => available.has(item.id));
}

function printProviderMenu(runtime: ReturnType<typeof createProviderRuntime>): void {
  console.log("Choose provider:");
  const providers = runtime.models.getProviders();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  let index = 1;

  for (const item of availablePreferredProviders(runtime)) {
    const provider = byId.get(item.id);
    if (!provider) continue;
    console.log(`${index}. ${item.label} (${provider.id}) - ${authLabel(provider)} - ${item.hint}`);
    index += 1;
  }

  console.log("\nOther providers:");
  for (const provider of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    if (preferredProviders.some((item) => item.id === provider.id)) continue;
    console.log(`- ${provider.id} (${authLabel(provider)})`);
  }

}

async function chooseProvider(runtime: ReturnType<typeof createProviderRuntime>, fallback: string): Promise<string> {
  printProviderMenu(runtime);
  const numbered = availablePreferredProviders(runtime);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`\nProvider [${fallback}] > `)).trim();
    if (!answer) return fallback;
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= numbered.length) {
      return numbered[numeric - 1]!.id;
    }
    return answer;
  } finally {
    rl.close();
  }
}

async function chooseOptionalProvider(runtime: ReturnType<typeof createProviderRuntime>): Promise<string | undefined> {
  printProviderMenu(runtime);
  const numbered = availablePreferredProviders(runtime);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("\nProvider (optional; press Enter to skip) > ")).trim();
    if (!answer) return undefined;
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= numbered.length) {
      return numbered[numeric - 1]!.id;
    }
    return answer;
  } finally {
    rl.close();
  }
}

function buildToolPolicy(config: RayaConfig): ToolExecutionPolicy {
  if (config.mode === "build" && config.securityMode === "full") return { allowWithoutApproval: true };
  if (config.mode !== "build") return {};
  return {
    confirmDangerousAction: async (action, details) => {
      const approved = action === "run shell command" && config.autoApproveCommands.some((command) => commandMatchesAutoApprovePrefix(details, command));
      if (!approved) await requestTerminalApproval(action, details);
    }
  };
}

function applyConfigToAgent(agent: Agent, config: RayaConfig, models: ReturnType<typeof createProviderRuntime>["models"], model?: Model<any>, mcp?: McpRuntime): void {
  if (model) {
    agent.state.model = model;
  }
  agent.state.thinkingLevel = config.thinkingLevel;
  agent.state.tools = createRayaTools({ config, model: model ?? agent.state.model, models, toolPolicy: buildToolPolicy(config), mcp });
}

async function connectConfiguredMcp(config: RayaConfig, options: { only?: string; strict?: boolean; quiet?: boolean } = {}): Promise<McpRuntime> {
  const mcp = await McpRuntime.connect(config, { clientVersion: VERSION, only: options.only, strict: options.strict });
  if (!options.quiet) {
    for (const status of mcp.statuses.filter((item) => item.enabled && !item.connected)) {
      console.error(color(`MCP ${status.name}: unavailable · ${status.error}`, theme.yellow));
    }
    if (mcp.connectedCount) {
      const toolCount = mcp.statuses.reduce((sum, item) => sum + item.tools, 0);
      console.log(color(`MCP: ${mcp.connectedCount} server${mcp.connectedCount === 1 ? "" : "s"} connected · ${toolCount} tools`, theme.cyan));
    }
  }
  return mcp;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function assignments(values: string[], label: string): Record<string, string> {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`${label} must use KEY=VALUE.`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function protectMcpValues(serverName: string, kind: "ENV" | "HEADER", values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (/\$\{[A-Z_][A-Z0-9_]*\}/i.test(value)) return [key, value];
    const secretName = `RAYA_MCP_${serverName}_${kind}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    writeSecret(secretName, value);
    return [key, `\${${secretName}}`];
  }));
}

function commandOptions<T extends Record<string, unknown>>(value: unknown): T {
  if (value && typeof value === "object" && "opts" in value && typeof (value as { opts?: unknown }).opts === "function") {
    return (value as { opts: () => T }).opts();
  }
  return (value ?? {}) as T;
}

function lastAssistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant") as { content?: Array<{ type: string; text?: string }> } | undefined;
  return message?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") ?? "";
}

function renderRestoredSession(session: RayaSession): void {
  output.write("\x1b[2J\x1b[H");
  console.log(color(`RAYA — restored session: ${session.name}`, theme.cyan));
  console.log(color(`${session.config.provider}/${session.config.model} · ${session.config.mode}`, theme.gray));
  console.log();

  let rayaPrinted = false;
  for (const message of session.messages as unknown[]) {
    const item = message as { role?: string; content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }> };
    if (item.role === "user") {
      const text = item.content?.filter((content) => content.type === "text").map((content) => content.text ?? "").join("").trim();
      if (!text) continue;
      const mode = session.config.mode === "plan" ? "Plan" : "Build";
      console.log(`${color(`[${mode}] >`, theme.blue)} ${text}\n`);
      rayaPrinted = false;
      continue;
    }
    if (item.role !== "assistant") continue;
    if (!rayaPrinted) {
      console.log(`${color("Raya", theme.cyan)}\n`);
      rayaPrinted = true;
    }
    for (const content of item.content ?? []) {
      if (content.type === "text" && content.text?.trim()) console.log(`${renderMarkdown(content.text.trim())}\n`);
      if (content.type === "toolCall" && content.name) console.log(color(formatToolActivity(content.name, content.arguments), theme.gray));
    }
  }
}

async function configureTelegramOnFirstRun(config: RayaConfig, force = false): Promise<RayaConfig> {
  if (!force && readSecret("RAYA_TELEGRAM_BOT_TOKEN")) return config;
  const rl = readline.createInterface({ input, output });
  try {
    const token = (await rl.question("Telegram bot token (optional; press Enter to skip) > ")).trim();
    if (!token) return config;
    const allowedChatId = (await rl.question("Telegram chat ID to allow (required) > ")).trim();
    if (!/^-?\d+$/.test(allowedChatId)) throw new Error("Telegram chat ID is required and must be an integer.");
    writeSecret("RAYA_TELEGRAM_BOT_TOKEN", token);
    writeSecret("RAYA_TELEGRAM_ALLOWED_CHAT_ID", allowedChatId);
    return config;
  } finally {
    rl.close();
  }
}

async function runGateway(config: RayaConfig): Promise<void> {
  const token = readSecret("RAYA_TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("Telegram is not configured. Run: raya gateway --setup");
  const runtime = createProviderRuntime();
  const model = getConfiguredModel(runtime, config.provider, config.model);
  if (!(await isProviderConfigured(runtime, config.provider, model.id))) {
    throw new Error("The selected provider must be connected before starting the Telegram gateway.");
  }
  const mcp = await connectConfiguredMcp(config);
  let session = getOrCreateActiveSession(config);
  session.config = { ...session.config, mcpServers: config.mcpServers };
  try {
    const gateway = startTelegramService({
      token,
      allowedChatId: readSecret("RAYA_TELEGRAM_ALLOWED_CHAT_ID"),
      onStatus: (status) => console.log(color(
        status === "disconnected"
          ? "Telegram: connection lost · retrying automatically"
          : "Telegram: connection restored",
        status === "disconnected" ? theme.yellow : theme.green
      )),
      onPrompt: async (prompt, toolPolicy, signal) => {
        let response = "";
        const agent = createRayaAgent({
          config: session.config,
          model: getConfiguredModel(runtime, session.config.provider, session.config.model),
          models: runtime.models,
          toolPolicy,
          mcp,
          onEvent: (event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") response += event.assistantMessageEvent.delta;
          }
        });
        agent.state.messages = session.messages;
        await promptWithAbort(agent, prompt, signal);
        session.messages = agent.state.messages;
        saveSession(session);
        return response || lastAssistantText(agent);
      }
    });
    const chatId=readSecret("RAYA_TELEGRAM_ALLOWED_CHAT_ID");
    const stopScheduled=startScheduler(async (task)=>{
      if (!chatId) throw new Error("Scheduled delivery requires a Telegram chat ID. Run raya gateway --setup.");
      await gateway.sendMessage(chatId,`Reminder: ${task.message}`);
    }, (error) => console.error(color(`Scheduler: ${error.message}`, theme.red)));
    console.log(color("Telegram gateway running. Press Ctrl+C to stop.", theme.cyan));
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    stopScheduled();
    await gateway.stop();
  } finally {
    await mcp.close();
  }
}

program
  .name("raya")
  .description("Open-source AI coding agent harness for the terminal.")
  .version(VERSION)
  .addHelpText("after", `
Examples and direct commands:
  raya                         Start the terminal interface
  raya web (demo)              Open the full Raya Web app (demo)
  raya git                     Stage, commit, and push the current repository
  raya yt [text]               Open YouTube or search YouTube
  raya search <text>           Open a web search
  raya open <application>      Open a desktop application
  raya gateway --setup         Configure Telegram delivery
  raya gateway --start         Run the Telegram gateway
  raya update                  Checkpoint state, then install a pinned update
  raya backup                  Create a configured local or GitHub backup
  raya backup --list           List versions available for rollback
  raya backup --restore <ref>  Restore Raya and ~/.raya from a backup
  raya uninstall               Remove Raya, ~/.raya, and Raya backups
  raya mcp list                Show configured MCP servers
  raya skills list             Show available built-in and user skills
  raya profile coder          Switch the active profile
  raya profile create work --clone
                               Create a profile from the active identity
  raya commands add serve -- npm run dev
                               Create a direct command, then run raya serve
  raya local add <model>       Add an Ollama/local OpenAI-compatible model
  raya "explain this repo"     Run a one-shot prompt
`);

function printProfiles(activeProfile = loadConfig().activeProfile): void {
  console.log(`Active profile: ${activeProfile}`);
  for (const item of listProfiles()) {
    console.log(`${item.name === activeProfile ? "*" : " "} ${item.name}\t${item.path}`);
  }
}

function useProfile(name: string): string {
  ensureProfile(name);
  const normalized = name.trim().toLowerCase();
  updateConfig({ activeProfile: normalized });
  return normalized;
}

program
  .command("profile")
  .argument("[action]", "profile name, or list, use, create, show, rename, delete", "list")
  .argument("[name]", "profile name")
  .argument("[nextName]", "new name when renaming")
  .description("Manage isolated Raya identity, instructions, memory, and sessions.")
  .option("--list", "List profiles and mark the active profile.")
  .option("--clone", "Copy SOUL.md and AGENTS.md from the active or selected source profile.")
  .option("--clone-all", "Copy SOUL.md, AGENTS.md, and MEMORY.md from the source profile.")
  .option("--clone-from <profile>", "Clone from this profile instead of the active profile.")
  .option("-y, --yes", "Delete without typed confirmation.")
  .action(async (action: string, name: string | undefined, nextName: string | undefined, rawOptions: unknown) => {
    const options = commandOptions<{ list?: boolean; clone?: boolean; cloneAll?: boolean; cloneFrom?: string; yes?: boolean }>(rawOptions);
    const config = loadConfig();
    if (options.list || action === "list") {
      printProfiles(config.activeProfile);
      return;
    }
    if (action === "create") {
      if (!name) throw new Error("Usage: raya profile create <name> [--clone|--clone-all]");
      const paths = createProfile(name, {
        clone: options.clone,
        cloneAll: options.cloneAll,
        ...((options.clone || options.cloneAll) ? { cloneFrom: options.cloneFrom ?? config.activeProfile } : {})
      });
      console.log(color(`Created profile: ${name.toLowerCase()}`, theme.green));
      console.log(`Path: ${paths.directory}`);
      console.log(`Switch with: raya profile ${name.toLowerCase()}`);
      return;
    }
    if (action === "show") {
      const requested = name ?? config.activeProfile;
      const profile = listProfiles().find((item) => item.name === requested.toLowerCase());
      if (!profile) throw new Error(`Profile does not exist: ${requested}`);
      console.log(`Profile:  ${profile.name}${profile.name === config.activeProfile ? " (active)" : ""}`);
      console.log(`Path:     ${profile.path}`);
      console.log(`SOUL.md:  ${profile.soulBytes} bytes`);
      console.log(`AGENTS.md: ${profile.agentsBytes} bytes`);
      console.log(`MEMORY.md: ${profile.memoryBytes} bytes`);
      if (profile.createdAt) console.log(`Created:  ${profile.createdAt}`);
      if (profile.clonedFrom) console.log(`Source:   ${profile.clonedFrom}`);
      return;
    }
    if (action === "rename") {
      if (!name || !nextName) throw new Error("Usage: raya profile rename <current> <new>");
      renameProfile(name, nextName);
      renameSessionProfile(name.toLowerCase(), nextName.toLowerCase());
      if (config.activeProfile === name.toLowerCase()) updateConfig({ activeProfile: nextName.toLowerCase() });
      console.log(color(`Renamed profile ${name.toLowerCase()} to ${nextName.toLowerCase()}.`, theme.green));
      return;
    }
    if (action === "delete" || action === "remove") {
      if (!name) throw new Error("Usage: raya profile delete <name>");
      if (config.activeProfile === name.toLowerCase()) throw new Error("Switch to another profile before deleting the active profile.");
      if (!options.yes) {
        const paths = profilePaths(name);
        const rl = readline.createInterface({ input, output });
        try {
          console.log(`This will permanently remove ${paths.directory}, including its SOUL.md, AGENTS.md, MEMORY.md, and all profile-bound session records and transcripts.`);
          const answer = await rl.question(`Type DELETE ${name.toLowerCase()} to continue: `);
          if (answer.trim() !== `DELETE ${name.toLowerCase()}`) {
            console.log("Profile deletion cancelled.");
            return;
          }
        } finally {
          rl.close();
        }
      }
      deleteProfile(name);
      deleteSessionsForProfile(name.toLowerCase());
      console.log(color(`Deleted profile: ${name.toLowerCase()}`, theme.green));
      return;
    }
    const requested = action === "use" ? name : action;
    if (!requested) throw new Error("Usage: raya profile <name>");
    const selected = useProfile(requested);
    console.log(color(`Active profile: ${selected}`, theme.green));
    console.log(`Profile files: ${profilePaths(selected).directory}`);
  });

function backupTargetLabel(backup: NonNullable<RayaConfig["backup"]>): string {
  return backup.repository ?? backup.directory ?? RAYA_BACKUP_ROOT;
}

function persistBackupTarget(backup: NonNullable<RayaConfig["backup"]>, target: string): NonNullable<RayaConfig["backup"]> {
  updateConfig({ backup });
  writeSecret(RAYA_BACKUP_TARGET_ENV, target);
  console.log(`${backup.mode === "github" ? "GitHub" : "Local"} backup configured in ${target}.`);
  return backup;
}

async function configureBackup(options: { github?: string; local?: string } = {}): Promise<NonNullable<RayaConfig["backup"]>> {
  if (options.github && options.local) throw new Error("Use only one backup target: --github <url> or --local <name>.");
  if (options.github) {
    console.log("GitHub backups include Raya code and state, but exclude ~/.raya/.env and auth.json so credentials are never committed.");
    console.log("Use a private repository because sessions, memory, and personal configuration may still be sensitive.");
    return persistBackupTarget(await setupGithubBackup(options.github), options.github);
  }
  if (options.local) {
    const backup = await setupLocalBackup();
    return persistBackupTarget(backup, RAYA_BACKUP_ROOT);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const github = (await rl.question("Save Raya backups to GitHub? [y/N] ")).trim().toLowerCase();
    if (github === "y" || github === "yes") {
      console.log("GitHub backups include Raya code and state, but exclude ~/.raya/.env and auth.json so credentials are never committed.");
      console.log("Use a private repository because sessions, memory, and personal configuration may still be sensitive.");
      const repositoryUrl = (await rl.question("GitHub repository URL > ")).trim();
      const backup = await setupGithubBackup(repositoryUrl);
      return persistBackupTarget(backup, repositoryUrl);
    }

    const backup = await setupLocalBackup();
    return persistBackupTarget(backup, RAYA_BACKUP_ROOT);
  } finally {
    rl.close();
  }
}

async function askBackupName(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question("Backup name / version > ")).trim();
  } finally {
    rl.close();
  }
}

function backupDate(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function printBackupGroup(title: string, backups: BackupListItem[]): void {
  console.log(title);
  if (!backups.length) {
    console.log("(none)\n");
    return;
  }
  const rows = backups.map((item) => [item.name, `v${item.rayaVersion}`, backupDate(item.createdAt)]);
  const headers = ["Backup name", "Raya version", "Created"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  console.log(headers.map((header, index) => header.padEnd(widths[index]!)).join("  "));
  for (let index = 0; index < backups.length; index += 1) {
    const item = backups[index]!;
    console.log(rows[index]!.map((value, column) => value.padEnd(widths[column]!)).join("  "));
    console.log(`  Restore: raya backup --restore ${shellArgument(item.name)}`);
  }
  console.log();
}

async function chooseBackupToRestore(reference: string | undefined): Promise<BackupListItem | undefined> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Restore from:");
    console.log("1. GitHub");
    console.log("2. Local");
    let source = (await rl.question("Source [1/2] > ")).trim().toLowerCase();
    if (source === "1" || source === "g" || source === "github") source = "github";
    else if (source === "2" || source === "l" || source === "local") source = "local";
    else throw new Error("Restore source must be GitHub or Local.");

    const configured = loadConfig().backup;
    if (source === "github" && configured?.mode !== "github") {
      throw new Error("GitHub backups are not configured. Run: raya backup --setup");
    }
    const discovered = await discoverBackups(source === "github" ? configured : undefined);
    const available = source === "github" ? discovered.github : discovered.local;
    if (!available.length) throw new Error(`No ${source === "github" ? "GitHub" : "local"} backups were found.`);
    let matches = reference
      ? available.filter((item) => item.reference === reference || item.name === reference)
      : available;
    if (!matches.length) throw new Error(`Backup not found: ${reference}. Run raya backup --list.`);

    let selected: BackupListItem;
    if (matches.length === 1) {
      selected = matches[0]!;
    } else {
      console.log(`Available ${source === "github" ? "GitHub" : "local"} backups:`);
      matches.forEach((item, index) => console.log(`${index + 1}. ${item.name} · v${item.rayaVersion} · ${backupDate(item.createdAt)} · ${item.target}`));
      const choice = Number((await rl.question("Backup number > ")).trim());
      if (!Number.isInteger(choice) || choice < 1 || choice > matches.length) throw new Error("Choose a valid backup number.");
      selected = matches[choice - 1]!;
    }

    console.log(`This will reinstall Raya v${selected.rayaVersion} and restore: ${selected.name}`);
    const answer = await rl.question("Type RESTORE to continue: ");
    if (answer.trim() !== "RESTORE") {
      console.log("Restore cancelled.");
      return undefined;
    }
    return selected;
  } finally {
    rl.close();
  }
}

program
  .command("backup")
  .alias("bakcup")
  .description("Configure, create, list, or restore complete Raya backups.")
  .option("--setup", "Configure a GitHub or local backup target.")
  .option("--github <repository>", "Configure this GitHub repository without prompting.")
  .option("--local <name>", "Use local backups and create this backup name without prompting.")
  .option("--list", "List saved versions and rollback references.")
  .option("--restore [reference]", "Restore a backup, optionally by name or Git commit.")
  .option("--name <name>", "Use this backup name without prompting.")
  .action(async (rawOptions: unknown) => {
    const options = commandOptions<{ setup?: boolean; github?: string; local?: string; list?: boolean; restore?: string | boolean; name?: string }>(rawOptions);

    if (options.list) {
      const backups = await discoverBackups(loadConfig().backup);
      printBackupGroup("GitHub backups", backups.github);
      printBackupGroup("Local backups", backups.local);
      return;
    }

    if (options.restore !== undefined) {
      const selected = await chooseBackupToRestore(typeof options.restore === "string" ? options.restore : undefined);
      if (!selected) return;
      const restored = await restoreDiscoveredBackup(selected);
      console.log(`Restored Raya backup: ${restored.name} (v${restored.rayaVersion}).`);
      if (!restored.secretsIncluded) console.log("GitHub backups do not contain credentials. Existing local .env/auth.json values were preserved where present.");
      console.log("Open a new terminal before starting Raya again.");
      return;
    }

    let config = loadConfig();
    if (options.setup || options.github || options.local || !config.backup) {
      const backup = await configureBackup({ github: options.github, local: options.local });
      config = { ...config, backup };
      if (options.setup) return;
    }
    if (!config.backup) throw new Error("Backups are not configured. Run: raya backup --setup");
    const name = options.name?.trim() || options.local?.trim() || await askBackupName();
    if (!name) throw new Error("Backup name cannot be empty.");
    console.log(`Creating ${config.backup.mode === "github" ? "GitHub" : "local"} Raya backup...`);
    const saved = await createBackup(config.backup, name, VERSION);
    console.log(`Saved Raya backup: ${saved.name}`);
    console.log(`Reference: ${saved.reference}`);
    console.log(`Location: ${saved.directory}`);
  });

program
  .command("uninstall")
  .description("Remove the installed Raya package, local state, launchers, and backups.")
  .option("--yes", "Skip the typed confirmation.")
  .option("--keep-backups", "Preserve ~/raya-backups while removing Raya.")
  .action(async (rawOptions: unknown) => {
    const options = commandOptions<{ yes?: boolean; keepBackups?: boolean }>(rawOptions);
    if (!options.yes) {
      const rl = readline.createInterface({ input, output });
      try {
        console.log("Raya uninstall will remove:");
        console.log("- global npm package @sdh4114/raya and installer-created Raya launchers");
        console.log(`- all Raya state in ${RAYA_HOME}`);
        if (!options.keepBackups) console.log(`- all Raya backups in ${RAYA_BACKUP_ROOT}`);
        console.log("Developer source repositories, Node.js, and remote GitHub repositories will not be removed.");
        const answer = await rl.question("Type UNINSTALL to continue: ");
        if (!isUninstallApproved(answer)) {
          console.log("Uninstall cancelled.");
          return;
        }
      } finally {
        rl.close();
      }
    }
    const result = await uninstallRaya({ keepBackups: options.keepBackups });
    console.log("Raya was uninstalled.");
    for (const path of result.removed) console.log(`Removed: ${path}`);
    for (const path of result.preserved) console.log(`Preserved: ${path}`);
  });

program
  .command("update")
  .description("Checkpoint Raya, preserve RAYA_HOME, and install a pinned GitHub update.")
  .action(async () => {
    console.log("Checking the latest Raya version on GitHub...");
    const githubRelease = await readGithubRelease();
    const githubVersion = githubRelease.version;
    console.log(`GitHub version: v${githubVersion}`);
    console.log(`Local version:  v${VERSION}`);
    if (compareVersions(githubVersion, VERSION) <= 0) {
      console.log(githubVersion === VERSION ? "Raya is already up to date." : "Your local Raya version is newer than the GitHub version.");
      return;
    }

    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question(`Update Raya from v${VERSION} to v${githubVersion}? [y/N] `)).trim().toLowerCase();
      if (!isUpdateApproved(answer)) {
        console.log("Update cancelled.");
        return;
      }
    } finally {
      rl.close();
    }

    console.log("Creating a required local checkpoint before the update...");
    await installGithubReleaseWithCheckpoint(VERSION, githubRelease, {
      onCheckpoint: (checkpoint) => {
        console.log(`Checkpoint: ${checkpoint.directory}`);
        console.log(`Restore with: raya backup --restore '${checkpoint.reference}'`);
        console.log(`Preserving ${RAYA_HOME} unchanged...`);
        console.log("Updating Raya from GitHub...");
      }
    });
    console.log(`Raya updated to v${githubVersion}. Open a new terminal if your shell needs to refresh its PATH.`);
  });

program
  .command("commands")
  .alias("command")
  .argument("[action]", "list, add, show, or remove", "list")
  .argument("[name]", "Custom command name")
  .argument("[command...]", "Executable and fixed arguments after --")
  .description("Create and manage personal direct Raya commands.")
  .option("-d, --description <text>", "Short description shown in raya --help.")
  .option("--cwd <path>", "Always run the command from this directory.")
  .option("--force", "Replace an existing custom command with the same name.")
  .action((action: string, name: string | undefined, command: string[], rawOptions: unknown) => {
    const options = commandOptions<{ description?: string; cwd?: string; force?: boolean }>(rawOptions);
    if (action === "list") {
      const commands = listCustomCommands();
      if (!commands.length) {
        console.log("No custom commands. Create one with: raya commands add <name> -- <executable> [args...]");
        return;
      }
      for (const item of commands) {
        console.log(`${item.name}\t${item.description ?? formatCustomCommand(item)}`);
      }
      return;
    }
    if (!name) throw new Error(`Usage: raya commands ${action} <name>`);
    if (action === "show") {
      const item = listCustomCommands().find((entry) => entry.name === name);
      if (!item) throw new Error(`Unknown custom command: ${name}`);
      console.log(`${item.name}: ${formatCustomCommand(item)}`);
      if (item.description) console.log(`description: ${item.description}`);
      if (item.cwd) console.log(`cwd: ${item.cwd}`);
      return;
    }
    if (action === "remove") {
      const removed = removeCustomCommand(name);
      console.log(color(`Removed custom command: ${removed.name}`, theme.green));
      return;
    }
    if (action !== "add") throw new Error("Commands action must be list, add, show, or remove.");
    if (!command.length) throw new Error("Provide an executable after --, for example: raya commands add serve -- npm run dev");
    const saved = addCustomCommand({
      name,
      executable: command[0]!,
      args: command.slice(1),
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
      ...(options.cwd?.trim() ? { cwd: resolve(options.cwd.trim()) } : {})
    }, { overwrite: options.force, reservedNames: builtinCommandNames });
    console.log(color(`Created raya ${saved.name}`, theme.green));
    console.log(`Runs: ${formatCustomCommand(saved)}`);
  });

program
  .command("local")
  .argument("<action>", "add, remove, or list")
  .argument("[model]", "Local model id")
  .description("Manage Ollama, LM Studio, vLLM, or other local OpenAI-compatible models.")
  .option("--provider <provider>", "Local provider id.", "ollama")
  .option("--base-url <url>", "OpenAI-compatible /v1 endpoint.")
  .option("--name <name>", "Display name.")
  .option("--context-window <tokens>", "Context window.", "32768")
  .option("--max-tokens <tokens>", "Maximum output tokens.", "8192")
  .action((action: string, modelId: string | undefined, rawOptions: unknown) => {
    const options = commandOptions<{ provider?: string; baseUrl?: string; name?: string; contextWindow?: string; maxTokens?: string }>(rawOptions);
    const config = loadConfig();
    setActiveTheme(config.theme);
    if (action === "list") {
      if (!config.localModels.length) {
        console.log("No local models configured. Add one with: raya local add <model>");
        return;
      }
      for (const item of config.localModels) {
        console.log(`${item.provider}\t${item.id}\t${item.baseUrl}\t${item.contextWindow} context`);
      }
      return;
    }
    if (!modelId?.trim()) throw new Error(`Usage: raya local ${action} <model> [--provider ollama]`);
    const provider = options.provider?.trim().toLowerCase() || "ollama";
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new Error("--provider must contain lowercase letters, numbers, dots, underscores, or hyphens.");
    if (action === "remove") {
      const localModels = config.localModels.filter((item) => !(item.provider === provider && item.id === modelId));
      if (localModels.length === config.localModels.length) throw new Error(`Local model not found: ${provider}/${modelId}`);
      updateConfig({ localModels });
      console.log(color(`Removed local model ${provider}/${modelId}.`, theme.green));
      return;
    }
    if (action !== "add") throw new Error("Local action must be add, remove, or list.");
    const defaultUrl = provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434/v1";
    const baseUrl = (options.baseUrl ?? defaultUrl).replace(/\/$/, "");
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("--base-url must use http or https.");
    const contextWindow = Number(options.contextWindow);
    const maxTokens = Number(options.maxTokens);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new Error("--context-window must be a positive integer.");
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("--max-tokens must be a positive integer.");
    const nextModel: RayaConfig["localModels"][number] = {
      provider,
      id: modelId,
      name: options.name?.trim() || `${modelId} (${provider})`,
      baseUrl,
      contextWindow,
      maxTokens
    };
    const localModels = config.localModels.filter((item) => !(item.provider === provider && item.id === modelId));
    updateConfig({ localModels: [...localModels, nextModel] });
    console.log(color(`Added ${provider}/${modelId} at ${baseUrl}. Select it with /models or raya config --provider ${provider} --model ${modelId}.`, theme.green));
  });

program
  .command("web")
  .description("Open the full local Raya Web app.")
  .option("-p, --port <port>", "Local port. Defaults to 4177.", "4177")
  .option("--no-open", "Start without opening the browser.")
  .action(async (rawOptions: unknown) => {
    const options = commandOptions<{ port?: string; open?: boolean }>(rawOptions);
    const port = Number(options.port ?? "4177");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535.");
    await runWebServer({ port, open: options.open, version: VERSION });
  });

program
  .command("login")
  .argument("[provider]", "Provider id to login. Defaults to configured provider.")
  .description("Choose and connect an optional AI provider.")
  .action(async (providerArg?: string) => {
    const config = loadConfig();
    const runtime = createProviderRuntime();
    const provider = providerArg ?? (await chooseProvider(runtime, config.provider));
    await loginProvider(runtime, provider);
    console.log(color("Saved provider credential securely.", theme.green));
  });

program
  .command("logout")
  .argument("[provider]", "Provider id to logout. Defaults to configured provider.")
  .description("Delete the local provider credential.")
  .action(async (providerArg?: string) => {
    const config = loadConfig();
    const runtime = createProviderRuntime();
    await logoutProvider(runtime, providerArg ?? config.provider);
    console.log(color("Logged out.", theme.green));
  });

program
  .command("gateway")
  .description("Configure, start, or restart the local Telegram gateway.")
  .option("--setup", "Ask for Telegram bot token and allowed chat ID.")
  .option("--start", "Start the Telegram gateway in this terminal.")
  .option("--restart", "Restart the Telegram gateway with a fresh connection in this terminal.")
  .action(async (rawOptions: unknown) => {
    const options = commandOptions<{ setup?: boolean; start?: boolean; restart?: boolean }>(rawOptions);
    let config = loadConfig();
    if (options.setup) config = await configureTelegramOnFirstRun(config, true);
    if (options.start || options.restart) {
      if (options.restart) console.log("Restarting Telegram gateway...");
      await runGateway(config);
    } else if (!options.setup) {
      console.log("Use raya gateway --setup, raya gateway --start, or raya gateway --restart.");
    }
  });

program
  .command("plugin")
  .argument("<action>", "install or list")
  .argument("[package]", "pi package, for example npm:pi-subagents")
  .description("Install or list configured pi packages.")
  .action(async (action:string, packageArg?:string) => {
    const config=loadConfig();
    if(action==="list"){
      if(!config.piPackages.length){console.log("(none)");return;}
      for(const name of config.piPackages){
        let packageName: string;
        try { packageName = normalizePiPackageName(name); }
        catch { console.log(`${name}\tinvalid package name`); continue; }
        const manifestPath=join(RAYA_PLUGINS_DIR,"node_modules",packageName,"package.json");
        if(!existsSync(manifestPath)){console.log(`${name}\tmissing`);continue;}
        const manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as {pi?:{skills?:string[];extensions?:string[]}};
        const skills=manifest.pi?.skills?.length?`skills:${manifest.pi.skills.length}`:"skills:0";
        const extensions=manifest.pi?.extensions?.length?`native-extensions:${manifest.pi.extensions.length} (adapter required)`:"native-extensions:0";
        console.log(`${name}\t${skills}\t${extensions}`);
      }
      return;
    }
    if(action!=="install"||!packageArg)throw new Error("Usage: raya plugin install npm:<package>");
    const packageName=normalizePiPackageName(packageArg);mkdirSync(RAYA_PLUGINS_DIR,{recursive:true,mode:0o700});
    await new Promise<void>((resolve,reject)=>{const invocation=commandInvocation("npm",["install","--prefix",RAYA_PLUGINS_DIR,"--ignore-scripts","--no-audit","--no-fund","--",packageName]);const child=spawn(invocation.command,invocation.args,{stdio:"inherit"});child.on("close",code=>code===0?resolve():reject(new Error(`npm exited ${code}`)));child.on("error",reject);});
    updateConfig({ piPackages: [...new Set([...config.piPackages, packageName])] });
    console.log(`Installed ${packageName}. Skills are loaded on the next session. Native Pi extensions require a Raya adapter.`);
  });

program
  .command("mcp")
  .argument("[action]", "list, add, enable, disable, remove, or test", "list")
  .argument("[name]", "MCP server name")
  .description("Configure and diagnose MCP servers.")
  .option("--command <command>", "Executable for a local stdio MCP server.")
  .option("--arg <value>", "Repeatable stdio argument. Use --arg=-y for values beginning with -.", collectOption, [])
  .option("--cwd <path>", "Working directory for a stdio server.")
  .option("--env <KEY=VALUE>", "Repeatable environment value. Supports ${ENV_VAR} placeholders.", collectOption, [])
  .option("--url <url>", "Streamable HTTP MCP endpoint.")
  .option("--transport <transport>", "Remote transport: http or sse.", "http")
  .option("--header <KEY=VALUE>", "Repeatable HTTP header. Supports ${ENV_VAR} placeholders.", collectOption, [])
  .option("--approval <mode>", "always, writes, or never", "writes")
  .option("--trust-read-only", "Trust this server's readOnlyHint annotations in Plan mode.")
  .option("--timeout <ms>", "Connection timeout in milliseconds.", "30000")
  .option("--tool-timeout <ms>", "Tool call timeout in milliseconds.", "120000")
  .option("--disabled", "Add the server in a disabled state.")
  .action(async (action: string, name: string | undefined, rawOptions: unknown) => {
    const config = loadConfig();
    const options = commandOptions<{
      command?: string; arg: string[]; cwd?: string; env: string[]; url?: string; header: string[];
      approval: "always" | "writes" | "never"; timeout: string; toolTimeout: string; transport: "http" | "sse"; disabled?: boolean; trustReadOnly?: boolean;
    }>(rawOptions);
    if (action === "list") {
      const entries = Object.entries(config.mcpServers);
      if (!entries.length) {
        console.log(`No MCP servers configured. Add one with: raya mcp add <name> --command <executable>`);
        return;
      }
      for (const [serverName, server] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const target = server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url;
        console.log(`${serverName}\t${server.enabled ? "enabled" : "disabled"}\t${server.transport}\t${server.approval}\t${target}`);
      }
      return;
    }
    if (!name) throw new Error(`Usage: raya mcp ${action} <name>`);
    if (action === "enable" || action === "disable") {
      const current = config.mcpServers[name];
      if (!current) throw new Error(`Unknown MCP server: ${name}`);
      updateConfig({ mcpServers: { ...config.mcpServers, [name]: { ...current, enabled: action === "enable" } } });
      console.log(`MCP ${name}: ${action === "enable" ? "enabled" : "disabled"}.`);
      return;
    }
    if (action === "remove") {
      if (!config.mcpServers[name]) throw new Error(`Unknown MCP server: ${name}`);
      const next = { ...config.mcpServers };
      delete next[name];
      updateConfig({ mcpServers: next });
      console.log(`Removed MCP server ${name}.`);
      return;
    }
    if (action === "test") {
      const mcp = await connectConfiguredMcp(config, { only: name, strict: true, quiet: true });
      try {
        const status = mcp.statuses.find((item) => item.name === name);
        console.log(color(`MCP ${name}: connected · ${status?.tools ?? 0} tools`, theme.green));
      } finally {
        await mcp.close();
      }
      return;
    }
    if (action !== "add") throw new Error("MCP action must be list, add, enable, disable, remove, or test.");
    if (Boolean(options.command) === Boolean(options.url)) throw new Error("Use exactly one of --command (stdio) or --url (Streamable HTTP).");
    if (options.transport !== "http" && options.transport !== "sse") throw new Error("--transport must be http or sse.");
    if (options.command && options.transport !== "http") throw new Error("--transport only applies together with --url.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error("MCP name may contain letters, numbers, dots, underscores, and hyphens.");
    const timeoutMs = Number(options.timeout);
    const toolTimeoutMs = Number(options.toolTimeout);
    if (!Number.isInteger(timeoutMs) || !Number.isInteger(toolTimeoutMs)) throw new Error("MCP timeouts must be integer milliseconds.");
    const common = { enabled: !options.disabled, approval: options.approval, trustReadOnlyAnnotations: Boolean(options.trustReadOnly), timeoutMs, toolTimeoutMs };
    const server = options.command
      ? { ...common, transport: "stdio" as const, command: options.command, args: options.arg, ...(options.cwd ? { cwd: options.cwd } : {}), env: protectMcpValues(name, "ENV", assignments(options.env, "--env")) }
      : { ...common, transport: options.transport, url: options.url!, headers: protectMcpValues(name, "HEADER", assignments(options.header, "--header")) };
    const normalized = normalizeConfig({ ...config, mcpServers: { ...config.mcpServers, [name]: server } });
    updateConfig({ mcpServers: normalized.mcpServers });
    console.log(color(`Saved MCP server ${name} (${server.transport}, ${server.enabled ? "enabled" : "disabled"}).`, theme.green));
    console.log(`Test it with: raya mcp test ${name}`);
  });

program
  .command("skills")
  .argument("[action]", "list or sync", "list")
  .description("List skills or install missing built-in Raya skills.")
  .option("--force", "Replace installed built-in skill folders with the packaged versions.")
  .action((action: string, rawOptions: unknown) => {
    const options = commandOptions<{ force?: boolean }>(rawOptions);
    if (action === "sync") {
      const installed = ensureBuiltinSkills({ overwrite: options.force });
      console.log(installed.length ? `${options.force ? "Replaced" : "Installed"} built-in skills: ${installed.join(", ")}` : "Built-in skills are already installed.");
      console.log(`Skills directory: ${RAYA_SKILLS_DIR}`);
      return;
    }
    if (action !== "list") throw new Error("Skills action must be list or sync.");
    const skills = listAvailableSkills();
    if (!skills.length) { console.log("(none)"); return; }
    for (const skill of skills) console.log(`${skill.name}\t${skill.path}`);
  });

program
  .command("status")
  .description("Show local Raya configuration and auth status.")
  .action(async () => {
    const config = loadConfig();
    const runtime = createProviderRuntime();
    const loggedIn = await isProviderConfigured(runtime, config.provider, config.model);

    console.log(`config: ${RAYA_CONFIG_PATH}`);
    console.log(`profile: ${config.activeProfile}`);
    console.log(`profile_path: ${profilePaths(config.activeProfile).directory}`);
    console.log("credentials: stored securely");
    console.log(`provider: ${config.provider}`);
    console.log(`model: ${config.model}`);
    console.log(`mode: ${config.mode}`);
    console.log(`security: ${config.securityMode}`);
    console.log(`design: ${config.headerStyle}`);
    console.log(`theme: ${config.theme}`);
    for (const [action, binding] of Object.entries(config.hotkeys)) console.log(`hotkey.${action}: ${binding}`);
    const enabledMcp = Object.entries(config.mcpServers).filter(([, server]) => server.enabled).map(([name]) => name);
    console.log(`mcp_enabled: ${enabledMcp.length ? enabledMcp.join(", ") : "(none)"}`);
    console.log(`skills: ${listAvailableSkills().length} loaded from ${RAYA_SKILLS_DIR}`);
    console.log(`commands: ${listCustomCommands().length} loaded from ${RAYA_COMMANDS_PATH}`);
    console.log(`backup: ${config.backup ? `${config.backup.mode} (${backupTargetLabel(config.backup)})` : "not configured"}`);
    console.log(`logged_in: ${loggedIn}`);
  });

program
  .command("providers")
  .description("List built-in providers exposed by pi-ai.")
  .action(() => {
    const runtime = createProviderRuntime();
    for (const provider of [...runtime.models.getProviders()].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`${provider.id}\t${provider.name}\t${authLabel(provider)}`);
    }
  });

program
  .command("models")
  .description("List models for a provider.")
  .option("-p, --provider <provider>", "Provider id. Defaults to configured provider.")
  .action((rawOptions: unknown) => {
    const options = commandOptions<{ provider?: string }>(rawOptions);
    const config = loadConfig();
    const runtime = createProviderRuntime();
    const provider = options.provider ?? config.provider;
    for (const model of runtime.models.getModels(provider)) {
      console.log(`${model.id}\t${model.name}`);
    }
  });

program
  .command("yt")
  .argument("[query...]", "Optional text to search for on YouTube.")
  .description("Open YouTube, or search YouTube when text is supplied.")
  .action(async (query: string[] = []) => {
    const text = query.join(" ").trim();
    await openUrl(text ? youtubeSearchUrl(text) : YOUTUBE_HOME_URL);
    console.log(text ? `YouTube search opened: ${text}` : "YouTube opened.");
  });

program
  .command("search")
  .alias("serach")
  .argument("<query...>", "Text to search for in the browser.")
  .description("Open a web search in the browser.")
  .action(async (query: string[]) => {
    const text = query.join(" ").trim();
    await openUrl(webSearchUrl(text));
    console.log(`Web search opened: ${text}`);
  });

program
  .command("git")
  .description("Stage all changes, create a commit, and push it.")
  .action(runGitShortcut);

program
  .command("open")
  .argument("<application...>", "Application name to open.")
  .description("Open an application.")
  .action(async (application: string[]) => {
    const name = application.join(" ").trim();
    await openApplication(name);
    console.log(`Opened application: ${name}`);
  });

program
  .command("config")
  .description("Update simple Raya settings.")
  .option("--provider <provider>", "Set provider id.")
  .option("--model <model>", "Set model id.")
  .option("--mode <mode>", "Set default mode: plan or build.")
  .option("--thinking <level>", "Set thinking level: off, minimal, low, medium, high, xhigh, max.")
  .option("--security <mode>", "Set security mode: standard or full.")
  .option("--design <style>", "Set startup design: small or large.")
  .option("--theme <theme>", "Set global theme: ocean or sunset.")
  .option("--hotkey <action=key>", "Set a TUI hotkey. Repeat for toggleMode, cancel, exit, or clearScreen.", collectOption, [])
  .option("--reset-hotkeys", "Restore all default TUI hotkeys.")
  .action((rawOptions: unknown) => {
    const options = commandOptions<{ provider?: string; model?: string; mode?: string; thinking?: string; security?: string; design?: string; theme?: string; hotkey: string[]; resetHotkeys?: boolean }>(rawOptions);
    const config = loadConfig();
    if (options.mode !== undefined && options.mode !== "plan" && options.mode !== "build") throw new Error("--mode must be plan or build.");
    if (options.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)) throw new Error("--thinking must be off, minimal, low, medium, high, xhigh, or max.");
    if (options.security !== undefined && options.security !== "standard" && options.security !== "full") throw new Error("--security must be standard or full.");
    if (options.design !== undefined && options.design !== "small" && options.design !== "large") throw new Error("--design must be small or large.");
    if (options.theme !== undefined && !THEME_IDS.includes(options.theme as ThemeId)) throw new Error("--theme must be ocean or sunset.");
    let provider = config.provider;
    let modelId = config.model;
    let selectedModel: Model<any> | undefined;
    if (options.provider !== undefined || options.model !== undefined || options.thinking !== undefined) {
      const runtime = createProviderRuntime();
      provider = options.provider ?? config.provider;
      getProvider(runtime, provider);
      const fallbackModel = provider === config.provider ? config.model : runtime.models.getModels(provider)[0]?.id;
      modelId = options.model ?? fallbackModel ?? "";
      if (!modelId) throw new Error(`Provider has no known models: ${provider}`);
      selectedModel = getConfiguredModel(runtime, provider, modelId);
      if (options.thinking !== undefined && !getModelThinkingLevels(selectedModel).includes(options.thinking as RayaConfig["thinkingLevel"])) {
        throw new Error(`${selectedModel.name} supports these thinking levels: ${getModelThinkingLevels(selectedModel).join(", ")}.`);
      }
    }
    const patch: Partial<RayaConfig> = {};
    if (options.provider !== undefined || options.model !== undefined) {
      patch.provider = provider;
      patch.model = modelId;
      if (options.thinking === undefined && selectedModel) {
        patch.thinkingLevel = clampModelThinkingLevel(selectedModel, config.thinkingLevel);
      }
    }
    if (options.mode !== undefined) patch.mode = options.mode as RayaConfig["mode"];
    if (options.thinking !== undefined) patch.thinkingLevel = options.thinking as RayaConfig["thinkingLevel"];
    if (options.security !== undefined) patch.securityMode = options.security as RayaConfig["securityMode"];
    if (options.design !== undefined) patch.headerStyle = options.design as RayaConfig["headerStyle"];
    if (options.theme !== undefined) patch.theme = options.theme as ThemeId;
    if (options.resetHotkeys) patch.hotkeys = { ...DEFAULT_HOTKEYS };
    if (options.hotkey.length) {
      const requested = assignments(options.hotkey, "--hotkey");
      const allowed = new Set(Object.keys(DEFAULT_HOTKEYS));
      const unknown = Object.keys(requested).find((action) => !allowed.has(action));
      if (unknown) throw new Error(`Unknown hotkey action: ${unknown}. Use toggleMode, cancel, exit, or clearScreen.`);
      patch.hotkeys = { ...(patch.hotkeys ?? config.hotkeys), ...requested };
    }
    const next = updateConfig(patch);
    setActiveTheme(next.theme);
    const session = getOrCreateActiveSession(next);
    session.config = normalizeConfig({ ...session.config, ...patch, theme: next.theme });
    saveSession(session);
    console.log(color(`Saved ${RAYA_CONFIG_PATH}`, theme.green));
  });

program
  .argument("[prompt...]", "Optional one-shot prompt. Without a prompt, Raya starts interactive TUI.")
  .option("--run-model <model>", "Override model for this one-shot or interactive run.")
  .action(async (promptParts: string[], rawOptions: unknown) => {
    const options = commandOptions<{ runModel?: string }>(rawOptions);
    const prompt = promptParts.join(" ").trim();
    let config = loadConfig();
    setActiveTheme(config.theme);
    const runtime = createProviderRuntime();
    const connectedProviders = new Set<string>();
    await Promise.all(runtime.models.getProviders().map(async (provider) => {
      if (await isProviderConfigured(runtime, provider.id)) connectedProviders.add(provider.id);
    }));
    if (options.runModel) config = { ...config, model: options.runModel };
    let modelId = options.runModel ?? config.model;

    if (!(await isProviderConfigured(runtime, config.provider, modelId))) {
      if (prompt) {
        throw new Error(`Provider "${config.provider}" is not connected. Run raya login, or configure another/local provider first.`);
      }

      console.log(color("No provider is connected. Provider setup is optional; OpenAI Codex is not required.", theme.yellow));
      const provider = await chooseOptionalProvider(runtime);
      if (!provider) {
        console.log("Provider setup skipped. Later, run raya login or raya local add <model>.");
        return;
      }

      getProvider(runtime, provider);
      modelId = provider === config.provider && runtime.models.getModel(provider, modelId)
        ? modelId
        : runtime.models.getModels(provider)[0]?.id ?? "";
      if (!modelId) throw new Error(`Provider has no known models: ${provider}`);
      if (!(await isProviderConfigured(runtime, provider, modelId))) {
        await loginProvider(runtime, provider);
      }
      connectedProviders.add(provider);
      config = { ...config, provider, model: modelId };
      updateConfig({ provider, model: modelId });
      console.log(color(`${provider} connected.\n`, theme.green));
    }

    let model = getConfiguredModel(runtime, config.provider, modelId);
    const startupThinkingLevel = clampModelThinkingLevel(model, config.thinkingLevel);
    if (startupThinkingLevel !== config.thinkingLevel) {
      config = { ...config, thinkingLevel: startupThinkingLevel };
      updateConfig({ thinkingLevel: startupThinkingLevel });
    }

    let session = createSession(config);

    if (!prompt) {
      config = await configureTelegramOnFirstRun(config);
      session.config = config;
      saveSession(session);
    }

    const mcp = await connectConfiguredMcp(config);

    const agent = createRayaAgent({
      config,
      model,
      models: runtime.models,
      onEvent: renderAgentEvent,
      toolPolicy: buildToolPolicy(config),
      mcp
    });
    agent.state.messages = session.messages;
    const sessionLock = new AsyncLock();

    const rebuildAgent = (nextSession = session): Agent => {
      const globalConfig = loadConfig();
      nextSession.config = { ...nextSession.config, theme: globalConfig.theme, hotkeys: globalConfig.hotkeys, mcpServers: globalConfig.mcpServers };
      setActiveTheme(globalConfig.theme);
      const nextModel = getConfiguredModel(runtime, nextSession.config.provider, nextSession.config.model);
      const nextThinkingLevel = clampModelThinkingLevel(nextModel, nextSession.config.thinkingLevel);
      nextSession.config = { ...nextSession.config, thinkingLevel: nextThinkingLevel };
      const nextAgent = createRayaAgent({
        config: nextSession.config,
        model: nextModel,
        models: runtime.models,
        onEvent: renderAgentEvent,
        toolPolicy: buildToolPolicy(nextSession.config),
        mcp
      });
      nextAgent.state.messages = nextSession.messages;
      model = nextModel;
      config = nextSession.config;
      session = nextSession;
      return nextAgent;
    };

    const persist = (activeAgent: Agent): void => {
      session.messages = activeAgent.state.messages;
      session.config = config;
      saveSession(session);
    };

    const printHelp = (): void => {
      console.log(RAYA_SLASH_COMMANDS.map(([command, description]) => `${command.padEnd(30)} ${description}`).join("\n"));
    };

    const handleCommand = async (activeAgent: Agent, command: string): Promise<Agent | void> => {
      const [rawName, ...args] = command.slice(1).split(/\s+/).filter(Boolean);
      const name = rawName?.toLowerCase();

      if (!name || name === "help") {
        printHelp();
        return;
      }

      if (name === "about") {
        console.log(renderMarkdown(rayaAboutMarkdown()));
        return;
      }

      if (name === "providers") {
        const action = args[0];
        const provider = args[1];
        if (!action || action === "manage" || !provider) {
          console.log("Use /providers and choose a provider, then Connect / update key or Use provider.");
          return;
        }
        if (action === "connect") {
          await loginProvider(runtime, provider);
          connectedProviders.add(provider);
          console.log(color(`${provider} connected. Existing provider credentials were kept.`, theme.green));
          return;
        }
        if (action !== "use") throw new Error("Unknown /providers action.");
        if (!connectedProviders.has(provider)) {
          await loginProvider(runtime, provider);
          connectedProviders.add(provider);
        }
        const firstModel = runtime.models.getModels(provider)[0];
        if (!firstModel) throw new Error(`Provider has no known models: ${provider}`);
        config = { ...config, provider, model: firstModel.id, thinkingLevel: clampModelThinkingLevel(firstModel, config.thinkingLevel) };
        persist(activeAgent);
        console.log(color(`Provider: ${provider}, model: ${firstModel.id}`, theme.green));
        return rebuildAgent(session);
      }

      if (name === "models") {
        if (args[0] !== "select" || !args[1] || !args[2]) {
          console.log("Use /models and choose a model from the dropdown.");
          return;
        }
        const provider = args[1];
        const thinkingIndex = args.indexOf("--thinking", 2);
        const modelId = args.slice(2, thinkingIndex < 0 ? undefined : thinkingIndex).join(" ");
        const requestedThinking = thinkingIndex < 0 ? undefined : args[thinkingIndex + 1] as RayaConfig["thinkingLevel"] | undefined;
        if (!connectedProviders.has(provider)) {
          await loginProvider(runtime, provider);
          connectedProviders.add(provider);
        }
        model = getConfiguredModel(runtime, provider, modelId);
        const supported = getModelThinkingLevels(model);
        if (!requestedThinking) {
          console.log(`Choose a thinking level for ${model.name}: ${supported.join(", ")}.`);
          return;
        }
        if (!supported.includes(requestedThinking)) {
          console.log(`${model.name} supports: ${supported.join(", ")}.`);
          return;
        }
        config = { ...config, provider, model: model.id, thinkingLevel: requestedThinking };
        persist(activeAgent);
        console.log(color(`Model: ${model.name} · ${provider} · thinking: ${requestedThinking}`, theme.green));
        return rebuildAgent(session);
      }

      if (name === "thinking") {
        const requested = args[0] === "ultra" ? "xhigh" : args[0];
        const supported = getModelThinkingLevels(model);
        if (!requested || !supported.includes(requested as typeof supported[number])) {
          console.log(`This model supports: ${supported.join(", ") || "no configurable reasoning levels"}.`);
          return;
        }
        config = { ...config, thinkingLevel: requested as RayaConfig["thinkingLevel"] };
        applyConfigToAgent(activeAgent, config, runtime.models, model, mcp);
        persist(activeAgent);
        return;
      }

      if (name === "character") {
        const profile = characterProfile(args[0]);
        if (!profile) {
          console.log("Use /character and choose a personality from the dropdown.");
          return;
        }
        writePrivateFileAtomic(profilePaths(config.activeProfile).soul, profile.soul ? `${profile.soul.trimEnd()}\n` : "");
        console.log(color(`Character: ${profile.label}`, theme.green));
        return rebuildAgent(session);
      }

      if (name === "profile") {
        const action = args[0];
        if (!action) {
          printProfiles(config.activeProfile);
          return;
        }
        if (action === "create") {
          const requested = args[1];
          if (!requested) throw new Error("Usage: /profile create <name>");
          persist(activeAgent);
          createProfile(requested, { clone: true, cloneFrom: config.activeProfile });
          const selected = useProfile(requested);
          config = { ...config, activeProfile: selected };
          const next = createSession(config);
          console.log(color(`Created and activated profile: ${selected}`, theme.green));
          console.log(`Files: ${profilePaths(selected).directory}`);
          return rebuildAgent(next);
        }
        if (action === "delete" || action === "remove") {
          const requested = args[1];
          if (!requested) throw new Error("Usage: /profile delete <name>");
          if (requested.toLowerCase() === config.activeProfile) throw new Error("Switch to another profile before deleting the active profile.");
          try {
            await requestTerminalApproval("Delete profile", `${requested} and its profile files`);
          } catch (error) {
            if (error instanceof Error && error.message === "Action refused by user.") {
              console.log(color("Profile deletion cancelled.", theme.gray));
              return;
            }
            throw error;
          }
          deleteProfile(requested);
          deleteSessionsForProfile(requested.toLowerCase());
          console.log(color(`Deleted profile: ${requested.toLowerCase()}`, theme.green));
          return;
        }
        if (action === "show") {
          const requested = args[1] ?? config.activeProfile;
          const selected = listProfiles().find((item) => item.name === requested.toLowerCase());
          if (!selected) throw new Error(`Profile does not exist: ${requested}`);
          console.log(`Profile: ${selected.name}${selected.name === config.activeProfile ? " (active)" : ""}`);
          console.log(`Path: ${selected.path}`);
          console.log(`SOUL.md: ${selected.soulBytes} bytes · AGENTS.md: ${selected.agentsBytes} bytes · MEMORY.md: ${selected.memoryBytes} bytes`);
          return;
        }
        const requested = action === "use" ? args[1] : action;
        if (!requested) throw new Error("Use /profile and choose a profile.");
        persist(activeAgent);
        const selected = useProfile(requested);
        config = { ...config, activeProfile: selected };
        const next = createSession(config);
        console.log(color(`Active profile: ${selected}`, theme.green));
        return rebuildAgent(next);
      }

      if (name === "theme") {
        const requested = (args[0] === "global" || args[0] === "session" ? args[1] : args[0]) as ThemeId | undefined;
        if (!requested || !THEME_IDS.includes(requested)) {
          console.log(`Current global theme: ${themeLabels[loadConfig().theme]}. Use /theme and choose a theme.`);
          return;
        }
        config = { ...config, theme: requested };
        session.config = config;
        setActiveTheme(requested);
        updateConfig({ theme: requested });
        persist(activeAgent);
        console.log(color(`${themeLabels[requested]} is now the global theme.`, theme.green));
        return;
      }

      if (name === "security") {
        const securityMode = args[0];
        if (securityMode !== "standard" && securityMode !== "full") {
          console.log(`Current security: ${config.securityMode}. Use /security and select a mode.`);
          return;
        }
        config = { ...config, securityMode };
        applyConfigToAgent(activeAgent, config, runtime.models, model, mcp);
        persist(activeAgent);
        console.log(color(`Security: ${securityMode === "full" ? "Full access" : "Standard"}`, theme.green));
        return;
      }

      if (name === "sessions") {
        const action = args[0];
        if (action === "new") {
          persist(activeAgent);
          const next = createSession(config);
          const nextAgent = rebuildAgent(next);
          renderRestoredSession(next);
          return nextAgent;
        }
        if (action === "open") {
          const target = args[1];
          if (!target) throw new Error("Choose a session from the /sessions menu.");
          persist(activeAgent);
          const next = switchSession(target, process.cwd(), config.activeProfile);
          const nextAgent = rebuildAgent(next);
          renderRestoredSession(next);
          return nextAgent;
        }
        if (action === "delete") {
          const target = args[1];
          if (!target) throw new Error("Choose a session to delete from the /sessions menu.");
          const selected = findSession(target, process.cwd(), config.activeProfile);
          if (!selected) throw new Error(`Session not found: ${target}`);
          try {
            await requestTerminalApproval("Delete session", `${selected.name} (${selected.id})`);
          } catch (error) {
            if (error instanceof Error && error.message === "Action refused by user.") {
              console.log(color("Session deletion cancelled.", theme.gray));
              return;
            }
            throw error;
          }
          persist(activeAgent);
          const deleted = deleteSession(target, process.cwd(), config.activeProfile);
          console.log(color(`Deleted session: ${deleted.name}`, theme.green));
          if (deleted.id === session.id) {
            const next = createSession(config);
            console.log(color("Started a new empty session.", theme.gray));
            return rebuildAgent(next);
          }
          return;
        }
        console.log("Use /sessions to create, open, or delete a session.");
        return;
      }

      if (name === "status") {
        console.log(`Profile   : ${config.activeProfile}`);
        console.log(`Profile files: ${profilePaths(config.activeProfile).directory}`);
        console.log(`Provider  : ${config.provider}`);
        console.log(`Model     : ${config.model} (${config.thinkingLevel})`);
        console.log(`Mode      : ${config.mode === "plan" ? "Plan" : "Build"}`);
        console.log(`Security  : ${config.securityMode}`);
        console.log(`Design    : ${config.headerStyle}`);
        console.log(`Theme     : ${themeLabels[config.theme]}`);
        const enabledMcp = Object.entries(config.mcpServers).filter(([, server]) => server.enabled).map(([serverName]) => serverName);
        console.log(`MCP servers   : ${enabledMcp.length ? enabledMcp.join(", ") : "None"}`);
        console.log(`Skills        : ${listAvailableSkills().length}`);
        console.log(`Commands      : ${listCustomCommands().length} (${RAYA_COMMANDS_PATH})`);
        console.log(`Backup        : ${config.backup ? `${config.backup.mode} (${backupTargetLabel(config.backup)})` : "Not configured"}`);
        console.log(`Session   : ${session.name}`);
        console.log(`Config    : ${RAYA_CONFIG_PATH}`);
        console.log("Credentials: stored securely");
        return;
      }

      if (name === "mcps" || name === "mcp") {
        console.log(formatMcpStatusLines(mcp.statuses).join("\n"));
        return;
      }

      if (name === "skills") {
        console.log("Use /skills and choose a skill to attach it to the current message.");
        return;
      }

      console.log(`Unknown command: /${name}. Use /help.`);
    };

    if (prompt) {
      try {
        await agent.prompt(prompt);
        await agent.waitForIdle();
        persist(agent);
        console.log();
      } finally {
        await mcp.close();
      }
      return;
    }

    const telegramToken = readSecret("RAYA_TELEGRAM_BOT_TOKEN");
    const telegramChatId = readSecret("RAYA_TELEGRAM_ALLOWED_CHAT_ID");
    const telegram = telegramToken && telegramChatId ? startTelegramService({
      token: telegramToken,
      allowedChatId: telegramChatId,
      onStatus: (status) => notifyTui(status === "disconnected"
        ? "Telegram: connection lost · retrying automatically"
        : "Telegram: connection restored"),
      onPrompt: async (remotePrompt, toolPolicy, signal) => sessionLock.run(async () => {
          let streamed = "";
          const remoteAgent = createRayaAgent({
            config,
            model,
            models: runtime.models,
            toolPolicy,
            mcp,
            onEvent: (event) => {
              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                streamed += event.assistantMessageEvent.delta;
              }
            }
          });
          remoteAgent.state.messages = session.messages;
          await promptWithAbort(remoteAgent, remotePrompt, signal);
          persist(remoteAgent);
          return streamed || lastAssistantText(remoteAgent);
        })
    }) : undefined;

    if (telegram) console.log(color("Telegram listener started for this Raya session.", theme.cyan));
    const stopScheduler = startScheduler(async (task) => {
      if (!telegram || !telegramChatId) throw new Error("Scheduled delivery requires Telegram setup: raya gateway --setup");
      await telegram.sendMessage(telegramChatId, `Reminder: ${task.message}`);
    }, (error) => notifyTui(`Scheduler error: ${error.message}`));
    let signalExitStarted = false;
    const exitImmediately = (): void => {
      if (signalExitStarted) return;
      signalExitStarted = true;
      console.log("\nBye bye");
      stopScheduler();
      void telegram?.stop().finally(() => process.exit(0));
      if (!telegram) process.exit(0);
    };
    process.on("SIGINT", exitImmediately);
    try {
      await runInteractiveTui(agent, {
        model: model.name,
        mode: config.mode === "plan" ? "Plan" : "Build",
        directory: formatDirectory(process.cwd()),
        memory: "Enabled",
        profile: config.activeProfile,
        headerStyle: config.headerStyle,
        session: session.name,
        version: VERSION,
        contextTokens: 0,
        contextWindow: model.contextWindow,
        thinkingLevel: config.thinkingLevel,
        hotkeys: config.hotkeys
      }, {
        workspace: process.cwd(),
        onCommand: ({ agent: activeAgent, command }) => sessionLock.run(() => handleCommand(activeAgent, command)),
        onBeforePrompt: () => sessionLock.acquire(),
        onAfterPrompt: (activeAgent) => persist(activeAgent),
        onToggleMode: (activeAgent) => sessionLock.run(() => {
          config = { ...config, mode: config.mode === "plan" ? "build" : "plan" };
          applyConfigToAgent(activeAgent, config, runtime.models, model, mcp);
          persist(activeAgent);
          return { mode: config.mode === "plan" ? "Plan" : "Build" };
        }),
        sessionSuggestions: () => listSessions(process.cwd(), config.activeProfile).map((item) => ({
          id: item.id,
          name: item.name,
          detail: `${item.config.provider}/${item.config.model} · ${item.config.mode}`
        })),
        thinkingSuggestions: () => getModelThinkingLevels(model),
        skillSuggestions: () => listAvailableSkills().map((skill) => ({
          name: skill.name,
          description: skill.description
        })),
        characterSuggestions: (query) => characterSuggestions(query),
        profileSuggestions: (query) => {
          const normalized = query.trim().toLowerCase();
          if (normalized.startsWith("create ") || normalized.startsWith("delete ")) return [];
          const filter = normalized.replace(/^use\s+/, "");
          const profiles = listProfiles().filter((item) => !filter || item.name.includes(filter));
          return [
            { value: "/profile create", description: "Create a profile cloned from the active identity", needsArgument: true },
            { value: "Profiles:", description: "", selectable: false },
            ...profiles.map((item) => ({
              value: `/profile use ${item.name}`,
              label: item.name,
              description: item.name === config.activeProfile ? "Current profile" : "Switch profile"
            }))
          ];
        },
        themeSuggestions: () => {
          const globalTheme = loadConfig().theme;
          return [
            { value: "Global theme:", description: "", selectable: false },
            ...THEME_IDS.map((id) => ({
              value: `/theme ${id}`,
              label: themeLabels[id],
              description: id === globalTheme ? "Current global theme" : "Apply globally"
            }))
          ];
        },
        providerSuggestions: (value) => {
          const managed = value.match(/^\/providers manage (\S+)\s*$/)?.[1];
          if (managed) {
            const connected = connectedProviders.has(managed);
            const local = config.localModels.some((item) => item.provider === managed);
            return [
              { value: `/providers use ${managed}`, description: local ? "Use this local provider" : connected ? "Use this connected provider" : "Connect and use this provider" },
              ...(!local ? [{ value: `/providers connect ${managed}`, description: connected ? "Update API key / reconnect" : "Connect provider" }] : [])
            ];
          }
          const query = value === "/providers" ? "" : value.slice("/providers ".length).trim().toLowerCase();
          const providers = [...runtime.models.getProviders()]
            .filter((provider) => !query || `${provider.id} ${provider.name}`.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));
          const suggestion = (provider: typeof providers[number]) => ({
              value: `/providers manage ${provider.id}`,
              description: `${provider.name} · ${connectedProviders.has(provider.id) ? "connected" : authLabel(provider)}`,
              needsArgument: true
            });
          const setUped = providers.filter((provider) => connectedProviders.has(provider.id));
          const others = providers.filter((provider) => !connectedProviders.has(provider.id));
          return [
            { value: "SetUped:", description: "", selectable: false },
            ...(setUped.length ? setUped.map(suggestion) : [{ value: "  (none)", description: "", selectable: false }]),
            { value: "Others:", description: "", selectable: false },
            ...(others.length ? others.map(suggestion) : [{ value: "  (none)", description: "", selectable: false }])
          ];
        },
        modelSuggestions: (query) => providerModelSuggestions(runtime.models, query, {
          activeProvider: config.provider,
          activeModel: config.model,
          connectedProviders
        }),
        statusInfo: () => {
          const assistantMessages = session.messages.filter((message) => message.role === "assistant") as Array<{ usage?: { totalTokens?: number } }>;
          const contextTokens = [...assistantMessages].reverse().find((message) => message.usage?.totalTokens)?.usage?.totalTokens ?? 0;
          return {
            model: model.name,
            mode: config.mode === "plan" ? "Plan" : "Build",
            directory: formatDirectory(process.cwd()),
            memory: "Enabled",
            profile: config.activeProfile,
            headerStyle: config.headerStyle,
            session: session.name,
            version: VERSION,
            contextTokens,
            contextWindow: model.contextWindow,
            thinkingLevel: config.thinkingLevel,
            hotkeys: config.hotkeys
          };
        },
        hotkeys: config.hotkeys
      });
    } finally {
      process.off("SIGINT", exitImmediately);
      stopScheduler();
      await telegram?.stop();
      await mcp.close();
    }
  });

function commandNames(command: Command): string[] {
  return [command.name(), command.alias()].filter(Boolean);
}

builtinCommandNames = new Set(program.commands.flatMap(commandNames));
for (const custom of ["uninstall", "update"].includes(process.argv[2] ?? "") ? [] : listCustomCommands()) {
  if (builtinCommandNames.has(custom.name)) continue;
  program
    .command(custom.name)
    .description(custom.description ?? `Run ${formatCustomCommand(custom)}.`)
    .argument("[args...]", "Additional arguments appended to the saved command.")
    .allowUnknownOption(true)
    .action((args: string[]) => runCustomCommand(custom, args));
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(color(message, theme.red));
  process.exitCode = 1;
});
