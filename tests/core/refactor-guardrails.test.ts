import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";
import {
  assertDocsCatalogDriftGuardrail,
  deletedPathRecommendationViolations,
  realReviewPrCommandViolations
} from "./docs-catalog-drift-guardrail.js";
import { lifecycleStepMapViolations } from "./lifecycle-guardrail.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type CoreDomainViolationRule =
  | "src-core-root-implementation-file"
  | "global-core-types-barrel"
  | "flue-runtime-import"
  | "generic-provider-import"
  | "legacy-flue-core-path"
  | "export-star-barrel";

type CoreDomainViolation = {
  path: string;
  rule: CoreDomainViolationRule;
  removeByWave: number;
};

type CoreDomainViolationManifest = {
  currentWave: number;
  finalMode: boolean;
  violations: CoreDomainViolation[];
};

const allowedCompositionRoots = new Set([
  "src/workflows/luna.ts",
  "src/cli.ts",
  "src/adapters/registry.ts",
  "src/core/agent-runtime/flue/workflow-factory.ts",
  "src/core/change-request/default-registry.ts"
]);

const legacyArtifactTestContractAllowlist = new Set([
  "tests/core/refactor-guardrails.test.ts"
]);

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8")) as T;
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

function resolvedSourceImport(
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

function sourceImportsFromSource(
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

    const resolved = resolvedSourceImport(relativePath, specifier.text, sourceFiles);
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

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const normalizedContent = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalizedContent.split(/\r?\n/).length;
}

function violationKey(violation: Pick<CoreDomainViolation, "path" | "rule">): string {
  return `${violation.path}:${violation.rule}`;
}

function assertManifestEntry(entry: CoreDomainViolation, currentWave: number): void {
  expect(entry.path).toEqual(expect.any(String));
  expect(entry.rule).toEqual(expect.any(String));
  expect(entry.removeByWave).toEqual(expect.any(Number));
  expect(entry.removeByWave).toBeGreaterThan(0);
  expect(
    entry.removeByWave,
    `${violationKey(entry)} removeByWave must be after currentWave`
  ).toBeGreaterThan(currentWave);
}

function applyTemporaryViolationManifest(
  violations: CoreDomainViolation[],
  manifest: CoreDomainViolationManifest,
  rule: CoreDomainViolationRule
): string[] {
  if (manifest.finalMode) {
    return violations.map(violationKey).sort();
  }

  const allowlisted = new Set(
    manifest.violations
      .filter((violation) => violation.rule === rule)
      .map(violationKey)
  );

  return violations
    .map(violationKey)
    .filter((key) => !allowlisted.has(key))
    .sort();
}

function unexpectedViolationKeys(
  keys: string[],
  manifest: CoreDomainViolationManifest,
  rule: CoreDomainViolationRule
): string[] {
  const allowedKeys = new Set(
    manifest.finalMode
      ? []
      : manifest.violations
          .filter((violation) => violation.rule === rule)
          .map(violationKey)
  );

  return [...new Set(keys)]
    .filter((key) => !allowedKeys.has(key))
    .sort();
}

function isProviderPath(relativePath: string): boolean {
  return (
    relativePath.startsWith("src/core/providers/") ||
    isProviderAdapterPath(relativePath)
  );
}

function isProviderAdapterPath(relativePath: string): boolean {
  return (
    relativePath.startsWith("src/adapters/github-pr-url/") ||
    relativePath.startsWith("src/adapters/jira-task-url/") ||
    relativePath.startsWith("src/adapters/plane-task-url/")
  );
}

function isGenericRuntimePath(relativePath: string): boolean {
  return (
    relativePath.startsWith("src/") &&
    relativePath.endsWith(".ts") &&
    !isProviderPath(relativePath) &&
    !allowedCompositionRoots.has(relativePath)
  );
}

function isLegacyFlueCorePath(relativePath: string): boolean {
  return (
    relativePath.startsWith("src/core/flue-") &&
    !relativePath.startsWith("src/core/agent-runtime/flue/")
  );
}

function coreDomainViolation(
  path: string,
  rule: CoreDomainViolationRule
): CoreDomainViolation {
  return { path, rule, removeByWave: 7 };
}

function importSpecifiersFromSource(relativePath: string, content: string): string[] {
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

    imports.push(specifier.text);
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
  return imports;
}

function exportStarBarrelsFromSource(
  relativePath: string,
  content: string
): CoreDomainViolation[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations: CoreDomainViolation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause === undefined &&
      node.moduleSpecifier !== undefined
    ) {
      violations.push(coreDomainViolation(relativePath, "export-star-barrel"));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
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
  it("requires oversized-file waivers to remain empty", async () => {
    const waivers = await readJson<Record<string, unknown>>(
      "tests/fixtures/refactor/oversized-file-waivers.json"
    );
    const oversizedFiles = await oversizedTypeScriptFiles();

    expect(Object.keys(waivers)).toEqual(["waivers"]);
    expect(waivers).toEqual({ waivers: [] });
    expect(oversizedFiles).toEqual({});
  });

  it("treats provider adapters as provider-owned import targets", () => {
    const providerOwnedTargets = [
      "src/core/providers/github/built-ins.ts",
      "src/adapters/github-pr-url/index.ts",
      "src/adapters/jira-task-url/adapter.ts",
      "src/adapters/plane-task-url/adapter.ts"
    ];

    expect(providerOwnedTargets.filter(isProviderPath)).toEqual(providerOwnedTargets);
  });

  it("rejects expired temporary core-domain violations", () => {
    expect(() =>
      assertManifestEntry({
        path: "src/core/types.ts",
        rule: "global-core-types-barrel",
        removeByWave: 1
      }, 1)
    ).toThrow(/removeByWave/);
  });

  it("keeps core domain ownership violations explicit and temporary", async () => {
    const manifest = await readJson<CoreDomainViolationManifest>(
      "tests/fixtures/refactor/core-domain-refactor-violations.json"
    );
    const sourceFiles = (await listFiles("src"))
      .filter((file) => file.endsWith(".ts"))
      .sort();
    const sourceFileSet = new Set(sourceFiles);
    const violationKeys = new Set<string>();

    expect(manifest.currentWave).toBe(7);
    expect(typeof manifest.finalMode).toBe("boolean");

    for (const violation of manifest.violations) {
      assertManifestEntry(violation, manifest.currentWave);
      expect(sourceFileSet.has(violation.path)).toBe(true);
      expect(violationKeys.has(violationKey(violation))).toBe(false);
      violationKeys.add(violationKey(violation));
    }

    const rawSrcCoreRootImplementationFiles = sourceFiles
      .filter((file) => /^src\/core\/[^/]+\.ts$/.test(file))
      .filter((file) => file !== "src/core/types.ts")
      .map((file) =>
        coreDomainViolation(
          file,
          "src-core-root-implementation-file"
        )
      );
    const rawGlobalCoreTypesBarrels = sourceFiles
      .filter((file) => file === "src/core/types.ts")
      .map((file) => coreDomainViolation(file, "global-core-types-barrel"));
    const rawFlueRuntimeImportViolations: string[] = [];
    const rawGenericProviderImportViolations: string[] = [];
    const rawLegacyPathReferences: string[] = [];
    const rawExportStarBarrels: string[] = [];

    for (const relativePath of sourceFiles) {
      const content = await readText(relativePath);
      const imports = importSpecifiersFromSource(relativePath, content);
      const resolvedImports = sourceImportsFromSource(
        relativePath,
        content,
        sourceFileSet
      );

      if (
        imports.some((specifier) =>
          specifier === "@flue/runtime" ||
          specifier === "@flue/runtime/node"
        ) &&
        !relativePath.startsWith("src/core/agent-runtime/flue/")
      ) {
        rawFlueRuntimeImportViolations.push(
          violationKey(coreDomainViolation(relativePath, "flue-runtime-import"))
        );
      }

      if (isGenericRuntimePath(relativePath)) {
        for (const importedPath of resolvedImports) {
          if (isProviderPath(importedPath)) {
            rawGenericProviderImportViolations.push(
              violationKey(coreDomainViolation(relativePath, "generic-provider-import"))
            );
          }
        }
      }

      for (const importedPath of resolvedImports) {
        if (isLegacyFlueCorePath(importedPath)) {
          rawLegacyPathReferences.push(
            violationKey(coreDomainViolation(relativePath, "legacy-flue-core-path"))
          );
        }
      }

      rawExportStarBarrels.push(
        ...exportStarBarrelsFromSource(relativePath, content).map(violationKey)
      );
    }

    const actualViolationKeys = new Set([
      ...rawSrcCoreRootImplementationFiles.map(violationKey),
      ...rawGlobalCoreTypesBarrels.map(violationKey),
      ...rawFlueRuntimeImportViolations,
      ...rawGenericProviderImportViolations,
      ...rawLegacyPathReferences,
      ...rawExportStarBarrels
    ]);
    for (const violation of manifest.violations) {
      expect(
        actualViolationKeys.has(violationKey(violation)),
        `${violationKey(violation)} no longer violates a core domain guardrail`
      ).toBe(true);
    }

    const srcCoreRootImplementationFiles = applyTemporaryViolationManifest(
      rawSrcCoreRootImplementationFiles,
      manifest,
      "src-core-root-implementation-file"
    );
    const globalCoreTypesBarrels = applyTemporaryViolationManifest(
      rawGlobalCoreTypesBarrels,
      manifest,
      "global-core-types-barrel"
    );
    const flueRuntimeImportViolations = unexpectedViolationKeys(
      rawFlueRuntimeImportViolations,
      manifest,
      "flue-runtime-import"
    );
    const genericProviderImportViolations = unexpectedViolationKeys(
      rawGenericProviderImportViolations,
      manifest,
      "generic-provider-import"
    );
    const legacyPathReferences = unexpectedViolationKeys(
      rawLegacyPathReferences,
      manifest,
      "legacy-flue-core-path"
    );
    const exportStarBarrels = unexpectedViolationKeys(
      rawExportStarBarrels,
      manifest,
      "export-star-barrel"
    );

    expect(srcCoreRootImplementationFiles).toEqual([]);
    expect(globalCoreTypesBarrels).toEqual([]);
    expect(flueRuntimeImportViolations).toEqual([]);
    expect(genericProviderImportViolations).toEqual([]);
    expect(legacyPathReferences).toEqual([]);
    expect(exportStarBarrels).toEqual([]);
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
        relativePath: "src/core/configured-workflow/runner.ts",
        content: [
          "function inferWorkspaceDecision(scheduleResult: { steps: Record<string, unknown> }) {",
          "  return scheduleResult.steps;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow/runner.ts:2 reads scheduler step output maps"
      },
      {
        name: "state.steps lifecycle id",
        relativePath: "src/core/configured-workflow/runner.ts",
        content: [
          "function lifecycleProbe(state: { steps: Record<string, unknown> }) {",
          "  return state.steps.acceptance;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow/runner.ts:2 indexes lifecycle step output maps"
      },
      {
        name: "steps lifecycle id",
        relativePath: "src/core/configured-workflow/runner.ts",
        content: [
          "function lifecycleProbe(steps: Record<string, unknown>) {",
          "  return steps[\"commit\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow/runner.ts:2 indexes lifecycle step output maps"
      },
      {
        name: "raw output bracket status",
        relativePath: "src/core/configured-workflow/runner.ts",
        content: [
          "function lifecycleProbe(output: Record<string, unknown>) {",
          "  return output[\"status\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow/runner.ts:2 reads raw node output for lifecycle"
      },
      {
        name: "raw output property validation",
        relativePath: "src/core/configured-workflow/runner.ts",
        content: [
          "function lifecycleProbe(output: Record<string, unknown>) {",
          "  return output.final_validation;",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/configured-workflow/runner.ts:2 reads raw node output for lifecycle"
      },
      {
        name: "implementation_lifecycle marker",
        relativePath: "src/core/configured-workflow/runner.ts",
        content: "const marker = \"implementation_lifecycle\";",
        expectedViolation:
          "src/core/configured-workflow/runner.ts:1 reintroduces agent/loop lifecycle metadata"
      },
      {
        name: "raw result output",
        relativePath: "src/core/write-mode/lifecycle.ts",
        content: [
          "function record(result: { output?: unknown }) {",
          "  return result[\"output\"];",
          "}"
        ].join("\n"),
        expectedViolation:
          "src/core/write-mode/lifecycle.ts:2 reads raw lifecycle output"
      },
      {
        name: "WorkflowNodeRunResult type",
        relativePath: "src/core/write-mode/lifecycle.ts",
        content: "type WorkflowNodeRunResult = { output: unknown };",
        expectedViolation:
          "src/core/write-mode/lifecycle.ts:1 reintroduces agent/loop lifecycle metadata"
      },
      {
        name: "WorkflowNodeStepResult type",
        relativePath: "src/core/write-mode/lifecycle.ts",
        content: "type WorkflowNodeStepResult = { output: unknown };",
        expectedViolation:
          "src/core/write-mode/lifecycle.ts:1 reintroduces agent/loop lifecycle metadata"
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
    const genericRuntimeFiles = (await listFiles("src"))
      .filter(isGenericRuntimePath)
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

  it("keeps workflow graphs and fixtures on explicit artifacts only", async () => {
    const workflowGraphs = (await listFiles("workflows")).filter((file) =>
      file.endsWith("/graph.yaml")
    );
    const artifactFixtureGraphs = (await listFiles("tests/fixtures/workflows")).filter(
      (file) => file.endsWith(".yaml")
    );
    const reportPathFixtureGraphs = (await listFiles("tests/fixtures/workflows")).filter(
      (file) => file.endsWith(".yaml")
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
      "src/core/workflow/definition.ts",
      "src/core/workflow/scheduler.ts",
      "src/core/configured-workflow/runner.ts"
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
    const checkedFiles = (await listFiles("src")).filter((file) =>
      file.endsWith(".ts")
    );

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

  it("detects deleted path recommendations unless they are explicit warnings", () => {
    expect(
      deletedPathRecommendationViolations(
        "docs.md",
        "Add the shared contract to src/core/types.ts."
      )
    ).toEqual(["docs.md:1 recommends deleted core path"]);
    expect(
      deletedPathRecommendationViolations(
        "docs.md",
        "Do not recommend src/core/types.ts."
      )
    ).toEqual([]);
    expect(
      deletedPathRecommendationViolations(
        "docs.md",
        [
          "Do not recommend deleted paths in the section below.",
          "Add shared contracts in src/core/types.ts."
        ].join("\n")
      )
    ).toEqual(["docs.md:2 recommends deleted core path"]);
    expect(
      deletedPathRecommendationViolations(
        "docs.md",
        "For legacy runtime support, add src/core/flue-tools.ts."
      )
    ).toEqual(["docs.md:1 recommends deleted core path"]);
  });
});
