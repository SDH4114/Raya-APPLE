import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { modifySecret, readSecret } from "../config/secrets.js";
import { RAYA_AUTH_PATH } from "../config/paths.js";

type AuthFile = Record<string, Credential>;
let credentialQueue: Promise<unknown> = Promise.resolve();

function decodeAuth(encoded: string): AuthFile {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AuthFile;
}

async function readAuthFile(): Promise<AuthFile> {
  const encoded = readSecret("RAYA_CREDENTIALS");
  if (encoded) {
    const auth = decodeAuth(encoded);
    // A completed migration must not leave the old plaintext credential copy
    // behind indefinitely.
    if (existsSync(RAYA_AUTH_PATH)) unlinkSync(RAYA_AUTH_PATH);
    return auth;
  }
  if (!existsSync(RAYA_AUTH_PATH)) return {};

  // One-time migration from the original plaintext JSON credential file.
  const legacy = JSON.parse(readFileSync(RAYA_AUTH_PATH, "utf8")) as AuthFile;
  const migrated = await modifySecret("RAYA_CREDENTIALS", (current) => current ?? encodeAuth(legacy));
  unlinkSync(RAYA_AUTH_PATH);
  return decodeAuth(migrated!);
}

function encodeAuth(auth: AuthFile): string {
  return Buffer.from(JSON.stringify(auth), "utf8").toString("base64url");
}

export class FileCredentialStore implements CredentialStore {
  // Credentials for every provider share one file, so per-provider locks can
  // overwrite each other's read-modify-write updates. Serialize the file.
  constructor() {}

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = credentialQueue.catch(() => undefined).then(operation);
    credentialQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(async () => (await readAuthFile())[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () => Object.entries(await readAuthFile()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type
    })));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      let result: Credential | undefined;
      await modifySecret("RAYA_CREDENTIALS", async (encoded) => {
        const auth = encoded
          ? decodeAuth(encoded)
          : existsSync(RAYA_AUTH_PATH)
            ? JSON.parse(readFileSync(RAYA_AUTH_PATH, "utf8")) as AuthFile
            : {};
        const updated = await fn(auth[providerId]);
        if (updated !== undefined) auth[providerId] = updated;
        result = auth[providerId];
        return encodeAuth(auth);
      });
      if (existsSync(RAYA_AUTH_PATH)) unlinkSync(RAYA_AUTH_PATH);
      return result;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(async () => {
      await modifySecret("RAYA_CREDENTIALS", (encoded) => {
        const auth = encoded
          ? decodeAuth(encoded)
          : existsSync(RAYA_AUTH_PATH)
            ? JSON.parse(readFileSync(RAYA_AUTH_PATH, "utf8")) as AuthFile
            : {};
        delete auth[providerId];
        return encodeAuth(auth);
      });
      if (existsSync(RAYA_AUTH_PATH)) unlinkSync(RAYA_AUTH_PATH);
    });
  }
}
