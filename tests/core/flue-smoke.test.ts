import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFlueCliBin } from "../../src/core/flue-cli.js";
import { InvocationSchema } from "../../src/core/types.js";
import {
  createRealGitReviewFixture,
  type RealGitReviewFixture
} from "../fixtures/git-repo.js";

const execFileAsync = promisify(execFile);

type ExecFileError = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryDiagnostics(root: string): Promise<string> {
  if (!(await pathExists(root))) {
    return `${root} not created`;
  }

  const entries = await readdir(root, { recursive: true });

  return entries.map((entry) => String(entry)).join("\n");
}

async function artifactDiagnostics(configRoot: string): Promise<string> {
  const artifactRoot = path.join(configRoot, ".runs", "code-review");
  const flueOutputRoot = path.join(configRoot, "flue-build");

  if (!(await pathExists(artifactRoot))) {
    return [
      "artifact root not created",
      "flue build:",
      await directoryDiagnostics(flueOutputRoot)
    ].join("\n");
  }

  const runIds = await readdir(artifactRoot);
  const diagnostics = [`runs: ${runIds.join(", ")}`];

  for (const runId of runIds) {
    const runRoot = path.join(artifactRoot, runId);
    const files = await readdir(runRoot);
    diagnostics.push(`${runId}: ${files.join(", ")}`);

    const errorPath = path.join(runRoot, "error.json");
    if (await pathExists(errorPath)) {
      diagnostics.push(await readFile(errorPath, "utf8"));
    }
  }

  return [
    diagnostics.join("\n"),
    "flue build:",
    await directoryDiagnostics(flueOutputRoot)
  ].join("\n");
}

async function runFlueSmoke(
  flueCliBin: string,
  serializedInvocation: string,
  configRoot: string
): Promise<{ stdout: string; stderr: string }> {
  const flueOutputRoot = path.join(configRoot, "flue-build");
  // The temp bundle resolves ESM packages by walking up from flueOutputRoot.
  await symlink(
    path.join(process.cwd(), "node_modules"),
    path.join(configRoot, "node_modules"),
    "dir"
  );

  try {
    return await execFileAsync(
      process.execPath,
      [
        flueCliBin,
        "run",
        "code-review",
        "--target",
        "node",
        "--output",
        flueOutputRoot,
        "--payload",
        serializedInvocation
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          LUNA_FAKE_REVIEW_NODES: "1",
          LUNA_CONFIG_ROOT: configRoot
        },
        timeout: 30_000
      }
    );
  } catch (error) {
    const execError = error as ExecFileError;

    throw new Error(
      [
        `Flue local run failed with exit code ${String(execError.code)}`,
        "stdout:",
        execError.stdout ?? "",
        "stderr:",
        execError.stderr ?? "",
        "artifacts:",
        await artifactDiagnostics(configRoot)
      ].join("\n")
    );
  }
}

async function writeSmokeConfig(
  root: string,
  fixture: RealGitReviewFixture
): Promise<void> {
  const workspaceRoot = path.join(root, ".runs", "workspaces");
  const artifactRoot = path.join(root, ".runs", "code-review");

  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      `  root: ${JSON.stringify(workspaceRoot)}`,
      "  preserve_on_success: false",
      "  preserve_on_failure: false",
      "artifacts:",
      `  root: ${JSON.stringify(artifactRoot)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: github-pr-code-review",
      "    when: {}",
      "    target:",
      "      type: workflow",
      "      id: code-review",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "repositories.yaml"),
    [
      "repositories:",
      `  - id: ${fixture.repository.id}`,
      "    provider: github",
      `    owner: ${fixture.repository.owner}`,
      `    name: ${fixture.repository.name}`,
      `    path: ${JSON.stringify(fixture.repository.path)}`,
      `    remote: ${fixture.repository.remote}`,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "models.yaml"),
    [
      "model_profiles:",
      "  planner:",
      "    model: test/planner",
      "    reasoning_effort: medium",
      "  reviewer:",
      "    model: test/reviewer",
      "    reasoning_effort: high",
      "  acceptance:",
      "    model: test/acceptance",
      "    reasoning_effort: medium",
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("Flue local run smoke", () => {
  const fixtures: RealGitReviewFixture[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("runs the code-review workflow through the local Flue CLI and writes final artifacts", async () => {
    const fixture = await createRealGitReviewFixture();
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-flue-smoke-config-"));
    fixtures.push(fixture);
    tempRoots.push(configRoot);

    await writeSmokeConfig(configRoot, fixture);

    const flueCliBin = await resolveFlueCliBin(process.cwd());
    const normalizedInvocation = InvocationSchema.parse(fixture.invocation);
    const serializedInvocation = JSON.stringify(normalizedInvocation);
    await runFlueSmoke(flueCliBin, serializedInvocation, configRoot);

    const artifactRoot = path.join(configRoot, ".runs", "code-review");
    const runIds = await readdir(artifactRoot);
    expect(runIds).toHaveLength(1);

    const runRoot = path.join(artifactRoot, runIds[0]);
    await expect(pathExists(path.join(runRoot, "final-report.json"))).resolves.toBe(
      true
    );
    await expect(pathExists(path.join(runRoot, "review-plan.json"))).resolves.toBe(
      true
    );
    await expect(
      pathExists(path.join(runRoot, "code-review-findings.json"))
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(runRoot, "acceptance-review.json"))
    ).resolves.toBe(true);
  });
});
