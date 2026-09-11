import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_COMMIT_URL,
  compareVersions,
  installerPath,
  installGithubReleaseWithCheckpoint,
  isUpdateApproved,
  readGithubRelease,
  readGithubVersion,
  runGithubInstaller
} from "../src/cli/update.js";

test("Raya update compares release and prerelease versions correctly", () => {
  assert.equal(compareVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
});

test("Raya update reads a valid GitHub package version", async () => {
  const commit = "a".repeat(40);
  const version = await readGithubVersion(async (url) => new Response(JSON.stringify(url === GITHUB_COMMIT_URL ? { sha: commit } : { version: "0.1.2" }), { status: 200 }));
  assert.equal(version, "0.1.2");
});

test("Raya update pins the package metadata to GitHub's current commit", async () => {
  const commit = "b".repeat(40);
  const visited: string[] = [];
  const release = await readGithubRelease(async (url) => {
    visited.push(url);
    return new Response(JSON.stringify(url === GITHUB_COMMIT_URL ? { sha: commit } : { version: "0.1.2" }), { status: 200 });
  });
  assert.deepEqual(release, { commit, version: "0.1.2" });
  assert.equal(visited[1], `https://raw.githubusercontent.com/SDH4114/Raya-APPLE/${commit}/package.json`);
});

test("Raya update only accepts an explicit confirmation", () => {
  assert.equal(isUpdateApproved("y"), true);
  assert.equal(isUpdateApproved(" yes "), true);
  assert.equal(isUpdateApproved(""), false);
  assert.equal(isUpdateApproved("no"), false);
});

test("Raya update rejects malformed GitHub package metadata", async () => {
  const commit = "c".repeat(40);
  await assert.rejects(() => readGithubVersion(async (url) => new Response(JSON.stringify(url === GITHUB_COMMIT_URL ? { sha: commit } : { version: "latest" }), { status: 200 })), /no valid version/);
});

test("Raya updater pins the installer checkout and isolates all installer state writes", async () => {
  const commit = "d".repeat(40);
  const realState = mkdtempSync(join(tmpdir(), "raya-real-update-state-"));
  const protectedFile = join(realState, "custom.txt");
  writeFileSync(protectedFile, "user-owned\n");
  let installerState = "";
  let installerStateRoot = "";

  await runGithubInstaller(
    commit,
    async () => new Response("#!/usr/bin/env bash\n# Raya installer fixture\n", { status: 200 }),
    async (_script, environment) => {
      assert.equal(environment.RAYA_UPDATE_MODE, "1");
      assert.equal(environment.RAYA_UPDATE_CHECKPOINT_CREATED, "1");
      assert.equal(environment.RAYA_REPO_REF, commit);
      assert.notEqual(environment.RAYA_HOME, realState);
      installerState = environment.RAYA_HOME!;
      installerStateRoot = join(installerState, "..");
      mkdirSync(installerState, { recursive: true });
      writeFileSync(join(installerState, "would-have-overwritten.txt"), "isolated\n");
    }
  );

  assert.equal(readFileSync(protectedFile, "utf8"), "user-owned\n");
  assert.equal(existsSync(installerState), false);
  assert.equal(existsSync(installerStateRoot), false);
});

test("Raya updater has a pinned installer path for every supported desktop platform", () => {
  assert.equal(installerPath("win32"), "install.ps1");
  assert.equal(installerPath("darwin"), "install.sh");
  assert.equal(installerPath("linux"), "install.sh");
});

test("update command startup does not initialize or rewrite RAYA_HOME", () => {
  const state = mkdtempSync(join(tmpdir(), "raya-update-help-state-"));
  const soul = join(state, "SOUL.md");
  const config = join(state, "config.json");
  writeFileSync(soul, "custom soul that must stay byte-for-byte\n");
  writeFileSync(config, "{ malformed user config\n");

  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "update", "--help"], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_HOME: state, NO_COLOR: "1" },
    encoding: "utf8"
  });

  assert.match(output, /Checkpoint Raya, preserve RAYA_HOME/);
  assert.equal(readFileSync(soul, "utf8"), "custom soul that must stay byte-for-byte\n");
  assert.equal(readFileSync(config, "utf8"), "{ malformed user config\n");
  assert.equal(existsSync(join(state, "skills")), false);
  assert.equal(existsSync(join(state, "profiles")), false);

  const missingState = join(mkdtempSync(join(tmpdir(), "raya-update-missing-state-")), ".raya");
  execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "update", "--help"], {
    cwd: process.cwd(),
    env: { ...process.env, RAYA_HOME: missingState, NO_COLOR: "1" },
    encoding: "utf8"
  });
  assert.equal(existsSync(missingState), false);
});

test("installer has explicit existing-state preservation and commit checkout paths", () => {
  const installer = readFileSync(join(process.cwd(), "install.sh"), "utf8");
  assert.match(installer, /RAYA_UPDATE_MODE/);
  assert.match(installer, /RAYA_UPDATE_CHECKPOINT_CREATED/);
  assert.match(installer, /preserve_raya_state/);
  assert.match(installer, /create_legacy_update_checkpoint/);
  assert.match(installer, /Created compatibility checkpoint/);
  assert.match(installer, /git -C "\$tmpdir\/raya" fetch --depth 1 origin "\$REPO_REF"/);
  assert.match(installer, /Preserved existing Raya state/);
});

test("installer has a legacy-client checkpoint bridge before replacement", () => {
  const installer = readFileSync(join(process.cwd(), "install.sh"), "utf8");
  assert.match(installer, /legacy_update_checkpoint=1/);
  assert.match(installer, /npm pack --ignore-scripts --pack-destination "\$checkpoint"/);
  assert.match(installer, /mv "\$checkpoint\/\$old_archive" "\$checkpoint\/raya-package\.tgz"/);
  assert.match(installer, /export RAYA_UPDATE_CHECKPOINT_CREATED=1/);
  assert.match(installer, /npm install -g --ignore-scripts "\$tmpdir\/\$package_tarball"/);
  assert.match(installer, /NVM_INSTALL_SHA256/);
});

test("checkpoint failure makes installer execution unreachable", async () => {
  let installerCalled = false;
  await assert.rejects(() => installGithubReleaseWithCheckpoint("0.1.3", {
    commit: "e".repeat(40),
    version: "0.1.4"
  }, {
    createCheckpoint: async () => { throw new Error("disk full"); },
    install: async () => { installerCalled = true; }
  }), /disk full/);
  assert.equal(installerCalled, false);
});
