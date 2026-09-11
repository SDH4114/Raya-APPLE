import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { splitTelegramMessage, startTelegramService } from "../src/telegram/service.js";
import { createListFilesTool, createReadFileTool } from "../src/tools/files.js";
import { assertNotBlocked, commandMatchesAutoApprovePrefix, createShellTool, requiresShellApproval } from "../src/tools/shell.js";
import { createWebTool, isPrivateIpAddress } from "../src/tools/web.js";
import { normalizePiPackageName } from "../src/plugins/package.js";
import { normalizeConfig } from "../src/config/config.js";
import { createRayaTools } from "../src/agent/create-agent.js";

test("old session configs are fully normalized before use", () => {
  const home = mkdtempSync(join(tmpdir(), "raya-session-config-"));
  try {
    writeFileSync(join(home, "sessions.json"), JSON.stringify({
      sessions: [{ id: "old", name: "Old", createdAt: 1, updatedAt: 1, config: { provider: "openai-codex", model: "gpt-5.4", mode: "edit", neovim_mode: true, vim_mode: true }, messages: [] }]
    }));
    const script = [
      'import { listSessions } from "./src/session/store.ts";',
      'const config = listSessions()[0].config;',
      'console.log(JSON.stringify({ mode: config.mode, design: config.headerStyle, blocked: config.blockedCommands, hasNeovim: "neovim_mode" in config, hasVim: "vim_mode" in config }));'
    ].join("");
    const output = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAYA_HOME: home },
      encoding: "utf8"
    });
    assert.deepEqual(JSON.parse(output), { mode: "build", design: "small", blocked: ["rm"], hasNeovim: false, hasVim: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspace file tools reject symlink escapes and do not traverse symlinked directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "raya-files-root-"));
  const outside = mkdtempSync(join(tmpdir(), "raya-files-outside-"));
  const original = process.cwd();
  try {
    writeFileSync(join(outside, "secret.txt"), "outside");
    mkdirSync(join(outside, "folder"));
    writeFileSync(join(outside, "folder", "nested.txt"), "outside nested");
    writeFileSync(join(root, "large.txt"), "x".repeat(200_000));
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
    symlinkSync(join(outside, "folder"), join(root, "folder-link"));
    process.chdir(root);

    const read = createReadFileTool();
    await assert.rejects(() => read.execute("test", { path: "secret-link" }), /symbolic link/);

    const list = createListFilesTool();
    const result = await list.execute("test", { path: "." });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /folder-link -> \[symbolic link\]/);
    assert.doesNotMatch(text, /nested\.txt/);

    const bounded = await read.execute("test", { path: "large.txt" });
    const boundedText = bounded.content[0]?.type === "text" ? bounded.content[0].text : "";
    assert.match(boundedText, /\[truncated \d+ bytes\]$/);
    assert.ok(boundedText.length < 140_000);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Telegram messages are split instead of silently truncated", () => {
  const text = `${"a".repeat(3_500)}\n${"b".repeat(3_500)}`;
  const chunks = splitTelegramMessage(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
  assert.equal(chunks.join("\n"), text);
});

test("Telegram refuses to start without an explicit allowed chat", () => {
  assert.throws(() => startTelegramService({
    token: "test-token",
    onPrompt: async () => "unused"
  }), /allowed chat ID is required/);
});

test("standard security asks before any shell command that is not clearly read-only", () => {
  assert.equal(requiresShellApproval("git status"), false);
  assert.equal(requiresShellApproval("rg TODO src"), false);
  assert.equal(requiresShellApproval("echo changed > file.txt"), true);
  assert.equal(requiresShellApproval("node -e process.exit(0)"), true);
  assert.equal(requiresShellApproval("git restore file.txt"), true);
  assert.equal(requiresShellApproval("git branch feature"), true);
  assert.equal(requiresShellApproval("git branch --list"), false);
  assert.equal(requiresShellApproval("git remote add origin https://example.com/repo"), true);
  assert.equal(requiresShellApproval("git remote -v"), false);
  assert.equal(requiresShellApproval("git log --output=history.txt"), true);
});

test("blocked shell commands cannot hide behind shell chains or common wrappers", () => {
  assert.throws(() => assertNotBlocked("cd src && rm -rf generated", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("sudo rm file.txt", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("sudo -u root /bin/rm file.txt", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("/bin/rm file.txt", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("find . -exec rm {} +", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("printf '%s\\n' files | xargs rm", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("env -- /bin/rm file.txt", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("bash -lc 'rm -rf generated'", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("cmd.exe /c \"r^m file.txt\"", ["rm"]), /blocked/);
  assert.throws(() => assertNotBlocked("powershell -EncodedCommand YQBiAGMA", ["rm"]), /blocked/);
  assert.doesNotThrow(() => assertNotBlocked("rg rm src", ["rm"]));
});

test("auto approval only matches a simple command prefix", () => {
  assert.equal(commandMatchesAutoApprovePrefix("npm test", "npm test"), true);
  assert.equal(commandMatchesAutoApprovePrefix("npm test -- --watch=false", "npm test"), true);
  assert.equal(commandMatchesAutoApprovePrefix("npm test-malicious", "npm test"), false);
  assert.equal(commandMatchesAutoApprovePrefix("npm test ; rm file", "npm test"), false);
});

test("web fetch protection recognizes local and private network addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.16.1.2", "192.168.1.2", "169.254.169.254", "::1", "fd00::1"]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
  assert.equal(isPrivateIpAddress("1.1.1.1"), false);
  assert.equal(isPrivateIpAddress("2606:4700:4700::1111"), false);
});

test("web tool refuses local URLs before making a request", async () => {
  const tool = createWebTool(normalizeConfig({}));
  await assert.rejects(() => tool.execute("test", { url: "http://127.0.0.1:8080/private" }), /local or private/);
});

test("shell output is bounded while the child process is still drained", async () => {
  const tool = createShellTool(normalizeConfig({ mode: "build", blockedCommands: [] }), { allowWithoutApproval: true });
  const result = await tool.execute("test", { command: `${process.execPath} -e "process.stdout.write('x'.repeat(50000))"` });
  assert.match(result.details.stdout, /\[truncated 30000 chars\]$/);
  assert.ok(result.details.stdout.length < 21_000);
});

test("mutating shell commands fail closed when an approval handler is unavailable", async () => {
  const tool = createShellTool(normalizeConfig({ mode: "build", blockedCommands: [] }));
  await assert.rejects(() => tool.execute("test", { command: "node -e \"process.exit(0)\"" }), /no approval handler/);
});

test("plugin install only accepts plain npm package names", () => {
  assert.equal(normalizePiPackageName("npm:pi-subagents"), "pi-subagents");
  assert.equal(normalizePiPackageName("npm:@scope/pi-tools"), "@scope/pi-tools");
  assert.throws(() => normalizePiPackageName("--global"), /plain npm package name/);
  assert.throws(() => normalizePiPackageName("../../outside"), /plain npm package name/);
  assert.throws(() => normalizePiPackageName("https://example.com/plugin.tgz"), /plain npm package name/);
});

test("credential updates for different providers do not overwrite each other", () => {
  const home = mkdtempSync(join(tmpdir(), "raya-credential-lock-"));
  try {
    const script = [
      'import { FileCredentialStore } from "./src/providers/file-credential-store.ts";',
      'const store = new FileCredentialStore();',
      'await Promise.all([',
      'store.modify("one", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { type: "api_key", key: "one" }; }),',
      'store.modify("two", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { type: "api_key", key: "two" }; })',
      ']);',
      'console.log(JSON.stringify({ one: await store.read("one"), two: await store.read("two") }));'
    ].join("");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAYA_HOME: home },
      encoding: "utf8"
    });
    assert.deepEqual(JSON.parse(output), {
      one: { type: "api_key", key: "one" },
      two: { type: "api_key", key: "two" }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential updates are serialized across separate Raya processes", () => {
  const home = mkdtempSync(join(tmpdir(), "raya-credential-process-lock-"));
  try {
    const script = [
      'import { spawn } from "node:child_process";',
      'import { FileCredentialStore } from "./src/providers/file-credential-store.ts";',
      'const childCode=`import { FileCredentialStore } from "./src/providers/file-credential-store.ts"; const store=new FileCredentialStore(); await store.modify(process.argv[1], async()=>{await new Promise(r=>setTimeout(r,Number(process.argv[2]))); return {type:"api_key",key:process.argv[1]};});`;',
      'const run=(name,delay)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",childCode,name,String(delay)],{cwd:process.cwd(),env:process.env,stdio:"inherit"});child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(`child ${code}`)));});',
      'await Promise.all([run("one",80),run("two",10)]);',
      'const store=new FileCredentialStore(); console.log(JSON.stringify({one:await store.read("one"),two:await store.read("two")}));'
    ].join("");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home }, encoding: "utf8"
    });
    const values = JSON.parse(output) as { one?: { key?: string }; two?: { key?: string } };
    assert.equal(values.one?.key, "one");
    assert.equal(values.two?.key, "two");
    assert.equal(existsSync(join(home, ".env.lock")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deleting one legacy credential migrates and preserves the others", () => {
  const home = mkdtempSync(join(tmpdir(), "raya-credential-migration-"));
  try {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      one: { type: "api_key", key: "one" },
      two: { type: "api_key", key: "two" }
    }));
    const script = [
      'import { FileCredentialStore } from "./src/providers/file-credential-store.ts";',
      'const store=new FileCredentialStore(); await store.delete("one");',
      'console.log(JSON.stringify({one:await store.read("one"),two:await store.read("two")}));'
    ].join("");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, RAYA_HOME: home }, encoding: "utf8"
    });
    const values = JSON.parse(output) as { one?: unknown; two?: { key?: string } };
    assert.equal(values.one, undefined);
    assert.equal(values.two?.key, "two");
    assert.equal(existsSync(join(home, "auth.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rebuilding tools after a mode or security change keeps subagent available", () => {
  const config = normalizeConfig({ mode: "build" });
  const tools = createRayaTools({ config, model: {} as never, models: {} as never });
  assert.ok(tools.some((tool) => tool.name === "subagent"));
  assert.ok(tools.some((tool) => tool.name === "write_file"));
});
