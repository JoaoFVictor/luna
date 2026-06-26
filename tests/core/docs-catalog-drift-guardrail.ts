import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import YAML from "yaml";
import { officialCapabilityManifests } from "../../src/capabilities/registry.js";
import { lunaToolCatalog } from "../../src/core/tools/catalog.js";

async function readText(repoRoot: string, relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function listFiles(repoRoot: string, relativeDirectory: string): Promise<string[]> {
  const root = path.join(repoRoot, relativeDirectory);
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? await listFiles(repoRoot, relativePath) : [relativePath];
  }));

  return nested.flat().sort();
}

function isFileSystemError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

async function listTopLevelFilesIfExists(repoRoot: string, relativeDirectory: string): Promise<string[]> {
  try {
    const root = path.join(repoRoot, relativeDirectory);
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.posix.join(relativeDirectory, entry.name))
      .sort();
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function yamlFenceBodies(content: string): string[] {
  return [...content.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function objectHasLegacyKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(objectHasLegacyKey);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const object = value as Record<string, unknown>;
  const artifactKey = "artifact";
  const reportSnakeKey = `report_${"path"}`;
  const reportCamelKey = `report${"Path"}`;
  return (
    artifactKey in object ||
    reportSnakeKey in object ||
    reportCamelKey in object ||
    Object.values(object).some(objectHasLegacyKey)
  );
}

function parsedYamlHasLegacyKey(content: string): boolean {
  return YAML.parseAllDocuments(content).some((document) =>
    document.errors.length === 0 && objectHasLegacyKey(document.toJSON())
  );
}

function markdownListAfterMarker(content: string, marker: string): string[] {
  const lines = content.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === marker);
  expect(markerIndex, `missing markdown inventory marker: ${marker}`).toBeGreaterThanOrEqual(0);

  const values: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    const match = line.match(/^\s*-\s+`([^`]+)`\s*$/);
    if (match !== null) {
      values.push(match[1]);
    } else if (values.length > 0 && line.trim() !== "") {
      break;
    }
  }

  expect(values, `empty markdown inventory after marker: ${marker}`).not.toEqual([]);
  return values.sort();
}

async function workflowIdsFromDefinitions(repoRoot: string): Promise<string[]> {
  const workflowDefinitions = (await listFiles(repoRoot, "workflows"))
    .filter((file) => file.endsWith("/workflow.yaml"));
  const ids: string[] = [];

  for (const relativePath of workflowDefinitions) {
    const definition = YAML.parse(await readText(repoRoot, relativePath)) as { id?: unknown };
    expect(definition.id, `${relativePath} must declare id`).toEqual(expect.any(String));
    expect(path.posix.basename(path.posix.dirname(relativePath)), `${relativePath} directory must match workflow id`)
      .toBe(definition.id);
    ids.push(definition.id as string);
  }

  return ids.sort();
}

async function officialAuthoringBuiltIns(): Promise<string[]> {
  return officialCapabilityManifests
    .flatMap((manifest) => Object.keys("built_ins" in manifest ? manifest.built_ins ?? {} : {}))
    .sort();
}

async function publicDocumentationFiles(repoRoot: string): Promise<string[]> {
  return [
    "README.md",
    ...(await listTopLevelFilesIfExists(repoRoot, "docs")).filter((file) => file.endsWith(".md")),
    ...(await listFiles(repoRoot, "examples")).filter((file) => file.endsWith(".md")),
    ...(await listFiles(repoRoot, "skills")).filter((file) => file.endsWith(".md"))
  ].sort();
}

function legacyLineViolations(relativePath: string, content: string): string[] {
  const reportSnake = `report_${"path"}`;
  const reportCamel = `report${"Path"}`;
  const stateReport = `state.${reportCamel}`;
  const tokens = [
    ["artifact", /(?<![A-Za-z0-9_-])artifact\s*:/],
    [reportSnake, /\breport_path\b/],
    [reportCamel, /\breportPath\b/],
    [stateReport, /\bstate\.reportPath\b/]
  ] as const;

  return content.split(/\r?\n/).flatMap((line, index) =>
    tokens
      .filter(([, pattern]) => pattern.test(line))
      .map(([token]) => `${relativePath}:${index + 1} contains ${token}:`)
  );
}

function realWorkflowTargets(relativePath: string, content: string): string[] {
  return [...content.matchAll(/\bworkflow:([a-z][a-z0-9-]*)\b/g)]
    .map((match) => match[1])
    .filter((id) => id !== "my-workflow")
    .map((id) => `${relativePath} references workflow:${id}`);
}

const deletedPathPatterns = [
  /src\/core\/types\.ts/,
  /src\/tools\/repository-tools\.ts/,
  /src\/core\/flue-[A-Za-z0-9_.-]+/,
  /src\/core\/implementation-[A-Za-z0-9_.-]+/,
  /built-ins\/index\.ts/
] as const;

const deletedPathWarningPattern =
  /\b[Dd]o not\b|\bnot recommend\b|\bforbidden\b/;

function isDeletedPathAllowedLine(line: string): boolean {
  const trimmedLine = line.trim();
  return (
    deletedPathWarningPattern.test(trimmedLine) ||
    trimmedLine.startsWith("rtk rg ")
  );
}

export function realReviewPrCommandViolations(
  relativePath: string,
  content: string
): string[] {
  const lines = content.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!/(?<![A-Za-z0-9_-])review-pr\s+<url>(?![A-Za-z0-9_-])/.test(line)) {
      return [];
    }

    const contextText = lines
      .slice(Math.max(0, index - 3), Math.min(lines.length, index + 4))
      .join("\n");
    return /\bDo not add\b|\bdo not add\b|\bone-off commands\b/.test(contextText)
      ? []
      : [`${relativePath}:${index + 1} exposes real command review-pr <url>`];
  });
}

export function deletedPathRecommendationViolations(
  relativePath: string,
  content: string
): string[] {
  const lines = content.split(/\r?\n/);

  return lines.flatMap((line, index) => {
    if (!deletedPathPatterns.some((pattern) => pattern.test(line))) {
      return [];
    }

    return isDeletedPathAllowedLine(line)
      ? []
      : [`${relativePath}:${index + 1} recommends deleted core path`];
  });
}

export async function assertDocsCatalogDriftGuardrail(repoRoot: string): Promise<void> {
  const builtIns = await officialAuthoringBuiltIns();
  const toolIds = Object.keys(lunaToolCatalog).sort();
  const workflowIds = await workflowIdsFromDefinitions(repoRoot);
  const legacyViolations: string[] = [];
  const workflowReferences: string[] = [];
  const reviewPrViolations: string[] = [];
  const deletedPathViolations: string[] = [];

  expect(builtIns, "runtime built-in inventory from src/core/built-ins/catalog.ts").not.toEqual([]);
  expect(toolIds, "runtime tool inventory from src/core/tools/catalog.ts").not.toEqual([]);
  expect(workflowIds, "workflow id inventory from workflows/*/workflow.yaml").not.toEqual([]);

  for (const relativePath of ["README.md"]) {
    const content = await readText(repoRoot, relativePath);
    expect(markdownListAfterMarker(content, "Built-in steps:"), `${relativePath} built-in inventory`)
      .toEqual(builtIns);
    expect(markdownListAfterMarker(content, "Local tools:"), `${relativePath} local tools inventory`)
      .toEqual(toolIds);
    expect(markdownListAfterMarker(content, "Workflows:"), `${relativePath} workflow inventory`)
      .toEqual(workflowIds);
  }

  expect(
    markdownListAfterMarker(await readText(repoRoot, "examples/new-workflow.md"), "## 4. Supported Built-Ins"),
    "examples/new-workflow.md Supported Built-Ins"
  ).toEqual(builtIns);

  for (const relativePath of await publicDocumentationFiles(repoRoot)) {
    const content = await readText(repoRoot, relativePath);
    for (const yamlBody of yamlFenceBodies(content)) {
      if (parsedYamlHasLegacyKey(yamlBody)) {
        legacyViolations.push(`${relativePath} contains legacy artifact/report path key inside YAML fence`);
      }
    }
    legacyViolations.push(...legacyLineViolations(relativePath, content));
    workflowReferences.push(...realWorkflowTargets(relativePath, content));
    reviewPrViolations.push(...realReviewPrCommandViolations(relativePath, content));
    deletedPathViolations.push(...deletedPathRecommendationViolations(relativePath, content));
  }

  const referencedWorkflowIds = [...new Set(workflowReferences.map((reference) =>
    reference.match(/workflow:([a-z][a-z0-9-]*)/)?.[1]
  ))].filter((id): id is string => id !== undefined).sort();

  expect(legacyViolations).toEqual([]);
  expect(reviewPrViolations).toEqual([]);
  expect(deletedPathViolations).toEqual([]);
  expect(referencedWorkflowIds).toEqual(workflowIds);
  for (const reference of workflowReferences) {
    expect(workflowIds, reference).toContain(reference.match(/workflow:([a-z][a-z0-9-]*)/)?.[1]);
  }
}
