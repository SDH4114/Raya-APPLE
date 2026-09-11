import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ensureRayaHome, RAYA_CONFIG_PATH } from "./paths.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";
import { ensureBuiltinSkills } from "../skills/bootstrap.js";
import { DEFAULT_HOTKEYS, HotkeysSchema } from "../tui/hotkeys.js";
import { DEFAULT_PROFILE, ensureProfile, PROFILE_NAME_PATTERN } from "../profiles/store.js";

const LocalModelSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  baseUrl: z.string().url(),
  contextWindow: z.number().int().positive().default(32_768),
  maxTokens: z.number().int().positive().default(8_192)
});

function isSecureRemoteUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:"
    || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()));
}

const McpCommonSchema = z.object({
  enabled: z.boolean().default(true),
  approval: z.enum(["always", "writes", "never"]).default("writes"),
  trustReadOnlyAnnotations: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  toolTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)
});

const McpStdioServerSchema = McpCommonSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({})
});

const McpHttpServerSchema = McpCommonSchema.extend({
  transport: z.literal("http"),
  url: z.string().url().refine(isSecureRemoteUrl, "Remote MCP URLs must use HTTPS; HTTP is allowed only on loopback"),
  headers: z.record(z.string(), z.string()).default({})
});

const McpSseServerSchema = McpCommonSchema.extend({
  transport: z.literal("sse"),
  url: z.string().url().refine(isSecureRemoteUrl, "Remote MCP URLs must use HTTPS; HTTP is allowed only on loopback"),
  headers: z.record(z.string(), z.string()).default({})
});

const McpServerSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = { ...value as Record<string, unknown> };
  if (raw.transport === undefined && typeof raw.type === "string") raw.transport = raw.type;
  if (raw.transport === undefined && typeof raw.command === "string") raw.transport = "stdio";
  if (raw.transport === undefined && typeof raw.url === "string") raw.transport = "http";
  delete raw.type;
  return raw;
}, z.discriminatedUnion("transport", [McpStdioServerSchema, McpHttpServerSchema, McpSseServerSchema]));

const BackupSchema = z.object({
  mode: z.enum(["local", "github"]),
  name: z.string().min(1).max(100),
  directory: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  configuredAt: z.string().datetime()
});

const ConfigSchema = z.object({
  activeProfile: z.string().regex(PROFILE_NAME_PATTERN).default(DEFAULT_PROFILE),
  provider: z.string().default("openai-codex"),
  model: z.string().default("gpt-5.4"),
  mode: z.enum(["plan", "build"]).default("plan"),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("minimal"),
  autoApproveCommands: z.array(z.string().min(1)).default([]),
  blockedCommands: z.array(z.string().min(1)).default(["rm"]),
  securityMode: z.enum(["standard", "full"]).default("standard"),
  headerStyle: z.enum(["small", "large"]).default("small"),
  theme: z.enum(["ocean", "sunset"]).default("ocean"),
  hotkeys: HotkeysSchema.default(DEFAULT_HOTKEYS),
  localModels: z.array(LocalModelSchema).default([]),
  piPackages: z.array(z.string().min(1)).default([]),
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), McpServerSchema).default({}),
  backup: BackupSchema.optional(),
  shellTimeoutMs: z.number().int().positive().default(120_000),
  webTimeoutMs: z.number().int().positive().default(15_000),
  webMaxChars: z.number().int().positive().default(12_000)
});

export type RayaConfig = z.infer<typeof ConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;

const defaultConfig: RayaConfig = ConfigSchema.parse({});

export function normalizeConfig(value: unknown): RayaConfig {
  const raw = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
  // Migrate legacy settings without making users edit JSON by hand.
  if (raw.mode === "edit") raw.mode = "build";
  delete raw.neovim_mode;
  delete raw.vim_mode;
  return ConfigSchema.parse(raw);
}

export function loadConfig(): RayaConfig {
  ensureRayaHome();
  ensureBuiltinSkills();

  const config = !existsSync(RAYA_CONFIG_PATH)
    ? ConfigSchema.parse(defaultConfig)
    : normalizeConfig(JSON.parse(readFileSync(RAYA_CONFIG_PATH, "utf8")));
  ensureProfile(config.activeProfile);
  return config;
}

export function saveConfig(config: RayaConfig): void {
  updateConfig(config);
}

/** Merge only requested settings into config.json and preserve unknown user keys. */
export function updateConfig(patch: Partial<RayaConfig>): RayaConfig {
  ensureRayaHome();
  const raw = existsSync(RAYA_CONFIG_PATH)
    ? JSON.parse(readFileSync(RAYA_CONFIG_PATH, "utf8")) as unknown
    : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Raya config must contain a JSON object: ${RAYA_CONFIG_PATH}`);
  }
  const preserved = { ...raw as Record<string, unknown> };
  delete preserved.neovim_mode;
  delete preserved.vim_mode;
  const next = normalizeConfig({ ...preserved, ...patch });
  writePrivateFileAtomic(RAYA_CONFIG_PATH, `${JSON.stringify({ ...preserved, ...next }, null, 2)}\n`);
  return next;
}
