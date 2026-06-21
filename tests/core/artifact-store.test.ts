import { chmodSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/core/artifact-store.js";

async function tempRoot(): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), "luna-artifacts-")));
}

describe("artifact store", () => {
  it("creates the final run directory exclusively", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-artifacts-"));
    const store = new ArtifactStore(root, "run-1");

    await expect(store.initializeRunDirectory()).resolves.toBe(
      path.join(root, "run-1")
    );
    await expect(store.initializeRunDirectory()).rejects.toMatchObject({
      code: "run_id_collision"
    });
  });

  it("writeJson requires explicit run directory initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-artifacts-"));
    const store = new ArtifactStore(root, "run-1");

    await expect(
      store.writeJson("run.json", { ok: true })
    ).rejects.toMatchObject({
      code: "artifact_run_directory_uninitialized"
    });
  });

  it("writes invocation, run, markdown report, and error artifacts below the run directory", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "20260618T150405Z-org-repo-pr-1-a1");
    await store.initializeRunDirectory();

    const invocationPath = await store.writeJson("invocation.json", {
      version: "2026-06",
      source: "github",
      event: "pull_request",
      target: { type: "workflow", id: "code-review" },
      subject: { type: "pull_request", id: "1" }
    });
    const runPath = await store.writeJson("run.json", { run_id: "run-1" });
    const reportPath = await store.writeMarkdown("report.md", "# Review\n");
    const errorPath = await store.writeError(new Error("boom"));

    const runDir = path.join(root, "20260618T150405Z-org-repo-pr-1-a1");
    expect(invocationPath).toBe(path.join(runDir, "invocation.json"));
    expect(runPath).toBe(path.join(runDir, "run.json"));
    expect(reportPath).toBe(path.join(runDir, "report.md"));
    expect(errorPath).toBe(path.join(runDir, "error.json"));

    await expect(readFile(invocationPath, "utf8")).resolves.toContain(
      "\"source\": \"github\""
    );
    await expect(readFile(reportPath, "utf8")).resolves.toBe("# Review\n");
    await expect(readFile(errorPath, "utf8")).resolves.toContain("\"message\"");
  });

  it("touchArtifact preserves existing content while enforcing secure mode", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();
    const existingPath = path.join(root, "run-a1", "events.jsonl");

    await writeFile(existingPath, "{\"event\":\"existing\"}\n", {
      encoding: "utf8",
      mode: 0o644
    });

    const touchedPath = await store.touchArtifact("events.jsonl");

    await expect(readFile(touchedPath, "utf8")).resolves.toBe(
      "{\"event\":\"existing\"}\n"
    );
    expect((await stat(touchedPath)).mode & 0o777).toBe(0o600);
  });

  it("redacts secret-looking keys recursively in objects and arrays", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeJson("invocation.json", {
      authorization: "Bearer secret",
      nested: {
        token: "token-value",
        api_key: "key-value",
        values: [
          {
            password: "password-value",
            SECRET: "secret-value",
            public: "visible"
          }
        ]
      }
    });

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.authorization).toBe("[REDACTED]");
    expect(written.nested.token).toBe("[REDACTED]");
    expect(written.nested.api_key).toBe("[REDACTED]");
    expect(written.nested.values[0].password).toBe("[REDACTED]");
    expect(written.nested.values[0].SECRET).toBe("[REDACTED]");
    expect(written.nested.values[0].public).toBe("visible");
  });

  it("redacts common secret key variants without hiding unrelated fields", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeJson("invocation.json", {
      apiKey: "api-key-value",
      OPENAI_API_KEY: "openai-key-value",
      access_token: "access-token-value",
      refreshToken: "refresh-token-value",
      client_secret: "client-secret-value",
      privateKey: "private-key-value",
      githubToken: "github-token-value",
      nested: [
        {
          "api-key": "kebab-api-key-value",
          accessToken: "camel-access-token-value",
          refresh_token: "snake-refresh-token-value",
          "client-secret": "kebab-client-secret-value",
          private_key: "snake-private-key-value",
          public_token_count: 3,
          secretariat: "visible"
        }
      ]
    });

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.apiKey).toBe("[REDACTED]");
    expect(written.OPENAI_API_KEY).toBe("[REDACTED]");
    expect(written.access_token).toBe("[REDACTED]");
    expect(written.refreshToken).toBe("[REDACTED]");
    expect(written.client_secret).toBe("[REDACTED]");
    expect(written.privateKey).toBe("[REDACTED]");
    expect(written.githubToken).toBe("[REDACTED]");
    expect(written.nested[0]["api-key"]).toBe("[REDACTED]");
    expect(written.nested[0].accessToken).toBe("[REDACTED]");
    expect(written.nested[0].refresh_token).toBe("[REDACTED]");
    expect(written.nested[0]["client-secret"]).toBe("[REDACTED]");
    expect(written.nested[0].private_key).toBe("[REDACTED]");
    expect(written.nested[0].public_token_count).toBe(3);
    expect(written.nested[0].secretariat).toBe("visible");
  });

  it("redacts token patterns in JSON command logs", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeJson("validation.json", {
      stdout:
        "curl -H 'Authorization: Bearer token-value' https://example.test",
      stderr:
        "remote: token ghp_1234567890abcdefghijklmnopqrstuvwxyzABC rejected"
    });

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.stdout).toBe(
      "curl -H 'Authorization: Bearer [REDACTED]' https://example.test"
    );
    expect(written.stderr).toBe("remote: token [REDACTED] rejected");
  });

  it("redacts token patterns in directory JSON artifacts", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeJsonInDirectory(
      "attempts",
      "validation.json",
      {
        stdout: "JIRA_API_TOKEN=token-from-env"
      }
    );

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.stdout).toBe("JIRA_API_TOKEN=[REDACTED]");
  });

  it("redacts token patterns in error artifacts", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeError(
      new Error("Authorization: Bearer token-value")
    );

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.message).toBe("Authorization: Bearer [REDACTED]");
  });

  it("writes error causes as JSON-safe error details", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeError(
      new Error("outer", { cause: new Error("inner") })
    );

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written.cause).toMatchObject({
      name: "Error",
      message: "inner"
    });
  });

  it("writes JSON-safe error artifacts for unsafe unknown values", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    await store.initializeRunDirectory();

    const artifactPath = await store.writeError({
      callback: () => "ignored",
      symbol: Symbol("marker"),
      count: 2n,
      date: new Date("2026-06-20T12:00:00.000Z"),
      circular,
      token: "token-value"
    });

    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(written).toEqual({
      error: {
        callback: "[Function]",
        symbol: "Symbol(marker)",
        count: "2",
        date: "2026-06-20T12:00:00.000Z",
        circular: {
          ok: true,
          self: "[Circular]"
        },
        token: "[REDACTED]"
      }
    });
  });

  it("keeps the previous artifact when an injected atomic write fails", async () => {
    const root = await tempRoot();
    const runId = "run-a1";
    const targetPath = path.join(root, runId, "state.json");
    const store = new ArtifactStore(root, runId, {
      atomicWriteFile: async () => {
        throw new Error("rename failed");
      }
    });

    await store.initializeRunDirectory();
    await writeFile(targetPath, "{\n  \"version\": 1\n}\n", {
      encoding: "utf8",
      mode: 0o600
    });

    await expect(
      store.writeJson("state.json", { version: 2 })
    ).rejects.toMatchObject({ code: "artifact_atomic_write_failed" });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      "{\n  \"version\": 1\n}\n"
    );
  });

  it("atomicWriteFile syncs the file and parent directory before completing", async () => {
    const { atomicWriteFile } = await import("../../src/core/atomic-write.js");
    const root = await tempRoot();
    const syncOrder: string[] = [];

    await atomicWriteFile(path.join(root, "state.json"), "{\"ok\":true}\n", 0o600, {
      onFileSynced: () => syncOrder.push("file"),
      onDirectorySynced: () => syncOrder.push("directory")
    });

    expect(syncOrder).toEqual(["file", "directory"]);
  });

  it("atomicWriteFile removes its temp file when rename fails", async () => {
    const { atomicWriteFile } = await import("../../src/core/atomic-write.js");
    const root = await tempRoot();
    const targetPath = path.join(root, "state.json");
    let tempPath: string | undefined;

    await mkdir(targetPath);

    await expect(
      atomicWriteFile(targetPath, "{\"version\":2}\n", 0o600, {
        onTempFileCreated: (createdPath) => {
          tempPath = createdPath;
        }
      })
    ).rejects.toMatchObject({ code: "artifact_atomic_write_failed" });

    expect(tempPath).toBeDefined();
    await expect(readFile(tempPath as string, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readdir(root)).resolves.toEqual(["state.json"]);
  });

  it("atomicWriteFile preserves its error code when temp cleanup fails", async () => {
    const { atomicWriteFile } = await import("../../src/core/atomic-write.js");
    const root = await tempRoot();
    const targetPath = path.join(root, "state.json");
    let tempPath: string | undefined;

    await mkdir(targetPath);

    try {
      await expect(
        atomicWriteFile(targetPath, "{\"version\":2}\n", 0o600, {
          onTempFileCreated: (createdPath) => {
            tempPath = createdPath;
            chmodSync(root, 0o500);
          }
        })
      ).rejects.toMatchObject({ code: "artifact_atomic_write_failed" });
    } finally {
      chmodSync(root, 0o700);
      if (tempPath !== undefined) {
        await rm(tempPath, { force: true });
      }
    }
  });

  it("writeJson rejects non-JSON values before writing json artifacts", async () => {
    const root = await tempRoot();
    const runId = "run-a1";
    const targetPath = path.join(root, runId, "state.json");
    const store = new ArtifactStore(root, runId);

    await store.initializeRunDirectory();

    await expect(
      store.writeJson("state.json", { value: Number.NaN })
    ).rejects.toMatchObject({ code: "artifact_json_value_invalid" });
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("redacts secrets in markdown reports", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    const artifactPath = await store.writeMarkdown(
      "report.md",
      [
        "# Report",
        "Authorization: Basic dXNlckBleGFtcGxlLmNvbTp0b2tlbg==",
        "JIRA_API_TOKEN=token-from-env"
      ].join("\n")
    );

    await expect(readFile(artifactPath, "utf8")).resolves.toBe(
      [
        "# Report",
        "Authorization: Basic [REDACTED]",
        "JIRA_API_TOKEN=[REDACTED]"
      ].join("\n")
    );
  });

  it("uses safe path joining for artifact writes", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "../escape");

    await expect(store.initializeRunDirectory()).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects invalid artifact filenames with slashes", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");
    await store.initializeRunDirectory();

    await expect(
      store.writeJson("nested/run.json", { ok: true })
    ).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects writes when a preexisting run path is a symlink outside the artifact root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const runId = "run-a1";

    await mkdir(outside, { recursive: true });

    try {
      await symlink(outside, path.join(root, runId), "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }

      throw error;
    }

    const store = new ArtifactStore(root, runId);

    await expect(store.initializeRunDirectory()).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects directory writes when the initialized run directory is replaced by a symlink outside the artifact root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const runId = "run-a1";
    const store = new ArtifactStore(root, runId);

    await store.initializeRunDirectory();
    await rm(path.join(root, runId), { recursive: true });

    try {
      await symlink(outside, path.join(root, runId), "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }

      throw error;
    }

    await expect(
      store.writeJsonInDirectory("attempts", "run.json", { ok: true })
    ).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });
});
