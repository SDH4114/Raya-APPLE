import { Type } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import type { RayaConfig } from "../config/config.js";
import { defaultShell } from "../platform.js";
import { requireToolApproval, type RayaTool, type ToolExecutionPolicy } from "../types/tool.js";

const ShellParameters = Type.Object({
  command: Type.String({
    description: "Shell command to run in the current workspace."
  })
});

type ShellDetails = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

const MAX_OUTPUT_CHARS = 20_000;
const SHELL_CONTROL = /[|;&><`]|\$\(|\n/;

function appendBounded(current: string, chunk: Buffer, omitted: number): { value: string; omitted: number } {
  const text = chunk.toString("utf8");
  const room = Math.max(MAX_OUTPUT_CHARS - current.length, 0);
  return {
    value: room ? current + text.slice(0, room) : current,
    omitted: omitted + Math.max(text.length - room, 0)
  };
}

function finishBounded(value: string, omitted: number): string {
  return omitted ? `${value}\n\n[truncated ${omitted} chars]` : value;
}

function assertPlanSafe(command: string): void {
  if (SHELL_CONTROL.test(command)) {
    throw new Error("Plan mode only permits simple read-only shell commands.");
  }
  const [program, ...args] = command.trim().split(/\s+/);
  const allowed = new Set(["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "stat", "du", "git", "cd", "dir", "where", "type"]);
  if (!program || !allowed.has(program)) throw new Error("Plan mode only permits read-only inspection commands.");
  if (program === "find" && args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg))) {
    throw new Error("Plan mode does not permit mutating find actions.");
  }
  if (program === "git") {
    const [subcommand, ...gitArgs] = args;
    if (!["status", "diff", "log", "show", "branch", "remote"].includes(subcommand ?? "")) {
      throw new Error("Plan mode only permits read-only git commands.");
    }
    if (gitArgs.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="))) {
      throw new Error("Plan mode does not permit git output files.");
    }
    if (subcommand === "branch" && gitArgs.some((arg) => !arg.startsWith("-") || ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"].includes(arg))) {
      throw new Error("Plan mode only permits listing git branches.");
    }
    if (subcommand === "remote") {
      const readOnly = gitArgs.length === 0
        || (gitArgs.length === 1 && ["-v", "--verbose"].includes(gitArgs[0]!))
        || (gitArgs[0] === "show" && gitArgs.slice(1).every((arg) => !arg.startsWith("-") || arg === "-n"))
        || (gitArgs[0] === "get-url" && gitArgs.slice(1).every((arg) => !arg.startsWith("-") || ["--all", "--push"].includes(arg)));
      if (!readOnly) throw new Error("Plan mode only permits inspecting git remotes.");
    }
  }
}

export function requiresShellApproval(command: string): boolean {
  try {
    assertPlanSafe(command);
    return false;
  } catch {
    return true;
  }
}

function assertAllowedInMode(command: string, mode: RayaConfig["mode"]): void {
  if (mode !== "plan") {
    return;
  }
  assertPlanSafe(command);
}

function shellSegments(command: string): string[] {
  return command
    .replaceAll("`", ";")
    .split(/(?:&&|\|\||[;&|()\n])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripExecutionPrefixes(segment: string): string {
  let value = segment.trim();
  value = value.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
  value = value.replace(/^(?:(?:sudo|command)(?:\s+-\S+)*|builtin|nohup)\s+/, "");
  if (value.startsWith("env ")) {
    value = value.slice(4).replace(/^(?:(?:--|-[A-Za-z]+|[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*/, "");
  }
  return value;
}

function matchesLiteralPrefix(command: string, prefix: string): boolean {
  const raw = command.trim();
  const candidate = prefix.trim();
  return Boolean(candidate) && (raw === candidate || raw.startsWith(`${candidate} `));
}

function normalizeExecutable(value: string): string {
  const unquoted = value.trim().replace(/^(['"])(.*)\1$/, "$2").replaceAll("^", "");
  return unquoted.split(/[\\/]/).at(-1) ?? unquoted;
}

function matchesBlockedPrefix(command: string, prefix: string): boolean {
  const raw = command.trim();
  const [program = "", ...args] = raw.split(/\s+/);
  const normalized = [normalizeExecutable(program), ...args].join(" ");
  return matchesLiteralPrefix(raw, prefix) || matchesLiteralPrefix(normalized, prefix);
}

export function commandMatchesAutoApprovePrefix(command: string, prefix: string): boolean {
  return !SHELL_CONTROL.test(command) && matchesLiteralPrefix(command, prefix);
}

export function assertNotBlocked(command: string, blockedCommands: string[]): void {
  const inspect = (candidate: string, depth = 0): string | undefined => {
    if (depth > 4) return blockedCommands[0];
    const segments = shellSegments(candidate);
    return blockedCommands.find((entry) => segments.some((segment) => {
      const rawTokens = segment.trim().split(/\s+/);
      const leadingWrapper = normalizeExecutable(rawTokens[0] ?? "").toLowerCase();
      if (["sudo", "env", "command", "builtin", "nohup"].includes(leadingWrapper)
        && rawTokens.slice(1).some((token) => matchesBlockedPrefix(token, entry))) return true;
      const executable = stripExecutionPrefixes(segment);
      if (matchesBlockedPrefix(executable, entry)) return true;
      const execTarget = executable.match(/(?:^|\s)-(?:exec|execdir|ok|okdir)\s+([^\s]+)/)?.[1];
      const xargsTarget = executable.match(/(?:^|\s)xargs(?:\s+-\S+)*\s+([^\s]+)/)?.[1];
      if (matchesBlockedPrefix(execTarget ?? "", entry) || matchesBlockedPrefix(xargsTarget ?? "", entry)) return true;

      const [program = ""] = executable.split(/\s+/, 1);
      const wrapper = normalizeExecutable(program).toLowerCase();
      const rest = executable.slice(program.length).trim();
      if (["bash", "sh", "zsh", "dash", "ksh"].includes(wrapper)) {
        const nested = rest.match(/(?:^|\s)-(?:[a-z]*c[a-z]*)\s+([\s\S]+)$/i)?.[1];
        if (nested && inspect(nested.replace(/^(['"])([\s\S]*)\1$/, "$2"), depth + 1)) return true;
      }
      if (wrapper === "cmd" || wrapper === "cmd.exe") {
        const nested = rest.match(/(?:^|\s)\/c\s+([\s\S]+)$/i)?.[1];
        if (nested && inspect(nested.replace(/^(['"])([\s\S]*)\1$/, "$2"), depth + 1)) return true;
      }
      if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(wrapper)) {
        if (/^-(?:encodedcommand|enc)\b/i.test(rest)) return true;
        const nested = rest.match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i)?.[1];
        if (nested && inspect(nested.replace(/^(['"])([\s\S]*)\1$/, "$2"), depth + 1)) return true;
      }
      return false;
    }));
  };
  const blocked = inspect(command);
  if (blocked) throw new Error(`This command is blocked by Raya configuration: ${blocked}`);
}

export function createShellTool(config: RayaConfig, policy: ToolExecutionPolicy = {}, workspace = process.cwd()): RayaTool<typeof ShellParameters, ShellDetails> {
  return {
    name: "shell",
    label: "Shell",
    description:
      "Run a shell command in the current working directory. Use this for build, test, git, and inspection commands.",
    parameters: ShellParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      assertNotBlocked(params.command, config.blockedCommands);
      assertAllowedInMode(params.command, config.mode);
      if (requiresShellApproval(params.command)) {
        await requireToolApproval(policy, "run shell command", params.command);
      }
      const result = await new Promise<ShellDetails>((resolve, reject) => {
        const child = spawn(params.command, {
          cwd: workspace,
          shell: defaultShell(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true
        });

        let stdout = "";
        let stderr = "";
        let stdoutOmitted = 0;
        let stderrOmitted = 0;
        let timedOut = false;
        let aborted = false;
        let terminating = false;
        let forceKill: NodeJS.Timeout | undefined;

        const terminate = (): void => {
          if (terminating) return;
          terminating = true;
          if (process.platform === "win32") {
            if (child.pid) {
              const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
              killer.once("error", () => child.kill());
              killer.once("close", (code) => { if (code !== 0) child.kill(); });
            } else {
              child.kill();
            }
            return;
          }
          const kill = (signal: NodeJS.Signals): void => {
            if (!child.pid) return;
            try { process.kill(-child.pid, signal); }
            catch { child.kill(signal); }
          };
          kill("SIGTERM");
          forceKill = setTimeout(() => kill("SIGKILL"), 2_000);
          forceKill.unref();
        };

        const timeout = setTimeout(() => {
          timedOut = true;
          terminate();
        }, config.shellTimeoutMs);

        const abort = () => {
          aborted = true;
          terminate();
        };

        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });

        child.stdout.on("data", (chunk: Buffer) => {
          const next = appendBounded(stdout, chunk, stdoutOmitted);
          stdout = next.value;
          stdoutOmitted = next.omitted;
        });

        child.stderr.on("data", (chunk: Buffer) => {
          const next = appendBounded(stderr, chunk, stderrOmitted);
          stderr = next.value;
          stderrOmitted = next.omitted;
        });

        child.once("error", (error) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          signal?.removeEventListener("abort", abort);
          reject(error);
        });

        child.on("close", (exitCode) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          signal?.removeEventListener("abort", abort);
          resolve({
            command: params.command,
            exitCode,
            stdout: finishBounded(stdout, stdoutOmitted),
            stderr: finishBounded(stderr, stderrOmitted),
            timedOut,
            aborted
          });
        });
      });

      const content = [
        `command: ${result.command}`,
        `exit_code: ${result.exitCode}`,
        result.timedOut ? "timed_out: true" : undefined,
        result.aborted ? "aborted: true" : undefined,
        result.stdout ? `stdout:\n${result.stdout}` : undefined,
        result.stderr ? `stderr:\n${result.stderr}` : undefined
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [{ type: "text", text: content }],
        details: result
      };
    }
  };
}
