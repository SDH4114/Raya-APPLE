import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGithubRepository } from "../src/backup/store.js";
import { isUninstallApproved } from "../src/cli/uninstall.js";

const entrypoint = ["--import", "tsx", "src/cli/index.ts"];

test("GitHub backup setup accepts only repository URLs and extracts the repository name", () => {
  assert.deepEqual(parseGithubRepository("https://github.com/example/raya-vault.git"), {
    url: "https://github.com/example/raya-vault.git",
    repository: "raya-vault"
  });
  assert.deepEqual(parseGithubRepository("git@github.com:example/raya-vault.git"), {
    url: "git@github.com:example/raya-vault.git",
    repository: "raya-vault"
  });
  assert.throws(() => parseGithubRepository("https://example.com/not-github/repo"), /GitHub repository URL/);
});

test("uninstall requires the exact destructive confirmation", () => {
  assert.equal(isUninstallApproved("UNINSTALL"), true);
  assert.equal(isUninstallApproved(" uninstall "), false);
  assert.equal(isUninstallApproved("yes"), false);
});

test("local backups are sibling folders with files directly inside and restore from the selected source", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-backup-test-"));
  const home = join(root, ".raya");
  const backups = join(root, "raya-backups");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "USER.md"), "remember me\n");
  writeFileSync(join(home, ".env"), "RAYA_TEST_SECRET=present\n");

  const env = { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: backups, NO_COLOR: "1" };
  const created = execFileSync(process.execPath, [...entrypoint, "backup", "--local", "before-upgrade"], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000
  });
  assert.match(created, /Local backup configured/);
  assert.match(created, /Saved Raya backup: before-upgrade/);
  assert.doesNotMatch(created, /!\s+Local backup/);

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    backup: { mode: string; name: string; directory: string };
  };
  assert.deepEqual(config.backup, {
    mode: "local",
    name: "local",
    directory: backups,
    configuredAt: config.backup.configuredAt
  });
  assert.match(readFileSync(join(home, ".env"), "utf8"), new RegExp(`RAYA_BACKUP_TARGET=${backups.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const first = join(backups, "before-upgrade");
  assert.ok(existsSync(join(first, ".raya", "USER.md")));
  assert.ok(existsSync(join(first, ".raya", ".env")));
  assert.ok(existsSync(join(first, "package.json")));
  assert.ok(existsSync(join(first, "manifest.json")));
  assert.ok(existsSync(join(first, "raya-package.tgz")));
  for (const forbidden of [".git", "snapshots", "snapshot", "backups", "raya-source", "raya-home"]) {
    assert.equal(existsSync(join(first, forbidden)), false, `${forbidden} must not exist inside a local backup`);
  }

  execFileSync(process.execPath, [...entrypoint, "backup", "--name", "after-upgrade"], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000
  });
  assert.deepEqual(readdirSync(backups).sort(), ["after-upgrade", "before-upgrade"]);

  const listed = execFileSync(process.execPath, [...entrypoint, "backup", "--list"], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.match(listed, /GitHub backups\n\(none\)/);
  assert.match(listed, /Local backups/);
  assert.match(listed, /Backup name\s+Raya version\s+Created/);
    assert.match(listed, /before-upgrade\s+v0\.1\.5/);
    assert.match(listed, /after-upgrade\s+v0\.1\.5/);
  assert.match(listed, /Restore: raya backup --restore 'before-upgrade'/);
  assert.doesNotMatch(listed, /--from/);

  writeFileSync(join(home, "changed-after-backup.txt"), "remove during restore\n");
  const cancelled = execFileSync(process.execPath, [...entrypoint, "backup", "--restore", "before-upgrade"], {
    cwd: process.cwd(), env, input: "2\nNO\n", encoding: "utf8"
  });
  assert.match(cancelled, /Restore from:/);
  assert.match(cancelled, /Type RESTORE to continue:/);
  assert.ok(existsSync(join(home, "changed-after-backup.txt")));

  const restoreScript = [
    "import { restoreBackup } from './src/backup/store.ts';",
    `const config = ${JSON.stringify(config.backup)};`,
    "const runner = async () => ({ code: 0, stdout: '', stderr: '' });",
    "await restoreBackup(config, 'before-upgrade', runner);"
  ].join(" ");
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", restoreScript], {
    cwd: process.cwd(), env, encoding: "utf8"
  });
  assert.equal(existsSync(join(home, "changed-after-backup.txt")), false);
  assert.equal(readFileSync(join(home, "USER.md"), "utf8"), "remember me\n");
});

test("every update checkpoint is local, complete, unique, and leaves RAYA_HOME untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-update-checkpoint-test-"));
  const home = join(root, ".raya");
  const backups = join(root, "raya-backups");
  mkdirSync(join(home, "profiles", "custom"), { recursive: true });
  writeFileSync(join(home, "config.json"), "{ user formatting stays untouched }\n");
  writeFileSync(join(home, ".env"), "RAYA_SECRET=checkpointed\n");
  writeFileSync(join(home, "profiles", "custom", "SOUL.md"), "custom profile soul\n");

  const script = [
    "import { createUpdateCheckpoint } from './src/backup/store.ts';",
    "const first = await createUpdateCheckpoint('0.1.3', '0.1.4', undefined, new Date('2026-07-23T10:11:12.000Z'));",
    "const second = await createUpdateCheckpoint('0.1.3', '0.1.4', undefined, new Date('2026-07-23T10:11:12.000Z'));",
    "console.log(JSON.stringify({ first, second }));"
  ].join(" ");
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: backups },
    encoding: "utf8",
    timeout: 60_000
  });
  const result = JSON.parse(output) as {
    first: { reference: string; directory: string; kind: string; targetVersion: string };
    second: { reference: string; directory: string; kind: string; targetVersion: string };
  };

  assert.notEqual(result.first.reference, result.second.reference);
  assert.equal(result.first.kind, "update-checkpoint");
  assert.equal(result.first.targetVersion, "0.1.4");
  assert.ok(existsSync(join(result.first.directory, "raya-package.tgz")));
  assert.equal(readFileSync(join(result.first.directory, ".raya", ".env"), "utf8"), "RAYA_SECRET=checkpointed\n");
  assert.equal(readFileSync(join(result.first.directory, ".raya", "profiles", "custom", "SOUL.md"), "utf8"), "custom profile soul\n");
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{ user formatting stays untouched }\n");
  assert.equal(readFileSync(join(home, ".env"), "utf8"), "RAYA_SECRET=checkpointed\n");
  assert.equal(readFileSync(join(home, "profiles", "custom", "SOUL.md"), "utf8"), "custom profile soul\n");
});

test("update checkpoint refuses a backup root inside RAYA_HOME before writing there", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-unsafe-checkpoint-root-"));
  const home = join(root, ".raya");
  const unsafeBackups = join(home, "checkpoints");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "custom.txt"), "untouched\n");
  const script = [
    "import { createUpdateCheckpoint } from './src/backup/store.ts';",
    "try { await createUpdateCheckpoint('0.1.3', '0.1.4'); }",
    "catch (error) { console.log(error.message); }"
  ].join(" ");
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: unsafeBackups },
    encoding: "utf8"
  });
  assert.match(output, /must be outside RAYA_HOME/);
  assert.equal(existsSync(unsafeBackups), false);
  assert.equal(readFileSync(join(home, "custom.txt"), "utf8"), "untouched\n");
});

test("GitHub backups use only temporary clones and list directly from the remote", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-github-backup-test-"));
  const home = join(root, ".raya");
  const backupRoot = join(root, "raya-backups");
  const remote = join(root, "remote.git");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "USER.md"), "personal memory\n");
  writeFileSync(join(home, ".env"), "RAYA_SECRET=hidden\n");
  writeFileSync(join(home, "auth.json"), "{\"token\":\"hidden\"}\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    mcpServers: {
      remote: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer literal-secret", Safe: "${SAFE_MCP_HEADER}" }
      },
      local: {
        transport: "stdio",
        command: "node",
        env: { API_KEY: "literal-key", SAFE: "${SAFE_MCP_ENV}" }
      }
    }
  }));
  execFileSync("git", ["init", "--bare", remote]);

  const config = { mode: "github", name: "remote", repository: remote, configuredAt: new Date().toISOString() };
  const script = [
    "import { createBackup, listBackups } from './src/backup/store.ts';",
    `const config = ${JSON.stringify(config)};`,
    "await createBackup(config, 'remote-version', '0.1.2');",
    "console.log(JSON.stringify(await listBackups(config)));"
  ].join(" ");
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: backupRoot }, encoding: "utf8", timeout: 60_000
  });
  assert.match(output, /remote-version/);
  assert.equal(existsSync(backupRoot), false, "GitHub mode must not create a persistent local backup directory");

  const inspection = join(root, "inspection");
  execFileSync("git", ["clone", remote, inspection]);
  assert.ok(existsSync(join(inspection, ".raya-backup", "raya-home", "USER.md")));
  assert.equal(existsSync(join(inspection, ".raya-backup", "raya-home", ".env")), false);
  assert.equal(existsSync(join(inspection, ".raya-backup", "raya-home", "auth.json")), false);
  const remoteConfig = JSON.parse(readFileSync(join(inspection, ".raya-backup", "raya-home", "config.json"), "utf8"));
  assert.deepEqual(remoteConfig.mcpServers.remote.headers, { Safe: "${SAFE_MCP_HEADER}" });
  assert.deepEqual(remoteConfig.mcpServers.local.env, { SAFE: "${SAFE_MCP_ENV}" });
  assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: inspection, encoding: "utf8" }), /Raya backup: remote-version/);

  writeFileSync(join(home, "config.json"), `${JSON.stringify({ backup: config })}\n`);
  const grouped = execFileSync(process.execPath, [...entrypoint, "backup", "--list"], {
    cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: backupRoot, NO_COLOR: "1" }, encoding: "utf8"
  });
  assert.match(grouped, /GitHub backups[\s\S]*remote-version\s+v0\.1\.2/);
  assert.match(grouped, /Local backups\n\(none\)/);
});

test("legacy local restore remains compatible with the previous snapshots layout", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-restore-test-"));
  const home = join(root, ".raya");
  const directory = join(root, "raya-backups");
  const reference = "saved-version";
  const snapshot = join(directory, "old-layout", "snapshots", reference);
  mkdirSync(join(snapshot, "raya-home"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "old.txt"), "remove me\n");
  writeFileSync(join(snapshot, "raya-home", "restored.txt"), "restored\n");
  writeFileSync(join(snapshot, "raya-package.tgz"), "test archive\n");
  writeFileSync(join(snapshot, "manifest.json"), JSON.stringify({
    id: reference, name: "Saved version", createdAt: new Date().toISOString(),
    rayaVersion: "0.1.1", mode: "local", secretsIncluded: true
  }));

  const config = JSON.stringify({ mode: "local", name: "local", directory, configuredAt: new Date().toISOString() });
  const script = [
    "import { restoreBackup } from './src/backup/store.ts';",
    `const config = ${config};`,
    "const calls = []; const runner = async (command, args) => { calls.push([command, args]); return { code: 0, stdout: '', stderr: '' }; };",
    `await restoreBackup(config, '${reference}', runner);`,
    "console.log(JSON.stringify(calls));"
  ].join(" ");
  const restoreOutput = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: directory }, encoding: "utf8"
  });
  assert.equal(existsSync(join(home, "old.txt")), false);
  assert.equal(readFileSync(join(home, "restored.txt"), "utf8"), "restored\n");
  assert.match(restoreOutput, /--ignore-scripts/);
});

test("uninstall removes isolated state and backups without needing valid config", () => {
  const root = mkdtempSync(join(tmpdir(), "raya-uninstall-test-"));
  const home = join(root, ".raya");
  const backups = join(root, "raya-backups");
  mkdirSync(home, { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(home, "config.json"), "not json\n");
  writeFileSync(join(backups, "saved.txt"), "backup\n");

  const script = [
    "import { uninstallRaya } from './src/cli/uninstall.ts';",
    "await uninstallRaya({ skipPackage: true });"
  ].join(" ");
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home, RAYA_BACKUP_ROOT: backups }, encoding: "utf8"
  });
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(backups), false);
});
