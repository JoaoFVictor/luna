import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink
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
