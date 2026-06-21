import path from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "./artifact-store.js";
import { assertJsonValue } from "./json-value.js";
import type { WorkflowNode } from "./workflow-definition.js";
import type { SchedulerWorkflowState } from "./workflow-state.js";

export type ArtifactFormat = "json" | "markdown";

export type ArtifactWritePlan = {
  path: string;
  source: string;
  format: ArtifactFormat;
  required: boolean;
};

type ArtifactWriter = Pick<ArtifactStore, "writeJson" | "writeMarkdown">;

const SOURCE_PREFIX = "$.steps.";
const ARTIFACT_SOURCE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const ArtifactWritePlanSchema = z
  .object({
    path: z.string(),
    source: z.string(),
    format: z.enum(["json", "markdown"]),
    required: z.boolean().optional()
  })
  .strict();

function artifactPlanError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function assertSafeArtifactPath(artifactPath: string): void {
  if (
    artifactPath === "" ||
    artifactPath === "." ||
    path.isAbsolute(artifactPath) ||
    artifactPath.includes("\\")
  ) {
    throw artifactPlanError(
      `Unsafe artifact path: ${artifactPath}`,
      "path_security_violation"
    );
  }

  const segments = artifactPath.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw artifactPlanError(
      `Unsafe artifact path: ${artifactPath}`,
      "path_security_violation"
    );
  }
}

function parseArtifactSource(source: string): string[] {
  if (
    source === "" ||
    !source.startsWith(SOURCE_PREFIX) ||
    source.includes("[") ||
    source.includes("]") ||
    source.includes("*") ||
    source.includes("?") ||
    source.includes("(") ||
    source.includes(")") ||
    source.includes("..")
  ) {
    throw artifactPlanError(
      `Unsupported artifact source: ${source}`,
      "workflow_artifact_source_invalid"
    );
  }

  const segments = source.slice(SOURCE_PREFIX.length).split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) => !ARTIFACT_SOURCE_SEGMENT.test(segment))
  ) {
    throw artifactPlanError(
      `Unsupported artifact source: ${source}`,
      "workflow_artifact_source_invalid"
    );
  }

  return segments;
}

export function normalizeArtifactWritePlans(
  nodeId: string,
  rawPlans: readonly z.infer<typeof ArtifactWritePlanSchema>[] | undefined,
  knownStepIds: ReadonlySet<string>
): ArtifactWritePlan[] | undefined {
  if (rawPlans === undefined) {
    return undefined;
  }

  return rawPlans.map((rawPlan) => {
    assertSafeArtifactPath(rawPlan.path);
    const [stepId] = parseArtifactSource(rawPlan.source);

    if (!knownStepIds.has(stepId)) {
      throw artifactPlanError(
        `Artifact source for ${nodeId} references unknown step: ${stepId}`,
        "workflow_artifact_source_unknown_step"
      );
    }

    if (stepId !== nodeId) {
      throw artifactPlanError(
        `Artifact source for ${nodeId} must reference the declaring node output`,
        "workflow_artifact_source_wrong_step"
      );
    }

    return {
      path: rawPlan.path,
      source: rawPlan.source,
      format: rawPlan.format,
      required: rawPlan.required ?? true
    };
  });
}

export function assertNoDuplicateArtifactPaths(
  nodes: readonly Pick<WorkflowNode, "id" | "artifacts">[]
): void {
  const seen = new Map<string, string>();

  for (const node of nodes) {
    for (const artifact of node.artifacts ?? []) {
      const previousNodeId = seen.get(artifact.path);
      if (previousNodeId !== undefined) {
        throw artifactPlanError(
          `Duplicate artifact path ${artifact.path} on ${previousNodeId} and ${node.id}`,
          "workflow_artifact_path_duplicate"
        );
      }

      seen.set(artifact.path, node.id);
    }
  }
}

export function resolveArtifactSource(
  source: string,
  state: SchedulerWorkflowState
): { found: boolean; value?: unknown } {
  const [stepId, ...pathSegments] = parseArtifactSource(source);

  if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
    return { found: false };
  }

  let current = state.steps[stepId];
  for (const segment of pathSegments) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current === undefined ? { found: false } : { found: true, value: current };
}

export async function writePlannedArtifacts({
  artifactStore,
  node,
  output,
  state
}: {
  artifactStore: ArtifactWriter;
  node: Pick<WorkflowNode, "id" | "artifacts">;
  output: unknown;
  state: SchedulerWorkflowState;
}): Promise<void> {
  const artifactState: SchedulerWorkflowState = {
    ...state,
    steps: {
      ...state.steps,
      [node.id]: output
    }
  };

  for (const artifact of node.artifacts ?? []) {
    const resolved = resolveArtifactSource(artifact.source, artifactState);

    if (!resolved.found) {
      if (artifact.required === false) {
        continue;
      }

      throw artifactPlanError(
        `Required artifact source is missing: ${artifact.source}`,
        "workflow_artifact_source_missing"
      );
    }

    if (artifact.format === "json") {
      assertJsonValue(resolved.value);
      await artifactStore.writeJson(artifact.path, resolved.value);
      continue;
    }

    if (typeof resolved.value !== "string") {
      throw artifactPlanError(
        `Artifact source must resolve to a string for ${artifact.format}: ${artifact.source}`,
        "workflow_artifact_string_required"
      );
    }

    await artifactStore.writeMarkdown(artifact.path, resolved.value);
  }
}
