import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "./path-security.js";
import { redactString, redactValue } from "./redactor.js";

function artifactStoreError(
  message: string,
  code: string
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function errorToJson(errorLike: unknown): Record<string, unknown> {
  if (errorLike instanceof Error) {
    return redactValue({
      name: errorLike.name,
      message: errorLike.message,
      stack: errorLike.stack,
      cause: errorLike.cause
    }) as Record<string, unknown>;
  }

  return redactValue({ error: errorLike }) as Record<string, unknown>;
}

export class ArtifactStore {
  readonly artifactRoot: string;
  readonly runId: string;
  private initializedRunDirectory?: string;

  constructor(artifactRoot: string, runId: string) {
    this.artifactRoot = artifactRoot;
    this.runId = runId;
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
    const content = `${JSON.stringify(redactValue(value), null, 2)}\n`;

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
    const content = `${JSON.stringify(redactValue(value), null, 2)}\n`;

    await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeMarkdown(name: string, value: string): Promise<string> {
    const artifactPath = await this.artifactPath(name);

    await writeFile(artifactPath, redactString(value), {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(artifactPath, 0o600);

    return artifactPath;
  }

  async writeError(errorLike: unknown): Promise<string> {
    return await this.writeJson("error.json", errorToJson(errorLike));
  }
}
