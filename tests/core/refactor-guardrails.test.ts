import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow-definition.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type RefactorGate = {
  name?: unknown;
  command?: unknown;
  testFile?: unknown;
};

type RefactorWave = {
  requiredGates?: unknown;
};

type RuntimeOwner = "composition-root" | "generic" | "provider:github" | "provider:jira";

type OwnershipEntry = {
  owner: RuntimeOwner;
  reason: string;
};

type ProviderOccurrence = {
  line: number;
  marker: string;
  category: "github" | "jira" | "provider";
};

type RuntimeOwnershipManifest = {
  schemaVersion: 1;
  files: Record<string, OwnershipEntry>;
  wave0ProviderBoundaryInventory: Record<string, ProviderOccurrence[]>;
};

type NonRuntimeOwnershipManifest = {
  schemaVersion: 1;
  files: Record<string, ProviderOccurrence[]>;
};

const allowedRuntimeOwners: RuntimeOwner[] = [
  "composition-root",
  "generic",
  "provider:github",
  "provider:jira"
];

const wave0OversizedFileBaseline = [
  "src/core/configured-workflow-runner.ts",
  "tests/core/configured-workflow-runner.test.ts",
  "tests/core/flue-modules.test.ts"
];

const ownershipFixturePaths = new Set([
  "tests/fixtures/ownership/runtime-ownership.json",
  "tests/fixtures/ownership/non-runtime-ownership.json",
  "tests/core/refactor-guardrails.test.ts"
]);

const providerMarkerPattern =
  /github-pr-context|github-pr-url|jira-issue-context|jira-task-url|jira-auth|provider_unsupported|provider_payload|providerPayload|provider\.payload|provider\/model|provider_cost_unit|openai-codex|test-provider|github|jira/gi;

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8")) as T;
}

async function assertExists(relativePath: string): Promise<void> {
  await access(path.join(repoRoot, relativePath));
}

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function listFiles(relativeDirectory: string): Promise<string[]> {
  const root = path.join(repoRoot, relativeDirectory);
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? await listFiles(relativePath) : [relativePath];
    })
  );

  return nested.flat().sort();
}

function runtimeOwnerFor(relativePath: string): OwnershipEntry {
  if (relativePath === "src/core/built-ins/catalog.ts") {
    return {
      owner: "composition-root",
      reason: "Registers built-ins at the runtime composition root."
    };
  }

  if (
    relativePath.startsWith("src/adapters/github-pr-url/") ||
    relativePath.includes("github-pr-context") ||
    relativePath.includes("/providers/github/")
  ) {
    return {
      owner: "provider:github",
      reason: "Owns GitHub-specific adapter or runtime context behavior."
    };
  }

  if (
    relativePath.startsWith("src/adapters/jira-task-url/") ||
    relativePath.includes("jira-issue-context") ||
    relativePath.includes("jira-auth") ||
    relativePath.includes("/providers/jira/")
  ) {
    return {
      owner: "provider:jira",
      reason: "Owns Jira-specific adapter, auth, or runtime context behavior."
    };
  }

  return {
    owner: "generic",
    reason: "Shared runtime code that must not grow provider-specific behavior unnoticed."
  };
}

function providerCategory(marker: string): ProviderOccurrence["category"] {
  const normalized = marker.toLowerCase();
  if (normalized.includes("github")) {
    return "github";
  }
  if (normalized.includes("jira")) {
    return "jira";
  }
  return "provider";
}

function markerInventory(content: string, pattern: RegExp): ProviderOccurrence[] {
  pattern.lastIndex = 0;
  return content
    .split(/\r?\n/)
    .flatMap((lineContent, index) => {
      pattern.lastIndex = 0;
      return Array.from(lineContent.matchAll(pattern)).map((match) => {
        const marker = match[0].toLowerCase();
        return {
          line: index + 1,
          marker,
          category: providerCategory(marker)
        };
      });
    });
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalizedContent.split(/\r?\n/).length;
}

async function runtimeProviderBoundaryInventory(
  files: Record<string, OwnershipEntry>
): Promise<RuntimeOwnershipManifest["wave0ProviderBoundaryInventory"]> {
  const inventory: RuntimeOwnershipManifest["wave0ProviderBoundaryInventory"] = {};

  for (const [relativePath, entry] of Object.entries(files)) {
    if (entry.owner !== "generic") {
      continue;
    }

    const markers = markerInventory(
      await readFile(path.join(repoRoot, relativePath), "utf8"),
      providerMarkerPattern
    );
    if (markers.length > 0) {
      inventory[relativePath] = markers;
    }
  }

  return inventory;
}

async function nonRuntimeProviderInventory(): Promise<NonRuntimeOwnershipManifest["files"]> {
  const roots = ["agents", "workflows", "examples", "skills", "tests"];
  const files = [
    ...(await Promise.all(roots.map((root) => listFiles(root)))).flat(),
    "README.md"
  ].filter((file) => !ownershipFixturePaths.has(file)).sort();
  const inventory: NonRuntimeOwnershipManifest["files"] = {};

  for (const relativePath of files) {
    const content = await readFile(path.join(repoRoot, relativePath), "utf8");
    const markers = markerInventory(content, providerMarkerPattern);
    if (markers.length > 0) {
      inventory[relativePath] = markers;
    }
  }

  return inventory;
}

async function oversizedTypeScriptFiles(): Promise<Record<string, number>> {
  const files = [
    ...(await listFiles("src")),
    ...(await listFiles("tests"))
  ].filter((file) => file.endsWith(".ts"));
  const oversizedFiles: Record<string, number> = {};

  for (const relativePath of files) {
    const content = await readFile(path.join(repoRoot, relativePath), "utf8");
    const lineCount = countLines(content);
    if (lineCount > 1000) {
      oversizedFiles[relativePath] = lineCount;
    }
  }

  return oversizedFiles;
}

describe("refactor guardrails", () => {
  it("requires wave gates for waves 0, A, B, C, and D", async () => {
    const manifest = await readJson<{ waves: Record<string, RefactorWave> }>(
      "tests/fixtures/refactor/thermo-structural-refactor-gates.json"
    );

    expect(Object.keys(manifest.waves)).toEqual(["0", "A", "B", "C", "D"]);

    for (const waveId of ["0", "A", "B", "C", "D"]) {
      const wave = manifest.waves[waveId];
      expect(Array.isArray(wave?.requiredGates)).toBe(true);

      for (const gate of wave?.requiredGates as RefactorGate[]) {
        expect(gate.name).toEqual(expect.any(String));
        expect(gate.command !== undefined || gate.testFile !== undefined).toBe(true);

        if (gate.command !== undefined) {
          expect(gate.command).toEqual(expect.any(String));
          expect(
            (gate.command as string).startsWith("npm run ") ||
              (gate.command as string).startsWith("npm test")
          ).toBe(true);
        }

        if (gate.testFile !== undefined) {
          expect(gate.testFile).toEqual(expect.any(String));
          await assertExists(gate.testFile as string);
        }
      }
    }

    expect(
      (manifest.waves.B.requiredGates as RefactorGate[])
        .some((gate) => gate.name === "observability-contract")
    )
      .toBe(true);
    expect(
      (manifest.waves.C.requiredGates as RefactorGate[])
        .some((gate) => gate.name === "observability-contract")
    )
      .toBe(false);
  });

  it("requires oversized-file waivers to remain empty", async () => {
    const waivers = await readJson<Record<string, unknown>>(
      "tests/fixtures/refactor/oversized-file-waivers.json"
    );
    const oversizedFiles = await oversizedTypeScriptFiles();

    expect(Object.keys(waivers)).toEqual(["waivers"]);
    expect(waivers).toEqual({ waivers: [] });
    expect(Object.keys(oversizedFiles).sort()).toEqual(wave0OversizedFileBaseline);
  });

  it("classifies every runtime source file in the runtime ownership manifest", async () => {
    const manifest = await readJson<RuntimeOwnershipManifest>(
      "tests/fixtures/ownership/runtime-ownership.json"
    );
    const sourceFiles = (await listFiles("src")).filter((file) => file.endsWith(".ts"));

    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.files).sort()).toEqual(sourceFiles);

    for (const entry of Object.values(manifest.files)) {
      expect(allowedRuntimeOwners).toContain(entry.owner);
      expect(entry.reason).toEqual(expect.any(String));
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }

    expect(Object.fromEntries(sourceFiles.map((file) => [file, runtimeOwnerFor(file)])))
      .toEqual(manifest.files);
  });

  it("does not allow TypeScript workflow entrypoints besides src/workflows/luna.ts", async () => {
    const workflowEntryPoints = (await listFiles("src/workflows"))
      .filter((file) => file.endsWith(".ts"))
      .sort();

    expect(workflowEntryPoints).toEqual(["src/workflows/luna.ts"]);
  });

  it("loads the real code-review and implementation workflow graphs", async () => {
    await expect(loadWorkflowDefinition(path.join(repoRoot, "workflows"), "code-review"))
      .resolves.toMatchObject({
        id: "code-review",
        graph: { nodes: expect.any(Array) }
      });
    await expect(loadWorkflowDefinition(path.join(repoRoot, "workflows"), "implementation"))
      .resolves.toMatchObject({
        id: "implementation",
        graph: { nodes: expect.any(Array) }
      });
  });

  it("records provider-boundary inventory in non-enforcing Wave 0 mode", async () => {
    const runtimeManifest = await readJson<RuntimeOwnershipManifest>(
      "tests/fixtures/ownership/runtime-ownership.json"
    );
    const nonRuntimeManifest = await readJson<NonRuntimeOwnershipManifest>(
      "tests/fixtures/ownership/non-runtime-ownership.json"
    );

    expect(runtimeManifest.schemaVersion).toBe(1);
    expect(nonRuntimeManifest.schemaVersion).toBe(1);
    expect(await runtimeProviderBoundaryInventory(runtimeManifest.files))
      .toEqual(runtimeManifest.wave0ProviderBoundaryInventory);
    expect(await nonRuntimeProviderInventory()).toEqual(nonRuntimeManifest.files);
  });

  it("checks docs and catalog inventories without changing runtime contracts", async () => {
    const catalog = await readText("src/core/built-ins/catalog.ts");
    const toolRegistry = await readText("src/core/flue-tool-registry.ts");
    const readme = await readText("README.md");

    const builtInSymbols = [...catalog.matchAll(/\b([a-zA-Z0-9]+BuiltIn)\b/g)]
      .map((match) => match[1])
      .sort();
    const toolIds = [...toolRegistry.matchAll(/"([a-z0-9.-]+)"/g)]
      .map((match) => match[1])
      .filter((id) => id.includes("."))
      .sort();

    expect(builtInSymbols.length).toBeGreaterThan(0);
    expect(toolIds).toEqual(expect.arrayContaining(["repository.diff-summary", "repository.status"]));
    expect(readme.trim().length).toBeGreaterThan(0);

    for (const graph of (await listFiles("workflows")).filter((file) => file.endsWith("/graph.yaml"))) {
      const graphContent = await readText(graph);
      expect(graphContent).toContain("nodes:");
    }

    for (const example of await listFiles("examples")) {
      const exampleContent = await readText(example);
      expect(exampleContent.trim().length).toBeGreaterThan(0);
    }

    const agentsGuide = await readText("AGENTS.md");
    const referencedSkills = [...agentsGuide.matchAll(/skills\/[^\s`]+\/SKILL\.md/g)]
      .map((match) => match[0])
      .sort();
    expect(referencedSkills.length).toBeGreaterThan(0);

    for (const skill of referencedSkills) {
      const skillContent = await readText(skill);
      expect(skillContent.trim().length).toBeGreaterThan(0);
    }
  });
});
