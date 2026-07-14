import { assertJsonValue } from "../../core/json/value.js";
import {
  ArtifactSemanticTypeSchema,
  type ArtifactSemanticType
} from "../../core/artifacts/semantic-type.js";
import type { WorkflowExpression } from "../../core/workflow/expression.js";
import type { WorkflowState } from "../../core/workflow/state.js";
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

export type ArtifactFormat = "json" | "markdown" | "png";

export type ArtifactRef = {
  id: string;
  uri: string;
  node_id: string;
  media_type?: string;
};

export type ArtifactPublisherOutput = {
  artifacts: ArtifactRef[];
};

export type ArtifactPublishInput = {
  node_id: string;
  path: string;
  format: ArtifactFormat;
  value: unknown;
  semantic_type?: ArtifactSemanticType;
  overwrite_policy: ArtifactOverwritePolicy;
};

export type ArtifactPublisherPort = {
  publish(input: ArtifactPublishInput): Promise<ArtifactRef>;
  read(
    ref: Pick<ArtifactRef, "id" | "uri">,
    options?: { readonly max_bytes?: number }
  ): Promise<Uint8Array>;
  verify?(ref: ArtifactRef & {
    readonly content_hash?: string;
    readonly size_bytes?: number;
  }): Promise<boolean>;
};

/**
 * Carries refs that were already durably committed before a later artifact in
 * the same declared batch failed. Callers must retain these refs while still
 * surfacing runtimeCause as the authoritative node failure.
 */
export class PartialArtifactPublishFailure extends Error {
  readonly runtimeCause: unknown;
  readonly publishedArtifacts: readonly ArtifactRef[];

  constructor(runtimeCause: unknown, publishedArtifacts: readonly ArtifactRef[]) {
    super(
      runtimeCause instanceof Error
        ? runtimeCause.message
        : "Declared artifact publication failed",
      { cause: runtimeCause }
    );
    this.name = "PartialArtifactPublishFailure";
    this.runtimeCause = runtimeCause;
    this.publishedArtifacts = [...publishedArtifacts];
  }
}

export function partialArtifactPublishFailure(
  cause: unknown
): PartialArtifactPublishFailure | undefined {
  return cause instanceof PartialArtifactPublishFailure ? cause : undefined;
}

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
  semantic_type?: ArtifactSemanticType;
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
  state: WorkflowState
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
  if (format === "json") {
    return "application/json";
  }
  return format === "markdown" ? "text/markdown" : "image/png";
}

function assertArtifactPublisherOutput(output: ArtifactPublisherOutput): void {
  if (!matchesJsonSchema(artifactPublisherOutputSchema, output)) {
    throw artifactPlanError(
      "Artifact publisher produced invalid output",
      "artifact_publisher_output_invalid"
    );
  }
}

function artifactContent(input: ArtifactPublishInput): string | Uint8Array {
  if (input.format === "markdown") {
    if (typeof input.value !== "string") {
      throw artifactPlanError(
        `Artifact source must resolve to a string for ${input.format}: ${input.path}`,
        "workflow_artifact_string_required"
      );
    }

    return input.value;
  }

  if (input.format === "png") {
    if (typeof input.value !== "string") {
      throw artifactPlanError(
        `Artifact source must resolve to base64 text for ${input.format}: ${input.path}`,
        "workflow_artifact_string_required"
      );
    }
    const normalized = input.value.replace(/\s/gu, "");
    if (normalized === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
      throw artifactPlanError(
        `Artifact source must contain valid base64 for ${input.format}: ${input.path}`,
        "workflow_artifact_base64_invalid"
      );
    }
    const bytes = Buffer.from(normalized, "base64");
    if (
      bytes.length < 8 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw artifactPlanError(
        `Artifact source is not a PNG image: ${input.path}`,
        "workflow_artifact_media_invalid"
      );
    }
    return bytes;
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

function assertArtifactPublishInput(input: ArtifactPublishInput): void {
  rejectUnsupportedOverwritePolicy(input.overwrite_policy);

  if (
    input.semantic_type !== undefined &&
    !ArtifactSemanticTypeSchema.safeParse(input.semantic_type).success
  ) {
    throw artifactPlanError(
      "Artifact semantic_type is invalid",
      "workflow_artifact_semantic_type_invalid"
    );
  }

  if (
    (input.format === "markdown" || input.format === "png") &&
    typeof input.value !== "string"
  ) {
    throw artifactPlanError(
      `Artifact source must resolve to a string for ${input.format}: ${input.path}`,
      "workflow_artifact_string_required"
    );
  }

  if (input.format === "json") {
    assertJsonValue(input.value);
  }

  if (input.format === "png") {
    artifactContent(input);
  }
}

export function transactionalArtifactPublisher(
  options: TransactionalArtifactPublisherOptions
): ArtifactPublisherPort {
  return {
    async publish(input) {
      assertSafeArtifactPath(input.path);
      assertArtifactPublishInput(input);
      const result = await publishArtifactTransaction({
        run_id: options.run_id,
        node_id: input.node_id,
        artifact_id: input.path,
        artifact_path: input.path,
        content: artifactContent(input),
        media_type: artifactMediaType(input.format),
        ...(input.semantic_type === undefined
          ? {}
          : { semantic_type: input.semantic_type }),
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
    },
    async read(ref, readOptions) {
      const expectedUri = `artifact://${options.run_id}/${ref.id}`;
      if (ref.uri !== expectedUri) {
        throw artifactPlanError(
          "Artifact reference does not belong to this run",
          "workflow_artifact_reference_invalid"
        );
      }
      assertSafeArtifactPath(ref.id);
      if (options.contentStore.read === undefined) {
        throw artifactPlanError(
          "Artifact content is not readable from this backend",
          "workflow_artifact_content_unavailable"
        );
      }
      return await options.contentStore.read({
        run_id: options.run_id,
        artifact_path: ref.id,
        ...(readOptions?.max_bytes === undefined
          ? {}
          : { max_bytes: readOptions.max_bytes })
      });
    },
    async verify(ref) {
      try {
        assertSafeArtifactPath(ref.id);
      } catch {
        return false;
      }
      const manifest = await options.manifestStore.get({
        id: ref.id,
        run_id: options.run_id,
        source_node_id: ref.node_id,
        artifact_path: ref.id,
        attempt: options.attempt ?? 1,
        backend_id: options.backend.id,
        backend_root: options.backend.root
      });
      return manifest !== undefined &&
        manifest.status === "committed" &&
        manifest.id === ref.id &&
        manifest.uri === ref.uri &&
        manifest.source_node_id === ref.node_id &&
        (ref.media_type === undefined || manifest.media_type === ref.media_type) &&
        (ref.content_hash === undefined || manifest.content_hash === ref.content_hash) &&
        (ref.size_bytes === undefined || manifest.content_size_bytes === ref.size_bytes);
    }
  };
}

export async function publishDeclaredArtifacts({
  publisher,
  node,
  output,
  state
}: {
  publisher: Pick<ArtifactPublisherPort, "publish">;
  node: WorkflowNodeWithArtifacts;
  output: unknown;
  state: WorkflowState;
}): Promise<ArtifactPublisherOutput> {
  const artifactState: WorkflowState = {
    ...state,
    steps: {
      ...state.steps,
      [node.id]: output
    }
  };
  const refs: ArtifactRef[] = [];
  const publishInputs: ArtifactPublishInput[] = [];

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

    const publishInput: ArtifactPublishInput = {
      node_id: node.id,
      path: artifact.path,
      format: artifact.format,
      value: resolved.value,
      ...(artifact.semantic_type === undefined
        ? {}
        : { semantic_type: artifact.semantic_type }),
      overwrite_policy: overwritePolicy(artifact.config)
    };
    assertArtifactPublishInput(publishInput);
    publishInputs.push(publishInput);
  }

  // Validate and resolve the complete declaration before the first durable
  // side effect. Only publisher failures can therefore create a partial batch.
  for (const publishInput of publishInputs) {
    try {
      refs.push(await publisher.publish(publishInput));
    } catch (cause) {
      throw new PartialArtifactPublishFailure(cause, refs);
    }
  }

  const publisherOutput = { artifacts: refs };
  assertArtifactPublisherOutput(publisherOutput);
  return publisherOutput;
}
