import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type {
  Credential,
  CredentialStore
} from "@earendil-works/pi-ai";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(value: JsonRecord): boolean {
  return (
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  );
}

function credentialFromStoredValue(value: unknown): Credential | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "oauth" && isOAuthCredential(value)) {
    return { ...value, type: "oauth" } as Credential;
  }

  if (value.type === "api_key" && (value.key === undefined || typeof value.key === "string")) {
    return { ...value, type: "api_key" } as Credential;
  }

  // Keep auth.json files written by older Luna/Pi versions readable. Those
  // files stored OAuth credentials without the new discriminant.
  if (isOAuthCredential(value)) {
    return { ...value, type: "oauth" } as Credential;
  }

  if ("key" in value && (value.key === undefined || typeof value.key === "string")) {
    return { ...value, type: "api_key" } as Credential;
  }

  return undefined;
}

async function readCredentialFile(authPath: string): Promise<JsonRecord> {
  try {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Pi credential file must contain an object: ${authPath}`);
    }
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw cause;
  }
}

async function writeCredentialFile(authPath: string, credentials: JsonRecord): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true });
  const temporaryPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, authPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export type PiCredentialStoreOptions = {
  readonly authPath: string;
};

/**
 * File-backed credentials for pi-ai's provider-owned auth system.
 *
 * The queue serializes read/modify/write operations in this process and the
 * atomic rename prevents readers from observing a partially-written file.
 */
export function createPiCredentialStore(
  options: PiCredentialStoreOptions
): CredentialStore {
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queue;
    const next = (async () => {
      await previous.catch(() => undefined);
      return await operation();
    })();
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    async read(providerId) {
      const credentials = await readCredentialFile(options.authPath);
      return credentialFromStoredValue(credentials[providerId]);
    },
    modify(providerId, fn) {
      return enqueue(async () => {
        const credentials = await readCredentialFile(options.authPath);
        const current = credentialFromStoredValue(credentials[providerId]);
        const next = await fn(current);
        if (next === undefined) {
          return current;
        }

        credentials[providerId] = next;
        await writeCredentialFile(options.authPath, credentials);
        return next;
      });
    },
    delete(providerId) {
      return enqueue(async () => {
        const credentials = await readCredentialFile(options.authPath);
        if (!(providerId in credentials)) {
          return;
        }

        delete credentials[providerId];
        await writeCredentialFile(options.authPath, credentials);
      });
    }
  };
}
