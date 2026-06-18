import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "./path-security.js";

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function isSecretKey(key: string): boolean {
  const words = keyWords(key);

  if (words.includes("count")) {
    return false;
  }

  if (words.includes("secret") || words.includes("password")) {
    return true;
  }

  if (words.includes("authorization")) {
    return true;
  }

  if (words.includes("token")) {
    return true;
  }

  return words.includes("key") && words.some((word) => word !== "key");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = isSecretKey(key)
        ? "[REDACTED]"
        : redact(nestedValue);
    }

    return redacted;
  }

  return value;
}

function errorToJson(errorLike: unknown): Record<string, unknown> {
  if (errorLike instanceof Error) {
    return redact({
      name: errorLike.name,
      message: errorLike.message,
      stack: errorLike.stack,
      cause: errorLike.cause
    }) as Record<string, unknown>;
  }

  return redact({ error: errorLike }) as Record<string, unknown>;
}

export class ArtifactStore {
  readonly artifactRoot: string;
  readonly runId: string;

  constructor(artifactRoot: string, runId: string) {
    this.artifactRoot = artifactRoot;
    this.runId = runId;
  }

  private async runDirectory(): Promise<string> {
    const runDirectory = await safeJoin(this.artifactRoot, [this.runId]);

    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await chmod(runDirectory, 0o700);

    return runDirectory;
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
    const content = `${JSON.stringify(redact(value), null, 2)}\n`;

    await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeJsonInDirectory(
    directory: string,
    name: string,
    value: unknown
  ): Promise<string> {
    const runDirectory = await this.runDirectory();
    const artifactDirectory = await safeJoin(runDirectory, [directory]);

    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    await chmod(artifactDirectory, 0o700);

    const artifactPath = await safeJoin(runDirectory, [directory, name]);
    const content = `${JSON.stringify(redact(value), null, 2)}\n`;

    await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeMarkdown(name: string, value: string): Promise<string> {
    const artifactPath = await this.artifactPath(name);

    await writeFile(artifactPath, value, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeError(errorLike: unknown): Promise<string> {
    return await this.writeJson("error.json", errorToJson(errorLike));
  }
}
