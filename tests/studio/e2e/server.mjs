import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "luna-studio-e2e-"));
const studioStateRoot = await mkdtemp(
  path.join(tmpdir(), "luna-studio-e2e-private-state-")
);
const port = Number.parseInt(process.env.LUNA_STUDIO_E2E_PORT ?? "43219", 10);
const bootstrapFile =
  process.env.LUNA_STUDIO_E2E_BOOTSTRAP_FILE ??
  path.join(tmpdir(), `luna-studio-e2e-bootstrap-${port}.json`);
const executeFile = promisify(execFile);

for (const directory of ["agents", "config", "skills", "workflows"]) {
  await cp(path.join(projectRoot, directory), path.join(fixtureRoot, directory), {
    recursive: true
  });
}

for (const workflowId of [
  "e2e-deterministic",
  "e2e-failure",
  "e2e-trusted-write"
]) {
  await cp(
    path.join(currentDirectory, "fixtures", "workflows", workflowId),
    path.join(fixtureRoot, "workflows", workflowId),
    { recursive: true }
  );
}

const repositoryRoot = path.join(fixtureRoot, "repositories", "fixture");
await mkdir(repositoryRoot, { recursive: true });
await executeFile("git", ["init", "--initial-branch", "main", repositoryRoot]);
await executeFile("git", ["-C", repositoryRoot, "config", "user.name", "Studio E2E"]);
await executeFile("git", ["-C", repositoryRoot, "config", "user.email", "studio-e2e@example.invalid"]);
await writeFile(
  path.join(repositoryRoot, "README.md"),
  "# Studio E2E fixture\n",
  { mode: 0o600 }
);
await executeFile("git", ["-C", repositoryRoot, "add", "README.md"]);
await executeFile("git", ["-C", repositoryRoot, "commit", "-m", "fixture baseline"]);
await executeFile("git", [
  "-C",
  repositoryRoot,
  "remote",
  "add",
  "origin",
  "https://github.com/studio-e2e/fixture.git"
]);
await writeFile(
  path.join(fixtureRoot, "config", "repositories.yaml"),
  [
    "repositories:",
    "  - id: studio-e2e-fixture",
    "    provider: github",
    "    owner: studio-e2e",
    "    name: fixture",
    `    path: ${JSON.stringify(repositoryRoot)}`,
    "    remote: origin",
    "    expected_remote_urls:",
    "      - https://github.com/studio-e2e/fixture.git",
    "    context:",
    "      files:",
    "        - README.md",
    ""
  ].join("\n"),
  { mode: 0o600 }
);
await mkdir(path.join(fixtureRoot, ".luna", "studio"), {
  recursive: true,
  mode: 0o700
});
await mkdir(path.join(fixtureRoot, ".runs"), { recursive: true });

const [
  { defineInputAdapters },
  { loadNativeLunaPlatform },
  { startNativeStudioServer }
] = await Promise.all([
  import("../../../dist/src/adapters/registry.js"),
  import("../../../dist/src/platform/native/native-platform-loader.js"),
  import("../../../dist/src/studio/server/native-studio-server.js")
]);
const platform = await loadNativeLunaPlatform({
  projectRoot: fixtureRoot,
  configRoot: path.join(fixtureRoot, "config")
});
const fixtureAdapter = {
  id: "studio-e2e.fixture",
  description: "Deterministic local Studio E2E adapter",
  source: "studio-e2e-adapter",
  loadEffects: [],
  loadTimeoutMs: 5_000,
  async load(input) {
    if (input.kind !== "cli" || input.value !== "e2e-deterministic") {
      throw new Error("The Studio E2E adapter received an unsupported fixture input");
    }
    return {
      version: "2026-06",
      source: "studio-e2e-adapter",
      event: "manual",
      target: { type: "workflow", id: "e2e-deterministic" },
      payload: { fixture: input.value }
    };
  }
};
const inputAdapters = platform.inputAdapterRegistry
  .ids()
  .map((id) => platform.inputAdapterRegistry.require(id));

const handle = await startNativeStudioServer({
  projectRoot: fixtureRoot,
  configRoot: path.join(fixtureRoot, "config"),
  stateRoot: studioStateRoot,
  platform: {
    ...platform,
    inputAdapterRegistry: defineInputAdapters([
      ...inputAdapters,
      fixtureAdapter
    ])
  },
  frontendRoot: path.join(projectRoot, "apps", "studio", "dist"),
  host: "127.0.0.1",
  port,
  logger: false,
  output: { write() {} }
});

await writeFile(
  bootstrapFile,
  `${JSON.stringify({ launchUrl: handle.launchUrl })}\n`,
  { mode: 0o600 }
);
process.stdout.write("LUNA_STUDIO_E2E_READY\n");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handle.close();
  await Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(studioStateRoot, { recursive: true, force: true }),
    rm(bootstrapFile, { force: true })
  ]);
}

function terminate(code) {
  const forcedExit = setTimeout(() => process.exit(code), 5_000);
  void close().finally(() => {
    clearTimeout(forcedExit);
    process.exit(code);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    terminate(0);
  });
}

process.once("uncaughtException", (error) => {
  process.stderr.write(`LUNA_STUDIO_E2E_FATAL uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  terminate(1);
});
process.once("unhandledRejection", (reason) => {
  process.stderr.write(`LUNA_STUDIO_E2E_FATAL unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  terminate(1);
});
