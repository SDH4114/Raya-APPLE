import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RayaConfig } from "../config/config.js";
import { RAYA_HOME } from "../config/paths.js";
import { commandInvocation } from "../platform.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";

export const RAYA_BACKUP_ROOT = process.env.RAYA_BACKUP_ROOT ?? join(homedir(), "raya-backups");
export const RAYA_BACKUP_TARGET_ENV = "RAYA_BACKUP_TARGET";
const REMOTE_SNAPSHOT_DIR = ".raya-backup";
const SECRET_STATE_FILES = new Set([".env", "auth.json"]);

type BackupConfig = NonNullable<RayaConfig["backup"]>;

export interface BackupManifest {
  id: string;
  name: string;
  createdAt: string;
  rayaVersion: string;
  mode: "local" | "github";
  secretsIncluded: boolean;
  kind?: "manual" | "update-checkpoint";
  targetVersion?: string;
}

export interface BackupListItem extends BackupManifest {
  reference: string;
  directory: string;
  target: string;
  layout: "github" | "local-flat" | "local-git" | "local-legacy";
}

export interface BackupCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BackupCommandRunner = (command: string, args: string[], options?: { cwd?: string; stdio?: "inherit" | "pipe" }) => Promise<BackupCommandResult>;

export const runBackupCommand: BackupCommandRunner = (command, args, options = {}) => new Promise((resolveCommand, reject) => {
  const invocation = commandInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    stdio: options.stdio === "inherit" ? "inherit" : ["inherit", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  if (child.stdout) child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
  if (child.stderr) child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("close", (code) => resolveCommand({ code: code ?? 1, stdout, stderr }));
});

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function safeSegment(value: string, fallback = "backup"): string {
  const normalized = value.trim().normalize("NFKC")
    .replace(/[\\/:\0]/g, "-")
    .replace(/[\u0001-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80)
    .trim();
  return normalized || fallback;
}

function pathInside(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested === "" || (!nested.startsWith(`..${sep}`) && nested !== "..");
}

function resolveThroughExistingAncestor(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const existing = existsSync(current) ? realpathSync(current) : current;
  return resolve(existing, ...missing);
}

function assertBackupRootOutsideRayaHome(): void {
  const state = resolveThroughExistingAncestor(RAYA_HOME);
  const backupRoot = resolveThroughExistingAncestor(RAYA_BACKUP_ROOT);
  if (pathInside(state, backupRoot)) {
    throw new Error(`RAYA_BACKUP_ROOT must be outside RAYA_HOME: ${RAYA_BACKUP_ROOT}`);
  }
}

function excludedSourcePath(source: string, candidate: string): boolean {
  const parts = relative(source, candidate).split(sep);
  return pathInside(RAYA_HOME, candidate)
    || parts.some((part) => part === ".git" || part === "node_modules" || part === ".DS_Store" || part === ".next" || part === "coverage");
}

function copySourceContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const backupRootIsInsideSource = pathInside(source, RAYA_BACKUP_ROOT);
  for (const entry of readdirSync(source)) {
    const candidate = join(source, entry);
    if (excludedSourcePath(source, candidate) || (backupRootIsInsideSource && pathInside(RAYA_BACKUP_ROOT, candidate))) continue;
    cpSync(candidate, join(destination, entry), {
      recursive: true,
      filter: (nested) => !excludedSourcePath(source, nested)
        && (!backupRootIsInsideSource || !pathInside(RAYA_BACKUP_ROOT, nested))
    });
  }
}

function copyState(destination: string, includeSecrets: boolean): void {
  if (!existsSync(RAYA_HOME)) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    return;
  }
  cpSync(RAYA_HOME, destination, {
    recursive: true,
    filter: (candidate) => {
      if (candidate === RAYA_HOME || includeSecrets) return true;
      return !SECRET_STATE_FILES.has(relative(RAYA_HOME, candidate));
    }
  });
  if (!includeSecrets) {
    sanitizeRemoteMcpCredentials(destination);
    writeFileSync(
      join(destination, "SECRETS_NOT_INCLUDED.txt"),
      "GitHub backups exclude .env, auth.json, and literal MCP headers/environment values. Restore credentials with raya login, raya gateway --setup, and environment placeholders.\n",
      { mode: 0o600 }
    );
  }
}

function placeholderOnly(values: unknown): Record<string, string> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(entry[1])));
}

function redactMcpCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) redactMcpCredentials(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.mcpServers && typeof record.mcpServers === "object" && !Array.isArray(record.mcpServers)) {
    for (const server of Object.values(record.mcpServers as Record<string, unknown>)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) continue;
      const config = server as Record<string, unknown>;
      if ("headers" in config) config.headers = placeholderOnly(config.headers);
      if ("env" in config) config.env = placeholderOnly(config.env);
    }
  }
  for (const item of Object.values(record)) redactMcpCredentials(item);
}

function sanitizeRemoteMcpCredentials(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch (error) {
        throw new Error(`GitHub backup refused malformed JSON that could not be safely sanitized: ${path}`, { cause: error });
      }
      redactMcpCredentials(value);
      writePrivateFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  visit(root);
}

async function createPackageArchive(destination: string, runner: BackupCommandRunner): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "raya-pack-"));
  try {
    const result = await runner("npm", ["pack", "--ignore-scripts", "--cache", join(temporary, "npm-cache"), "--pack-destination", temporary, packageRoot()]);
    if (result.code !== 0) throw new Error(`Could not package Raya: ${result.stderr.trim() || `npm exited ${result.code}`}`);
    const archive = readdirSync(temporary).find((entry) => entry.endsWith(".tgz"));
    if (!archive) throw new Error("npm pack did not create a Raya archive.");
    cpSync(join(temporary, archive), join(destination, "raya-package.tgz"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function writeManifest(destination: string, manifest: BackupManifest): void {
  writePrivateFileAtomic(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseManifest(content: string): BackupManifest | undefined {
  try {
    const value = JSON.parse(content) as Partial<BackupManifest> | null;
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.createdAt !== "string" || typeof value.rayaVersion !== "string") return undefined;
    if (value.mode !== "local" && value.mode !== "github") return undefined;
    if (typeof value.secretsIncluded !== "boolean") return undefined;
    if (value.kind !== undefined && value.kind !== "manual" && value.kind !== "update-checkpoint") return undefined;
    if (value.targetVersion !== undefined && typeof value.targetVersion !== "string") return undefined;
    return value as BackupManifest;
  } catch {
    return undefined;
  }
}

function readManifest(path: string): BackupManifest {
  const manifest = parseManifest(readFileSync(path, "utf8"));
  if (!manifest) throw new Error(`Invalid Raya backup manifest: ${path}`);
  return manifest;
}

function sanitizedGithubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseGithubRepository(value: string): { url: string; repository: string } {
  const url = value.trim();
  const https = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  const ssh = url.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  const match = https ?? ssh;
  if (!match) throw new Error("Use a GitHub repository URL such as https://github.com/owner/repository.git or git@github.com:owner/repository.git.");
  return { url, repository: match[2]! };
}

export function localBackupDirectory(name: string): string {
  return join(RAYA_BACKUP_ROOT, safeSegment(name));
}

function repositoryUrl(config: BackupConfig): string {
  const repository = config.repository ?? (config.mode === "github" ? config.directory : undefined);
  if (!repository) throw new Error("GitHub backups are not configured. Run: raya backup --setup");
  return repository;
}

export async function setupGithubBackup(url: string, runner: BackupCommandRunner = runBackupCommand): Promise<BackupConfig> {
  const parsed = parseGithubRepository(url);
  const checked = await runner("git", ["ls-remote", "--", parsed.url]);
  if (checked.code !== 0) throw new Error(`Could not access GitHub backup repository: ${checked.stderr.trim() || `git exited ${checked.code}`}`);
  return {
    mode: "github",
    name: parsed.repository,
    repository: sanitizedGithubUrl(parsed.url),
    configuredAt: new Date().toISOString()
  };
}

export async function setupLocalBackup(_name = "local", _runner: BackupCommandRunner = runBackupCommand): Promise<BackupConfig> {
  assertBackupRootOutsideRayaHome();
  mkdirSync(RAYA_BACKUP_ROOT, { recursive: true, mode: 0o700 });
  return { mode: "local", name: "local", directory: RAYA_BACKUP_ROOT, configuredAt: new Date().toISOString() };
}

async function populateRemoteSnapshot(destination: string, manifest: BackupManifest, runner: BackupCommandRunner): Promise<void> {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copySourceContents(packageRoot(), join(destination, "raya-source"));
  copyState(join(destination, "raya-home"), false);
  await createPackageArchive(destination, runner);
  writeManifest(destination, manifest);
}

async function populateLocalSnapshot(destination: string, manifest: BackupManifest, runner: BackupCommandRunner): Promise<void> {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copySourceContents(packageRoot(), destination);
  copyState(join(destination, ".raya"), true);
  await createPackageArchive(destination, runner);
  writeManifest(destination, manifest);
}

async function withTemporaryGithubClone<T>(config: BackupConfig, runner: BackupCommandRunner, operation: (repository: string) => Promise<T>): Promise<T> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "raya-github-backup-"));
  const checkout = join(temporaryRoot, "repository");
  try {
    const cloned = await runner("git", ["clone", "--", repositoryUrl(config), checkout]);
    if (cloned.code !== 0) throw new Error(`Could not clone GitHub backup repository: ${cloned.stderr.trim() || `git exited ${cloned.code}`}`);
    return await operation(checkout);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function writeRemoteSnapshot(repository: string, manifest: BackupManifest, runner: BackupCommandRunner): Promise<void> {
  const destination = join(repository, REMOTE_SNAPSHOT_DIR);
  const temporary = mkdtempSync(join(repository, ".raya-backup-write-"));
  try {
    await populateRemoteSnapshot(temporary, manifest, runner);
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function createBackup(config: BackupConfig, name: string, rayaVersion: string, runner: BackupCommandRunner = runBackupCommand): Promise<BackupListItem> {
  const displayName = name.trim();
  if (!displayName) throw new Error("Backup name cannot be empty.");
  const folderName = safeSegment(displayName);
  const manifest: BackupManifest = {
    id: folderName,
    name: displayName,
    createdAt: new Date().toISOString(),
    rayaVersion,
    mode: config.mode,
    secretsIncluded: config.mode === "local",
    kind: "manual"
  };

  if (config.mode === "local") {
    assertBackupRootOutsideRayaHome();
    mkdirSync(RAYA_BACKUP_ROOT, { recursive: true, mode: 0o700 });
    const destination = localBackupDirectory(displayName);
    let reserved = false;
    try {
      mkdirSync(destination, { mode: 0o700 });
      reserved = true;
      await populateLocalSnapshot(destination, manifest, runner);
    } catch (error) {
      if (!reserved && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`A local backup named "${displayName}" already exists: ${destination}`);
      }
      if (reserved) rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return { ...manifest, reference: folderName, directory: destination, target: folderName, layout: "local-flat" };
  }

  return withTemporaryGithubClone(config, runner, async (repository) => {
    await writeRemoteSnapshot(repository, manifest, runner);
    for (const [key, value] of [["user.name", "Raya Backup"], ["user.email", "raya-backup@local"]] as const) {
      const configured = await runner("git", ["config", key, value], { cwd: repository });
      if (configured.code !== 0) throw new Error(`Could not configure temporary Git checkout: ${configured.stderr.trim()}`);
    }
    let result = await runner("git", ["add", "--", REMOTE_SNAPSHOT_DIR], { cwd: repository });
    if (result.code !== 0) throw new Error(`Could not stage Raya backup: ${result.stderr.trim()}`);
    result = await runner("git", ["commit", "-m", `Raya backup: ${displayName}`, "--", REMOTE_SNAPSHOT_DIR], { cwd: repository });
    if (result.code !== 0) throw new Error(`Could not commit Raya backup: ${result.stderr.trim() || result.stdout.trim()}`);
    const commit = await runner("git", ["rev-parse", "HEAD"], { cwd: repository });
    if (commit.code !== 0) throw new Error(`Could not read Raya backup commit: ${commit.stderr.trim()}`);
    result = await runner("git", ["push", "--set-upstream", "origin", "HEAD"], { cwd: repository, stdio: "inherit" });
    if (result.code !== 0) throw new Error(`Could not push Raya backup (git exited ${result.code}). No persistent local copy was kept.`);
    return {
      ...manifest,
      reference: commit.stdout.trim(),
      directory: repositoryUrl(config),
      target: config.name,
      layout: "github" as const
    };
  });
}

function updateCheckpointFolder(currentVersion: string, targetVersion: string, createdAt: Date): string {
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return safeSegment(`update-${currentVersion}-to-${targetVersion}-${timestamp}`);
}

/**
 * Create an unconditional local recovery point before the updater changes the
 * installed package. This does not read or write backup configuration in
 * RAYA_HOME and never mutates the state being copied.
 */
export async function createUpdateCheckpoint(
  currentVersion: string,
  targetVersion: string,
  runner: BackupCommandRunner = runBackupCommand,
  createdAt = new Date()
): Promise<BackupListItem> {
  assertBackupRootOutsideRayaHome();
  mkdirSync(RAYA_BACKUP_ROOT, { recursive: true, mode: 0o700 });
  const baseName = updateCheckpointFolder(currentVersion, targetVersion, createdAt);
  let folderName = baseName;
  let suffix = 2;
  let destination = join(RAYA_BACKUP_ROOT, folderName);
  while (true) {
    try {
      mkdirSync(destination, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      folderName = `${baseName}-${suffix}`;
      suffix += 1;
      destination = join(RAYA_BACKUP_ROOT, folderName);
    }
  }

  const manifest: BackupManifest = {
    id: folderName,
    name: `Before update v${currentVersion} to v${targetVersion}`,
    createdAt: createdAt.toISOString(),
    rayaVersion: currentVersion,
    mode: "local",
    secretsIncluded: true,
    kind: "update-checkpoint",
    targetVersion
  };
  try {
    await populateLocalSnapshot(destination, manifest, runner);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw new Error(`Could not create the required update checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...manifest,
    reference: folderName,
    directory: destination,
    target: folderName,
    layout: "local-flat"
  };
}

async function listGitHistory(directory: string, mode: "local" | "github", target: string, runner: BackupCommandRunner): Promise<BackupListItem[]> {
  const manifestPath = mode === "github" ? `${REMOTE_SNAPSHOT_DIR}/manifest.json` : "manifest.json";
  const log = await runner("git", ["log", "--format=%H", "--", manifestPath], { cwd: directory });
  if (log.code !== 0) return [];
  const items: BackupListItem[] = [];
  for (const commit of log.stdout.split(/\r?\n/).filter(Boolean)) {
    const shown = await runner("git", ["show", `${commit}:${manifestPath}`], { cwd: directory });
    const manifest = shown.code === 0 ? parseManifest(shown.stdout) : undefined;
    if (!manifest || manifest.mode !== mode) continue;
    items.push({
      ...manifest,
      reference: commit,
      directory: mode === "github" ? target : directory,
      target: mode === "github" ? target : basename(directory),
      layout: mode === "github" ? "github" : "local-git"
    });
  }
  return items;
}

function listLegacyBackups(directory: string): BackupListItem[] {
  const roots = [join(directory, "snapshots"), join(directory, ".raya-legacy-snapshots")];
  return roots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "manifest.json")))
      .flatMap((entry) => {
        const manifest = parseManifest(readFileSync(join(root, entry.name, "manifest.json"), "utf8"));
        return manifest?.mode === "local" ? [{
          ...manifest,
          reference: entry.name,
          directory,
          target: basename(directory),
          layout: "local-legacy" as const
        }] : [];
      });
  });
}

async function discoverLocalBackups(runner: BackupCommandRunner): Promise<BackupListItem[]> {
  if (!existsSync(RAYA_BACKUP_ROOT)) return [];
  const found: BackupListItem[] = [];
  for (const entry of readdirSync(RAYA_BACKUP_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".raya-")) continue;
    const directory = join(RAYA_BACKUP_ROOT, entry.name);
    const manifestPath = join(directory, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
      if (manifest?.mode === "local") found.push({
        ...manifest,
        reference: entry.name,
        directory,
        target: entry.name,
        layout: "local-flat"
      });
    }
    if (existsSync(join(directory, ".git"))) found.push(...await listGitHistory(directory, "local", entry.name, runner));
    found.push(...listLegacyBackups(directory));
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listGithubBackups(config: BackupConfig, runner: BackupCommandRunner): Promise<BackupListItem[]> {
  if (config.mode !== "github") return [];
  return withTemporaryGithubClone(config, runner, async (repository) => {
    const items = await listGitHistory(repository, "github", repositoryUrl(config), runner);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export async function listBackups(config: BackupConfig, runner: BackupCommandRunner = runBackupCommand): Promise<BackupListItem[]> {
  return config.mode === "github" ? listGithubBackups(config, runner) : discoverLocalBackups(runner);
}

export interface DiscoveredBackups {
  github: BackupListItem[];
  local: BackupListItem[];
}

export async function discoverBackups(config?: BackupConfig, runner: BackupCommandRunner = runBackupCommand): Promise<DiscoveredBackups> {
  const [github, local] = await Promise.all([
    config?.mode === "github" ? listGithubBackups(config, runner) : Promise.resolve([]),
    discoverLocalBackups(runner)
  ]);
  return { github, local };
}

async function installSnapshot(snapshot: string, runner: BackupCommandRunner): Promise<void> {
  const archive = join(snapshot, "raya-package.tgz");
  if (!existsSync(archive)) throw new Error(`Backup is missing Raya package archive: ${archive}`);
  const temporary = mkdtempSync(join(tmpdir(), "raya-restore-npm-"));
  try {
    const installed = await runner("npm", ["install", "-g", "--ignore-scripts", "--cache", join(temporary, "npm-cache"), archive], { stdio: "inherit" });
    if (installed.code !== 0) throw new Error(`Could not reinstall Raya from the backup (npm exited ${installed.code}).`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function restoreState(snapshot: string, stateDirectory: "raya-home" | ".raya", replace: boolean): void {
  const storedState = join(snapshot, stateDirectory);
  if (!existsSync(storedState)) throw new Error(`Backup is missing Raya state: ${storedState}`);
  if (replace) rmSync(RAYA_HOME, { recursive: true, force: true });
  mkdirSync(RAYA_HOME, { recursive: true, mode: 0o700 });
  cpSync(storedState, RAYA_HOME, { recursive: true, force: true });
}

async function restoreSnapshot(snapshot: string, stateDirectory: "raya-home" | ".raya", replace: boolean, runner: BackupCommandRunner): Promise<BackupManifest> {
  const manifest = readManifest(join(snapshot, "manifest.json"));
  await installSnapshot(snapshot, runner);
  restoreState(snapshot, stateDirectory, replace);
  return manifest;
}

async function restoreGitWorktree(repository: string, reference: string, layout: "github" | "local-git", runner: BackupCommandRunner): Promise<BackupManifest> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "raya-restore-"));
  const checkout = join(temporaryRoot, "checkout");
  let worktreeAdded = false;
  try {
    const added = await runner("git", ["worktree", "add", "--detach", checkout, reference], { cwd: repository });
    if (added.code !== 0) throw new Error(`Could not open backup ${reference}: ${added.stderr.trim()}`);
    worktreeAdded = true;
    const snapshot = layout === "github" ? join(checkout, REMOTE_SNAPSHOT_DIR) : checkout;
    return restoreSnapshot(snapshot, layout === "github" ? "raya-home" : ".raya", layout !== "github", runner);
  } finally {
    if (worktreeAdded) await runner("git", ["worktree", "remove", "--force", checkout], { cwd: repository });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function restoreBackup(config: BackupConfig, reference: string, runner: BackupCommandRunner = runBackupCommand): Promise<BackupManifest> {
  const candidates = await listBackups(config, runner);
  const selected = candidates.find((item) => item.reference === reference || item.name === reference);
  if (!selected) throw new Error(`Backup not found: ${reference}`);
  return restoreDiscoveredBackup(selected, runner);
}

export async function restoreDiscoveredBackup(selected: BackupListItem, runner: BackupCommandRunner = runBackupCommand): Promise<BackupManifest> {
  if (selected.layout === "local-flat") return restoreSnapshot(selected.directory, ".raya", true, runner);
  if (selected.layout === "local-legacy") {
    const roots = [join(selected.directory, "snapshots"), join(selected.directory, ".raya-legacy-snapshots")];
    const snapshot = roots.map((root) => join(root, selected.reference)).find((path) => existsSync(join(path, "manifest.json")));
    if (!snapshot) throw new Error(`Legacy backup not found: ${selected.reference}`);
    return restoreSnapshot(snapshot, "raya-home", true, runner);
  }
  if (selected.layout === "local-git") return restoreGitWorktree(selected.directory, selected.reference, "local-git", runner);

  const config: BackupConfig = {
    mode: "github",
    name: selected.target,
    repository: selected.directory,
    configuredAt: new Date().toISOString()
  };
  return withTemporaryGithubClone(config, runner, (repository) => restoreGitWorktree(repository, selected.reference, "github", runner));
}
