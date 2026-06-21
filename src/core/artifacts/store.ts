import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteFile as defaultAtomicWriteFile
} from "./atomic-write.js";
import {
  assertJsonValue,
  isPlainObject,
  type JsonValue
} from "../json-value.js";
import { safeJoin } from "../path-security.js";
import { redactString, redactValue } from "../redactor.js";

type AtomicWriteFile = typeof defaultAtomicWriteFile;

interface ArtifactStoreDependencies {
  atomicWriteFile?: AtomicWriteFile;
}

function artifactStoreError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;

  return error;
}

function unknownToJsonValue(
  value: unknown,
  seen = new WeakSet<object>()
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return "[Function]";
    case "undefined":
      return "[Undefined]";
    case "object":
      break;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (value instanceof Error) {
    const errorRecord: Record<string, JsonValue> = {
      name: value.name,
      message: value.message
    };

    if (value.stack !== undefined) {
      errorRecord.stack = value.stack;
    }

    if (value.cause !== undefined) {
      errorRecord.cause = unknownToJsonValue(value.cause, seen);
    }

    seen.delete(value);
    return errorRecord;
  }

  if (value instanceof Date) {
    seen.delete(value);
    return Number.isNaN(value.valueOf())
      ? value.toString()
      : value.toISOString();
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item) => unknownToJsonValue(item, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized: Record<string, JsonValue> = {};

  if (!isPlainObject(value)) {
    normalized.type = Object.prototype.toString.call(value);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    normalized[key] = unknownToJsonValue(nestedValue, seen);
  }

  seen.delete(value);
  return normalized;
}

function errorToJson(errorLike: unknown): JsonValue {
  const normalized =
    errorLike instanceof Error
      ? unknownToJsonValue(errorLike)
      : { error: unknownToJsonValue(errorLike) };
  const redactedValue = redactValue(normalized);
  assertJsonValue(redactedValue);

  return redactedValue;
}

export class ArtifactStore {
  readonly artifactRoot: string;
  readonly runId: string;
  private initializedRunDirectory?: string;
  private readonly atomicWriteFile: AtomicWriteFile;

  constructor(
    artifactRoot: string,
    runId: string,
    dependencies: ArtifactStoreDependencies = {}
  ) {
    this.artifactRoot = artifactRoot;
    this.runId = runId;
    this.atomicWriteFile = dependencies.atomicWriteFile ?? defaultAtomicWriteFile;
  }

  async initializeRunDirectory(): Promise<string> {
    const runDirectory = await safeJoin(this.artifactRoot, [this.runId]);

    await mkdir(path.dirname(runDirectory), { recursive: true, mode: 0o700 });

    try {
      await mkdir(runDirectory, { recursive: false, mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw artifactStoreError(
          `Run artifact directory already exists: ${this.runId}`,
          "run_id_collision"
        );
      }

      throw cause;
    }

    await chmod(runDirectory, 0o700);
    this.initializedRunDirectory = runDirectory;

    return runDirectory;
  }

  private async runDirectory(): Promise<string> {
    if (this.initializedRunDirectory === undefined) {
      throw artifactStoreError(
        "Run artifact directory has not been initialized",
        "artifact_run_directory_uninitialized"
      );
    }

    return this.initializedRunDirectory;
  }

  private async artifactPath(name: string): Promise<string> {
    const runDirectory = await this.runDirectory();

    return await safeJoin(path.dirname(runDirectory), [
      path.basename(runDirectory),
      name
    ]);
  }

  async writeJson(name: string, value: unknown): Promise<string> {
    const artifactPath = await this.artifactPath(name);
    const content = jsonArtifactContent(value);

    await this.writeArtifact(artifactPath, content, 0o600);

    return artifactPath;
  }

  async writeJsonInDirectory(
    directory: string,
    name: string,
    value: unknown
  ): Promise<string> {
    const runDirectory = await this.runDirectory();
    const artifactDirectory = await safeJoin(path.dirname(runDirectory), [
      path.basename(runDirectory),
      directory
    ]);

    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    await chmod(artifactDirectory, 0o700);

    const artifactPath = await safeJoin(path.dirname(runDirectory), [
      path.basename(runDirectory),
      directory,
      name
    ]);
    const content = jsonArtifactContent(value);

    await this.writeArtifact(artifactPath, content, 0o600);

    return artifactPath;
  }

  async writeMarkdown(name: string, value: string): Promise<string> {
    const artifactPath = await this.artifactPath(name);

    await this.writeArtifact(artifactPath, redactString(value), 0o600);

    return artifactPath;
  }

  async touchArtifact(name: string): Promise<string> {
    const artifactPath = await this.artifactPath(name);

    await appendFile(artifactPath, "", { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async appendLine(name: string, value: unknown): Promise<string> {
    const artifactPath = await this.artifactPath(name);
    const line =
      typeof value === "string"
        ? `${redactString(value)}\n`
        : `${JSON.stringify(redactValue(value))}\n`;

    await appendFile(artifactPath, line, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeError(errorLike: unknown): Promise<string> {
    return await this.writeJson("error.json", errorToJson(errorLike));
  }

  private async writeArtifact(
    artifactPath: string,
    content: string | Uint8Array,
    mode: number
  ): Promise<void> {
    try {
      await this.atomicWriteFile(artifactPath, content, mode, {});
    } catch (cause) {
      throw artifactStoreError(
        "Atomic artifact write failed",
        "artifact_atomic_write_failed",
        cause
      );
    }
  }
}

function jsonArtifactContent(value: unknown): string {
  assertJsonValue(value);
  const redactedValue = redactValue(value);
  assertJsonValue(redactedValue);

  return `${JSON.stringify(redactedValue, null, 2)}\n`;
}
