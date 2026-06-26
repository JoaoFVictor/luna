import { assertJsonValue } from "../../core/json/value.js";
import type { WorkflowExpression } from "../../core/workflow/expression.js";
import type { WorkflowRuntimeState } from "../../core/workflow/state.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type {
  ArtifactCheckpointMarker,
  ArtifactContentStore,
  ArtifactOverwritePolicy,
  ArtifactStepsPublisher,
  ArtifactTransactionJournal
} from "../../core/runtime/artifacts/transaction.js";
import {
  assertSafeArtifactPath,
  publishArtifactTransaction
} from "../../core/runtime/artifacts/transaction.js";
import type { ArtifactManifestStore } from "../../core/runtime/artifacts/contracts.js";

export type ArtifactFormat = "json" | "markdown";

export type ArtifactRef = {
  id: string;
  uri: string;
  node_id: string;
  media_type?: string;
};

export type ArtifactPublisherOutput = {
  artifacts: ArtifactRef[];
};

export type ArtifactWriter = {
  writeJson(name: string, value: unknown): Promise<string>;
  writeMarkdown(name: string, value: string): Promise<string>;
};

export type ArtifactPublishInput = {
  node_id: string;
  path: string;
  format: ArtifactFormat;
  value: unknown;
  overwrite_policy: ArtifactOverwritePolicy;
};

export type ArtifactPublisherPort = {
  publish(input: ArtifactPublishInput): Promise<ArtifactRef>;
};

export type TransactionalArtifactPublisherOptions = {
  run_id: string;
  attempt?: number;
  backend: {
    id: string;
    root: string;
    overwrite_policy?: ArtifactOverwritePolicy;
  };
  manifestStore: ArtifactManifestStore;
  transactionJournal: ArtifactTransactionJournal;
  contentStore: ArtifactContentStore;
  stepsPublisher: ArtifactStepsPublisher;
  checkpointMarker: ArtifactCheckpointMarker;
  now?: () => string;
};

type WorkflowArtifactLike = {
  path: string;
  source: string | WorkflowExpression;
  format: ArtifactFormat;
  required: boolean;
  config?: Record<string, unknown>;
};

type WorkflowNodeWithArtifacts = {
  id: string;
  artifacts?: readonly WorkflowArtifactLike[];
};

const SOURCE_PREFIX = "$.steps.";
const ARTIFACT_SOURCE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const artifactRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "uri", "node_id"],
  properties: {
    id: { type: "string" },
    uri: { type: "string" },
    node_id: { type: "string" },
    media_type: { type: "string" }
  }
} as const;

export const artifactPublisherOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifacts"],
  properties: {
    artifacts: {
      type: "array",
      items: artifactRefSchema
    }
  }
} as const;

function artifactPlanError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
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

function assertNoDuplicateArtifactPaths(
  node: WorkflowNodeWithArtifacts
): void {
  const seen = new Map<string, string>();

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

export function resolveArtifactSource(
  source: string,
  state: WorkflowRuntimeState
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

function artifactMediaType(format: ArtifactFormat): string {
  return format === "json" ? "application/json" : "text/markdown";
}

function artifactRefFromUri(input: ArtifactPublishInput, uri: string): ArtifactRef {
  return {
    id: input.path,
    uri,
    node_id: input.node_id,
    media_type: artifactMediaType(input.format)
  };
}

function assertArtifactPublisherOutput(output: ArtifactPublisherOutput): void {
  if (!matchesJsonSchema(artifactPublisherOutputSchema, output)) {
    throw artifactPlanError(
      "Artifact publisher produced invalid output",
      "artifact_publisher_output_invalid"
    );
  }
}

function artifactContent(input: ArtifactPublishInput): string {
  if (input.format === "markdown") {
    if (typeof input.value !== "string") {
      throw artifactPlanError(
        `Artifact source must resolve to a string for ${input.format}: ${input.path}`,
        "workflow_artifact_string_required"
      );
    }

    return input.value;
  }

  assertJsonValue(input.value);
  return `${JSON.stringify(input.value, null, 2)}\n`;
}

function overwritePolicy(config: Record<string, unknown> | undefined): ArtifactOverwritePolicy {
  const policy = config?.overwrite_policy;
  if (policy === undefined) {
    return "forbid";
  }
  if (policy === "forbid" || policy === "replace" || policy === "version") {
    return policy;
  }

  throw artifactPlanError(
    "Artifact overwrite_policy must be forbid, replace, or version",
    "artifact_overwrite_policy_invalid"
  );
}

function rejectUnsupportedOverwritePolicy(policy: ArtifactOverwritePolicy): void {
  if (policy === "version") {
    throw artifactPlanError(
      "Artifact overwrite_policy version is not supported yet",
      "artifact_overwrite_policy_unsupported"
    );
  }
}

export function artifactStorePublisher(artifactStore: ArtifactWriter): ArtifactPublisherPort {
  return {
    async publish(input) {
      assertSafeArtifactPath(input.path);
      rejectUnsupportedOverwritePolicy(input.overwrite_policy);
      if (input.format === "json") {
        assertJsonValue(input.value);
        return artifactRefFromUri(input, await artifactStore.writeJson(input.path, input.value));
      }

      if (typeof input.value !== "string") {
        throw artifactPlanError(
          `Artifact source must resolve to a string for ${input.format}: ${input.path}`,
          "workflow_artifact_string_required"
        );
      }

      return artifactRefFromUri(
        input,
        await artifactStore.writeMarkdown(input.path, input.value)
      );
    }
  };
}

export function transactionalArtifactPublisher(
  options: TransactionalArtifactPublisherOptions
): ArtifactPublisherPort {
  return {
    async publish(input) {
      const result = await publishArtifactTransaction({
        run_id: options.run_id,
        node_id: input.node_id,
        artifact_id: input.path,
        artifact_path: input.path,
        content: artifactContent(input),
        media_type: artifactMediaType(input.format),
        overwrite_policy: input.overwrite_policy,
        attempt: options.attempt,
        backend: options.backend,
        manifestStore: options.manifestStore,
        transactionJournal: options.transactionJournal,
        contentStore: options.contentStore,
        stepsPublisher: options.stepsPublisher,
        checkpointMarker: options.checkpointMarker,
        now: options.now
      });

      return {
        id: result.manifest.id,
        uri: result.manifest.uri,
        node_id: input.node_id,
        ...(result.manifest.media_type === undefined
          ? {}
          : { media_type: result.manifest.media_type })
      };
    }
  };
}

export async function publishDeclaredArtifacts({
  publisher,
  node,
  output,
  state
}: {
  publisher: ArtifactPublisherPort;
  node: WorkflowNodeWithArtifacts;
  output: unknown;
  state: WorkflowRuntimeState;
}): Promise<ArtifactPublisherOutput> {
  const artifactState: WorkflowRuntimeState = {
    ...state,
    steps: {
      ...state.steps,
      [node.id]: output
    }
  };
  const refs: ArtifactRef[] = [];

  assertNoDuplicateArtifactPaths(node);

  for (const artifact of node.artifacts ?? []) {
    assertSafeArtifactPath(artifact.path);
    const source = typeof artifact.source === "string"
      ? artifact.source
      : artifact.source.expression;
    const [stepId] = parseArtifactSource(source);
    if (stepId !== node.id) {
      throw artifactPlanError(
        `Artifact source for ${node.id} must reference the declaring node output`,
        "workflow_artifact_source_wrong_step"
      );
    }
    const resolved = resolveArtifactSource(source, artifactState);

    if (!resolved.found) {
      if (artifact.required === false) {
        continue;
      }

      throw artifactPlanError(
        `Required artifact source is missing: ${source}`,
        "workflow_artifact_source_missing"
      );
    }

    refs.push(await publisher.publish({
      node_id: node.id,
      path: artifact.path,
      format: artifact.format,
      value: resolved.value,
      overwrite_policy: overwritePolicy(artifact.config)
    }));
  }

  const publisherOutput = { artifacts: refs };
  assertArtifactPublisherOutput(publisherOutput);
  return publisherOutput;
}
