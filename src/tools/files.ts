import { Type } from "@earendil-works/pi-ai";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { requireToolApproval, type RayaTool, type ToolExecutionPolicy } from "../types/tool.js";
import { createFileDiff } from "./file-diff.js";

const ReadFileParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path to read." })
});

const WriteFileParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path to write." }),
  content: Type.String({ description: "Full new file content." })
});

const ListFilesParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Workspace-relative directory path. Defaults to current directory." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum number of entries. Defaults to 200." }))
});

const MAX_READ_BYTES = 128 * 1024;

function readTextBounded(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return size > bytesRead ? `${text}\n\n[truncated ${size - bytesRead} bytes]` : text;
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function workspacePath(root: string, path: string, allowMissing = false): string {
  const lexicalRoot = resolve(root);
  const realRoot = realpathSync(lexicalRoot);
  const resolved = resolve(lexicalRoot, path);
  if (!isInside(lexicalRoot, resolved)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }

  let existing = resolved;
  while (!existsSync(existing)) {
    if (!allowMissing) throw new Error(`Path does not exist: ${path}`);
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Path escapes workspace: ${path}`);
    existing = parent;
  }
  if (!isInside(realRoot, realpathSync(existing))) {
    throw new Error(`Path escapes workspace through a symbolic link: ${path}`);
  }
  return resolved;
}

function displayPath(root: string, path: string): string {
  return relative(root, path) || ".";
}

export function createReadFileTool(workspace = process.cwd()): RayaTool<typeof ReadFileParameters, { path: string }> {
  return {
    name: "read_file",
    label: "Read file",
    description: "Read a text file from the current workspace.",
    parameters: ReadFileParameters,
    async execute(_toolCallId, params) {
      const path = workspacePath(workspace, params.path);
      const text = readTextBounded(path);
      return {
        content: [{ type: "text", text: `path: ${displayPath(workspace, path)}\n\n${text}` }],
        details: { path: displayPath(workspace, path) }
      };
    }
  };
}

export function createWriteFileTool(policy: ToolExecutionPolicy = {}, workspace = process.cwd()): RayaTool<typeof WriteFileParameters, { path: string; bytes: number; additions: number; deletions: number; diff: string; created: boolean }> {
  return {
    name: "write_file",
    label: "Write file",
    description: "Create or overwrite a text file in the current workspace. Available only in Build mode.",
    parameters: WriteFileParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await requireToolApproval(policy, "write file", params.path);
      const path = workspacePath(workspace, params.path, true);
      const existed = existsSync(path);
      const before = existed ? readFileSync(path, "utf8") : undefined;
      const diff = createFileDiff(before, params.content, displayPath(workspace, path));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, params.content, "utf8");
      return {
        content: [{ type: "text", text: `wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${displayPath(workspace, path)} (+${diff.additions} -${diff.deletions})\n\n${diff.text}` }],
        details: {
          path: displayPath(workspace, path),
          bytes: Buffer.byteLength(params.content, "utf8"),
          additions: diff.additions,
          deletions: diff.deletions,
          diff: diff.text,
          created: !existed
        }
      };
    }
  };
}

export function createListFilesTool(workspace = process.cwd()): RayaTool<typeof ListFilesParameters, { entries: string[] }> {
  return {
    name: "list_files",
    label: "List files",
    description: "List files and directories in the current workspace.",
    parameters: ListFilesParameters,
    async execute(_toolCallId, params) {
      const start = workspacePath(workspace, params.path ?? ".");
      const maxEntries = Math.max(1, Math.min(Math.floor(params.maxEntries ?? 200), 1000));

      const entries: string[] = [];
      const visit = (path: string): void => {
        if (entries.length >= maxEntries) {
          return;
        }
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          entries.push(`${displayPath(workspace, path)} -> [symbolic link]`);
          return;
        }
        if (stat.isDirectory()) {
          for (const entry of readdirSync(path)) {
            if (entry === "node_modules" || entry === ".git" || entry === "dist") {
              continue;
            }
            visit(resolve(path, entry));
          }
          return;
        }
        entries.push(displayPath(workspace, path));
      };

      visit(start);
      return {
        content: [{ type: "text", text: entries.join("\n") || "(empty)" }],
        details: { entries }
      };
    }
  };
}
