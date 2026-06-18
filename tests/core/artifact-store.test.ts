import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/core/artifact-store.js";

async function tempRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "luna-artifacts-")));
}

describe("artifact store", () => {
  it("writes invocation, run, markdown report, and error artifacts below the run directory", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "20260618T150405Z-org-repo-pr-1-a1");

    const invocationPath = await store.writeJson("invocation.json", {
      target: "github_pr"
    });
    const runPath = await store.writeJson("run.json", { run_id: "run-1" });
    const reportPath = await store.writeMarkdown("report.md", "# Review\n");
    const errorPath = await store.writeError(new Error("boom"));

    const runDir = join(root, "20260618T150405Z-org-repo-pr-1-a1");
    expect(invocationPath).toBe(join(runDir, "invocation.json"));
    expect(runPath).toBe(join(runDir, "run.json"));
    expect(reportPath).toBe(join(runDir, "report.md"));
    expect(errorPath).toBe(join(runDir, "error.json"));

    await expect(readFile(invocationPath, "utf8")).resolves.toContain(
      "\"target\": \"github_pr\""
    );
    await expect(readFile(reportPath, "utf8")).resolves.toBe("# Review\n");
    await expect(readFile(errorPath, "utf8")).resolves.toContain("\"message\"");
  });

  it("redacts secret-looking keys recursively in objects and arrays", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");

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

  it("uses safe path joining for artifact writes", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "../escape");

    await expect(store.writeJson("run.json", { ok: true })).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects invalid artifact filenames with slashes", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore(root, "run-a1");

    await expect(store.writeJson("nested/run.json", { ok: true })).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects writes when a preexisting run path is a symlink outside the artifact root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const runId = "run-a1";

    await mkdir(outside, { recursive: true });

    try {
      await import("node:fs/promises").then(({ symlink }) =>
        symlink(outside, join(root, runId), "dir")
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }

      throw error;
    }

    const store = new ArtifactStore(root, runId);

    await expect(store.writeJson("run.json", { ok: true })).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });
});
