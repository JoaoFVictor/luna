import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadWorkflowDefinition } from "../../src/core/workflow-definition.js";
import {
  assertDocsCatalogDriftGuardrail,
  realReviewPrCommandViolations
} from "./docs-catalog-drift-guardrail.js";
import { lifecycleStepMapViolations } from "./lifecycle-guardrail.js";

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

type CompositionEdge = {
  from: string;
  to: string;
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
  compositionEdges: CompositionEdge[];
};

type NonRuntimeOwnershipManifest = {
  schemaVersion: 1;
  files: Record<string, ProviderOccurrence[]>;
};

const allowedRuntimeOwners: RuntimeOwner[] = [
  "composition-root", "generic", "provider:github", "provider:jira"
];

const wave0OversizedFileBaseline = [
  "src/core/configured-workflow-runner.ts",
  "tests/core/configured-workflow-runner.test.ts",
  "tests/core/flue-modules.test.ts",
  "tests/core/implementation-git-actions.test.ts"
];

const ownershipFixturePaths = new Set([
  "tests/fixtures/ownership/runtime-ownership.json",
  "tests/fixtures/ownership/non-runtime-ownership.json",
  "tests/core/refactor-guardrails.test.ts"
]);

const providerMarkerPattern =
  /github-pr-context|github-pr-url|jira-issue-context|jira-task-url|jira-auth|provider_payload|providerPayload|provider\.payload|provider\/model|provider_cost_unit|openai-codex|test-provider|github|jira/gi;

const runtimeProviderMarkers = [
  "github-pr-context",
  "github-pr-url",
  "jira-issue-context",
  "jira-task-url",
  "jira-auth",
  "github",
  "jira"
].sort((left, right) => right.length - left.length);

const exactCommandMarkers = ["gh"];

const compositionRootPaths = new Set([
  "src/adapters/registry.ts",
  "src/core/built-ins/catalog.ts"
]);

const genericRuntimeProviderMarkerLiteralAllowlist = new Map<string, Map<string, number>>([
  [
    "src/core/repo-context-collector.ts",
    new Map([["version https://git-lfs.github.com/spec/v1", 1]])
  ],
  [
    "src/core/types.ts",
    new Map([["github", 2]])
  ]
]);

const legacyArtifactShapeAllowlist = new Set([
  "tests/fixtures/workflows/legacy-artifact-string.graph.yaml",
  "tests/fixtures/workflows/legacy-artifact-map.graph.yaml"
]);

const legacyReportPathShapeAllowlist = new Set([
  "tests/fixtures/workflows/legacy-report-path.graph.yaml"
]);

const legacyArtifactTestContractAllowlist = new Set([
  "tests/core/workflow-definition-legacy-artifacts.test.ts",
  "tests/core/workflow-definition-legacy-report-path.test.ts",
  "tests/core/refactor-guardrails.test.ts"
]);

const legacyReportPathRuntimeAllowlist = new Set([
  "src/core/workflow-definition.ts"
]);

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

function isProviderOwner(owner: RuntimeOwner): boolean {
  return owner.startsWith("provider:");
}

function compositionEdgeKey(edge: Pick<CompositionEdge, "from" | "to">): string {
  return `${edge.from} -> ${edge.to}`;
}

function runtimeOwnerForPath(
  manifest: RuntimeOwnershipManifest,
  relativePath: string
): OwnershipEntry {
  const entry = manifest.files[relativePath];
  expect(entry, `${relativePath} is missing from runtime ownership manifest`)
    .toBeDefined();

  return entry;
}

function providerMarkerFromText(text: string): string | undefined {
  const normalized = text.toLowerCase();

  if (exactCommandMarkers.includes(normalized)) {
    return normalized;
  }

  return runtimeProviderMarkers.find((marker) => normalized.includes(marker));
}

function providerMarkersInSource(
  relativePath: string,
  content: string
): ProviderOccurrence[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const occurrences: ProviderOccurrence[] = [];
  const literalAllowlist = new Map(
    genericRuntimeProviderMarkerLiteralAllowlist.get(relativePath) ??
      []
  );

  function record(marker: string, node: ts.Node): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    occurrences.push({
      line: line + 1,
      marker,
      category: providerCategory(marker)
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const remainingAllowances = literalAllowlist.get(node.text) ?? 0;
      if (remainingAllowances > 0) {
        literalAllowlist.set(node.text, remainingAllowances - 1);
        return;
      }

      const marker = providerMarkerFromText(node.text);
      if (marker !== undefined) {
        record(marker, node);
      }
    } else if (ts.isIdentifier(node)) {
      const marker = providerMarkerFromText(node.text);
      if (marker !== undefined) {
        record(marker, node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const [literal, remainingAllowances] of literalAllowlist) {
    if (remainingAllowances !== 0) {
      occurrences.push({
        line: 1,
        marker: `allowlist_not_consumed:${literal}`,
        category: providerCategory(literal)
      });
    }
  }

  return occurrences;
}

function resolvedRuntimeImport(
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`,
    path.posix.join(base, "index.ts")
  ];

  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function runtimeImportsFromSource(
  relativePath: string,
  content: string,
  sourceFiles: ReadonlySet<string>
): string[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const imports: string[] = [];

  function addSpecifier(specifier: ts.Expression): void {
    if (!ts.isStringLiteralLike(specifier)) {
      return;
    }

    const resolved = resolvedRuntimeImport(relativePath, specifier.text, sourceFiles);
    if (resolved !== undefined) {
      imports.push(resolved);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addSpecifier(node.moduleSpecifier);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined
    ) {
      addSpecifier(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(imports)].sort();
}

function runtimeOwnerFor(relativePath: string): OwnershipEntry {
  if (compositionRootPaths.has(relativePath)) {
    return {
      owner: "composition-root",
      reason: "Connects provider-owned modules at an explicit runtime composition root."
    };
  }

  if (
    relativePath.startsWith("src/adapters/github-pr-url/") ||
    relativePath.includes("/providers/github/")
  ) {
    return {
      owner: "provider:github",
      reason: "Owns GitHub-specific adapter, action, or runtime context behavior."
    };
  }

  if (
    relativePath.startsWith("src/adapters/jira-task-url/") ||
    relativePath.includes("/providers/jira/")
  ) {
    return {
      owner: "provider:jira",
      reason: "Owns Jira-specific adapter, auth, config, task, or report behavior."
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

function objectHasLegacyArtifactKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => objectHasLegacyArtifactKey(item));
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(value, "artifact")) {
    return true;
  }

  return Object.values(value).some((nested) => objectHasLegacyArtifactKey(nested));
}

function objectHasLegacyReportPathKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => objectHasLegacyReportPathKey(item));
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "report_path") ||
    Object.prototype.hasOwnProperty.call(value, "reportPath")
  ) {
    return true;
  }

  return Object.values(value).some((nested) => objectHasLegacyReportPathKey(nested));
}

function yamlFenceBodies(content: string): string[] {
  return [...content.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map(
    (match) => match[1]
  );
}

function parsedYamlHasLegacyArtifact(content: string): boolean {
  const documents = YAML.parseAllDocuments(content);

  return documents.some((document) => {
    if (document.errors.length > 0) {
      return false;
    }

    return objectHasLegacyArtifactKey(document.toJSON());
  });
}

function parsedYamlHasLegacyReportPath(content: string): boolean {
  const documents = YAML.parseAllDocuments(content);

  return documents.some((document) => {
    if (document.errors.length > 0) {
      return false;
    }

    return objectHasLegacyReportPathKey(document.toJSON());
  });
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function hasLegacyArtifactTypeContract(sourceFile: ts.SourceFile): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }

    if (
      (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) &&
      propertyNameText(node.name) === "artifact"
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function hasLegacyArtifactStringContract(sourceFile: ts.SourceFile): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }

    if (
      ts.isStringLiteralLike(node) &&
      /^\s*artifact\s*:/.test(node.text)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function hasLegacyReportPathStringContract(sourceFile: ts.SourceFile): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }

    if (
      ts.isStringLiteralLike(node) &&
      (/^\s*report_path\s*:/.test(node.text) || /\breportPath\b/.test(node.text))
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
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
    expect(Array.isArray(manifest.compositionEdges)).toBe(true);

    for (const entry of Object.values(manifest.files)) {
      expect(allowedRuntimeOwners).toContain(entry.owner);
      expect(entry.reason).toEqual(expect.any(String));
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }

    for (const edge of manifest.compositionEdges) {
      expect(edge.from).toEqual(expect.any(String));
      expect(edge.to).toEqual(expect.any(String));
      expect(edge.reason).toEqual(expect.any(String));
      expect(edge.reason.trim().length).toBeGreaterThan(0);
      await assertExists(edge.from);
      await assertExists(edge.to);
      expect(manifest.files[edge.from]?.owner).toBe("composition-root");
      expect(isProviderOwner(manifest.files[edge.to]?.owner)).toBe(true);
    }

    expect(Object.fromEntries(sourceFiles.map((file) => [file, runtimeOwnerFor(file)])))
      .toEqual(manifest.files);
  });

  it("enforces runtime provider ownership import boundaries", async () => {
    const manifest = await readJson<RuntimeOwnershipManifest>(
      "tests/fixtures/ownership/runtime-ownership.json"
    );
    const sourceFiles = new Set(Object.keys(manifest.files));
    const compositionEdges = new Set(
      manifest.compositionEdges.map((edge) => compositionEdgeKey(edge))
    );
    const violations: string[] = [];

    for (const relativePath of sourceFiles) {
      const owner = runtimeOwnerForPath(manifest, relativePath).owner;
      const imports = runtimeImportsFromSource(
        relativePath,
        await readText(relativePath),
        sourceFiles
      );

      for (const importedPath of imports) {
        const importedOwner = runtimeOwnerForPath(manifest, importedPath).owner;
        if (!isProviderOwner(importedOwner)) {
          continue;
        }

        if (owner === "generic") {
          violations.push(`${relativePath} imports provider-owned ${importedPath}`);
          continue;
        }

        if (
          owner === "composition-root" &&
          !compositionEdges.has(compositionEdgeKey({ from: relativePath, to: importedPath }))
        ) {
          violations.push(
            `${relativePath} imports provider-owned ${importedPath} without compositionEdge`
          );
          continue;
        }

        if (
          isProviderOwner(owner) &&
          owner !== importedOwner &&
          !compositionEdges.has(compositionEdgeKey({ from: relativePath, to: importedPath }))
        ) {
          violations.push(
            `${relativePath} imports cross-provider ${importedPath} without compositionEdge`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps provider markers out of generic runtime files", async () => {
    const manifest = await readJson<RuntimeOwnershipManifest>(
      "tests/fixtures/ownership/runtime-ownership.json"
    );
    const violations: Record<string, ProviderOccurrence[]> = {};

    for (const [relativePath, entry] of Object.entries(manifest.files)) {
      if (entry.owner !== "generic") {
        continue;
      }

      const markers = providerMarkersInSource(
        relativePath,
        await readText(relativePath)
      );
      if (markers.length > 0) {
        violations[relativePath] = markers;
      }
    }

    expect(violations).toEqual({});
  });

  it("detects lifecycle regressions from step maps and raw output parsing", () => {
    const cases: Array<{
      name: string;
      relativePath: string;
      content: string;
      expectedViolation: string;
    }> = [
      {
        name: "scheduleResult.steps in lifecycle helper",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: [
          "function inferWorkspaceDecision(scheduleResult: { steps: Record<string, unknown> }) {",
          "  return scheduleResult.steps;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow-runner.ts:2 reads scheduler step output maps"
      },
      {
        name: "state.steps lifecycle id",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: [
          "function lifecycleProbe(state: { steps: Record<string, unknown> }) {",
          "  return state.steps.acceptance;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow-runner.ts:2 indexes lifecycle step output maps"
      },
      {
        name: "steps lifecycle id",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: [
          "function lifecycleProbe(steps: Record<string, unknown>) {",
          "  return steps[\"commit\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow-runner.ts:2 indexes lifecycle step output maps"
      },
      {
        name: "raw output bracket status",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: [
          "function lifecycleProbe(output: Record<string, unknown>) {",
          "  return output[\"status\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow-runner.ts:2 reads raw node output for lifecycle"
      },
      {
        name: "raw output property validation",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: [
          "function lifecycleProbe(output: Record<string, unknown>) {",
          "  return output.final_validation;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow-runner.ts:2 reads raw node output for lifecycle"
      },
      {
        name: "implementation_lifecycle marker",
        relativePath: "src/core/configured-workflow-runner.ts",
        content: "const marker = \"implementation_lifecycle\";",
        expectedViolation:
          "src/core/configured-workflow-runner.ts:1 reintroduces agent/loop lifecycle metadata"
      },
      {
        name: "raw result output",
        relativePath: "src/core/implementation-lifecycle.ts",
        content: [
          "function record(result: { output?: unknown }) {",
          "  return result[\"output\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/implementation-lifecycle.ts:2 reads raw lifecycle output"
      },
      {
        name: "WorkflowNodeRunResult type",
        relativePath: "src/core/implementation-lifecycle.ts",
        content: "type WorkflowNodeRunResult = { output: unknown };",
        expectedViolation:
          "src/core/implementation-lifecycle.ts:1 reintroduces agent/loop lifecycle metadata"
      },
      {
        name: "WorkflowNodeStepResult type",
        relativePath: "src/core/implementation-lifecycle.ts",
        content: "type WorkflowNodeStepResult = { output: unknown };",
        expectedViolation:
          "src/core/implementation-lifecycle.ts:1 reintroduces agent/loop lifecycle metadata"
      }
    ];

    for (const testCase of cases) {
      expect(
        lifecycleStepMapViolations(testCase.relativePath, testCase.content),
        testCase.name
      ).toContain(testCase.expectedViolation);
    }
  });

  it("keeps workspace lifecycle decisions off generic step-output maps", async () => {
    const manifest = await readJson<RuntimeOwnershipManifest>(
      "tests/fixtures/ownership/runtime-ownership.json"
    );
    const genericRuntimeFiles = Object.entries(manifest.files)
      .filter(([, entry]) => entry.owner === "generic")
      .map(([relativePath]) => relativePath)
      .filter((relativePath) => relativePath.endsWith(".ts"))
      .sort();
    const violations = (
      await Promise.all(
        genericRuntimeFiles.map(async (relativePath) =>
          lifecycleStepMapViolations(relativePath, await readText(relativePath))
        )
      )
    ).flat();

    expect(violations).toEqual([]);
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

  it("rejects legacy workflow artifact shape outside fixed negative coverage", async () => {
    const workflowGraphs = (await listFiles("workflows")).filter((file) =>
      file.endsWith("/graph.yaml")
    );
    const artifactFixtureGraphs = (await listFiles("tests/fixtures/workflows")).filter(
      (file) => file.endsWith(".yaml") && !legacyArtifactShapeAllowlist.has(file)
    );
    const reportPathFixtureGraphs = (await listFiles("tests/fixtures/workflows")).filter(
      (file) => file.endsWith(".yaml") && !legacyReportPathShapeAllowlist.has(file)
    );

    for (const relativePath of [...workflowGraphs, ...artifactFixtureGraphs]) {
      expect(parsedYamlHasLegacyArtifact(await readText(relativePath))).toBe(false);
    }

    for (const relativePath of [...workflowGraphs, ...reportPathFixtureGraphs]) {
      expect(parsedYamlHasLegacyReportPath(await readText(relativePath))).toBe(false);
    }
  });

  it("keeps public docs and examples on explicit artifacts only", async () => {
    const docs = [
      "README.md",
      "skills/luna-create-workflow/SKILL.md",
      ...(await listFiles("examples")).filter((file) => file.endsWith(".md"))
    ];

    for (const relativePath of docs) {
      const content = await readText(relativePath);
      for (const yamlBody of yamlFenceBodies(content)) {
        expect(parsedYamlHasLegacyArtifact(yamlBody)).toBe(false);
        expect(parsedYamlHasLegacyReportPath(yamlBody)).toBe(false);
      }
    }
  });

  it("does not expose the legacy artifact shape in workflow TypeScript contracts", async () => {
    const checkedFiles = [
      "src/core/workflow-definition.ts",
      "src/core/workflow-scheduler.ts",
      "src/core/configured-workflow-runner.ts"
    ];

    for (const relativePath of checkedFiles) {
      const sourceFile = ts.createSourceFile(
        relativePath,
        await readText(relativePath),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      expect(hasLegacyArtifactTypeContract(sourceFile)).toBe(false);
    }
  });

  it("does not expose legacy report path strings in runtime source", async () => {
    const checkedFiles = (await listFiles("src"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !legacyReportPathRuntimeAllowlist.has(file));

    for (const relativePath of checkedFiles) {
      const sourceFile = ts.createSourceFile(
        relativePath,
        await readText(relativePath),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      expect(hasLegacyReportPathStringContract(sourceFile)).toBe(false);
    }
  });

  it("keeps test workflow fixtures on explicit artifacts only", async () => {
    const checkedFiles = (await listFiles("tests/core"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !legacyArtifactTestContractAllowlist.has(file));

    for (const relativePath of checkedFiles) {
      const sourceFile = ts.createSourceFile(
        relativePath,
        await readText(relativePath),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      expect(hasLegacyArtifactStringContract(sourceFile)).toBe(false);
      expect(hasLegacyReportPathStringContract(sourceFile)).toBe(false);
    }
  });

  it("requires non-runtime provider marker paths to stay explicit", async () => {
    const nonRuntimeManifest = await readJson<NonRuntimeOwnershipManifest>(
      "tests/fixtures/ownership/non-runtime-ownership.json"
    );

    expect(nonRuntimeManifest.schemaVersion).toBe(1);
    expect(await nonRuntimeProviderInventory()).toEqual(nonRuntimeManifest.files);

    for (const relativePath of Object.keys(nonRuntimeManifest.files)) {
      await assertExists(relativePath);
    }
  });

  it("keeps public docs, examples, and skills aligned with runtime inventories", async () => {
    await assertDocsCatalogDriftGuardrail(repoRoot);
  });

  it("detects legacy review-pr commands unless they are explicit anti-examples", () => {
    expect(realReviewPrCommandViolations("docs.md", "review-pr <url>"))
      .toEqual(["docs.md:1 exposes real command review-pr <url>"]);
    expect(
      realReviewPrCommandViolations(
        "docs.md",
        "npm run dev -- review-pr <url>"
      )
    ).toEqual(["docs.md:1 exposes real command review-pr <url>"]);
    expect(
      realReviewPrCommandViolations(
        "docs.md",
        "Do not add one-off commands like review-pr <url>."
      )
    ).toEqual([]);
  });
});
