import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { RAYA_ENV_PATH, ensureRayaHome } from "./paths.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";

const SECRET_LOCK_PATH = `${RAYA_ENV_PATH}.lock`;
const STALE_LOCK_MS = 5 * 60_000;

function readEnv(): Record<string, string> {
  ensureRayaHome();
  if (!existsSync(RAYA_ENV_PATH)) return {};
  return Object.fromEntries(readFileSync(RAYA_ENV_PATH, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => [match[1]!, match[2]! ]));
}

function writeEnv(values: Record<string, string>): void {
  ensureRayaHome();
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  writePrivateFileAtomic(RAYA_ENV_PATH, `${body}\n`);
}

function withSecretLock<T>(operation: () => T): T {
  ensureRayaHome();
  const deadline = Date.now() + 10_000;
  const owner = `${process.pid}:${randomUUID()}`;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(SECRET_LOCK_PATH, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(SECRET_LOCK_PATH).mtimeMs > STALE_LOCK_MS) unlinkSync(SECRET_LOCK_PATH);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Raya credential file lock.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  writeFileSync(descriptor, owner, "utf8");
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      if (readFileSync(SECRET_LOCK_PATH, "utf8") === owner) unlinkSync(SECRET_LOCK_PATH);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function withSecretLockAsync<T>(operation: () => Promise<T>): Promise<T> {
  ensureRayaHome();
  const deadline = Date.now() + 30_000;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(SECRET_LOCK_PATH, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(SECRET_LOCK_PATH)).mtimeMs > STALE_LOCK_MS) await unlink(SECRET_LOCK_PATH);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Raya credential file lock.");
      await delay(25);
    }
  }
  await handle.writeFile(owner, "utf8");
  try {
    return await operation();
  } finally {
    await handle.close();
    try {
      if (readFileSync(SECRET_LOCK_PATH, "utf8") === owner) await unlink(SECRET_LOCK_PATH);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function readSecret(name: string): string | undefined {
  return readEnv()[name];
}

export function writeSecret(name: string, value: string | undefined): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid Raya secret name: ${name}`);
  if (value && /[\r\n]/.test(value)) throw new Error(`Raya secret ${name} cannot contain a newline.`);
  withSecretLock(() => {
    const values = readEnv();
    if (value) values[name] = value;
    else delete values[name];
    writeEnv(values);
  });
}

export async function modifySecret(
  name: string,
  update: (current: string | undefined) => Promise<string | undefined> | string | undefined
): Promise<string | undefined> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid Raya secret name: ${name}`);
  return withSecretLockAsync(async () => {
    const values = readEnv();
    const next = await update(values[name]);
    if (next && /[\r\n]/.test(next)) throw new Error(`Raya secret ${name} cannot contain a newline.`);
    if (next) values[name] = next;
    else delete values[name];
    writeEnv(values);
    return next;
  });
}
