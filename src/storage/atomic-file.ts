import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

function hardenWindowsAcl(path: string): void {
  if (process.platform !== "win32") return;
  const username = process.env.USERNAME;
  if (!username) throw new Error(`Cannot secure private file without USERNAME: ${path}`);
  const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  const result = spawnSync("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${principal}:(F)`
  ], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `icacls exited ${result.status}`;
    throw new Error(`Could not apply an owner-only Windows ACL to ${path}: ${detail}`);
  }
}

export function writePrivateFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    hardenWindowsAcl(temporary);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
