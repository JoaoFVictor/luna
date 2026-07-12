import { z } from "zod";
import type { JsonValue } from "../../core/json/value.js";
import { StudioExpressionFixtureSchema } from "./expression-evaluation.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioRunOpaqueIdSchema } from "./run-launch-primitives.js";
import { StudioRunDefinitionSourceSchema } from "./run-definition-source.js";

export const WORKFLOW_EXPRESSION_FIXTURE_LIMITS = Object.freeze({
  maxFixtures: 16,
  maxNameLength: 64
} as const);

export const WorkflowExpressionFixtureNameSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxNameLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u);

const UnsafeJsonObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
export const WorkflowExpressionFixtureNodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !UnsafeJsonObjectKeys.has(value), {
    message: "The node id cannot be used as a safe JSON object key"
  });

const RunNodeOutputFixtureSourceFields = {
  run_id: StudioRunOpaqueIdSchema,
  workflow_id: z.string().trim().min(1).max(256),
  node_id: WorkflowExpressionFixtureNodeIdSchema,
  graph_hash: StudioDigestSchema,
  outcome_hash: StudioDigestSchema,
  workflow_revision: StudioDigestSchema,
  definition_bundle_hash: StudioDigestSchema,
  captured_at: z.string().datetime({ offset: true }),
  redaction_changed: z.boolean(),
  definition_source: StudioRunDefinitionSourceSchema
} as const;

export const CapturedRunNodeOutputFixtureSourceSchema = z
  .object({
    kind: z.literal("run_node_output"),
    ...RunNodeOutputFixtureSourceFields
  })
  .strict();

export const EditedRunNodeOutputFixtureSourceSchema = z
  .object({
    kind: z.literal("edited_run_node_output"),
    ...RunNodeOutputFixtureSourceFields,
    redaction_changed: z.literal(false),
    source_output_hash: StudioDigestSchema,
    output_hash: StudioDigestSchema,
    edited_at: z.string().datetime({ offset: true })
  })
  .strict();

export const WorkflowExpressionFixtureSourceSchema = z.discriminatedUnion(
  "kind",
  [
    CapturedRunNodeOutputFixtureSourceSchema,
    EditedRunNodeOutputFixtureSourceSchema
  ]
);

export const PromoteRunNodeOutputFixtureRequestSchema = z
  .object({
    fixture_name: WorkflowExpressionFixtureNameSchema,
    run_id: StudioRunOpaqueIdSchema,
    node_id: WorkflowExpressionFixtureNodeIdSchema,
    graph_hash: StudioDigestSchema,
    outcome_hash: StudioDigestSchema
  })
  .strict();

export const EditRunNodeOutputFixtureRequestSchema = z
  .object({
    fixture_name: WorkflowExpressionFixtureNameSchema,
    output: StudioExpressionFixtureSchema
  })
  .strict();

export const DespinRunNodeOutputFixtureRequestSchema = z
  .object({ fixture_name: WorkflowExpressionFixtureNameSchema })
  .strict();

export type PromoteRunNodeOutputFixtureRequest = z.infer<
  typeof PromoteRunNodeOutputFixtureRequestSchema
>;
export type EditRunNodeOutputFixtureRequest = z.infer<
  typeof EditRunNodeOutputFixtureRequestSchema
>;
export type DespinRunNodeOutputFixtureRequest = z.infer<
  typeof DespinRunNodeOutputFixtureRequestSchema
>;
export type WorkflowExpressionFixtureSource = z.infer<
  typeof WorkflowExpressionFixtureSourceSchema
>;
export type WorkflowExpressionFixtures = Readonly<Record<string, JsonValue>>;
export type WorkflowExpressionFixtureSources = Readonly<
  Record<string, WorkflowExpressionFixtureSource>
>;

function isRecord(
  value: JsonValue | undefined
): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workflowSidecar(
  layout: JsonValue | undefined
): Record<string, JsonValue> | undefined {
  return isRecord(layout) && isRecord(layout.workflow)
    ? layout.workflow
    : undefined;
}

export function assertWorkflowExpressionFixtureName(name: string): void {
  if (!WorkflowExpressionFixtureNameSchema.safeParse(name).success) {
    throw new Error(
      "O nome da fixture deve começar com letra ou número e usar no máximo 64 caracteres."
    );
  }
}

export function workflowExpressionFixtures(
  layout: JsonValue | undefined
): WorkflowExpressionFixtures {
  const sidecar = workflowSidecar(layout);
  if (!isRecord(sidecar?.expression_fixtures)) return {};

  const fixtures: Record<string, JsonValue> = Object.create(null);
  for (const [name, value] of Object.entries(sidecar.expression_fixtures)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const parsedName = WorkflowExpressionFixtureNameSchema.safeParse(name);
    const parsedValue = StudioExpressionFixtureSchema.safeParse(value);
    if (parsedName.success && parsedValue.success) {
      fixtures[parsedName.data] = parsedValue.data;
      if (
        Object.keys(fixtures).length >=
        WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures
      ) break;
    }
  }
  return fixtures;
}

function strictWorkflowExpressionFixtures(
  layout: JsonValue | undefined
): WorkflowExpressionFixtures {
  const sidecar = workflowSidecar(layout);
  if (sidecar?.expression_fixtures === undefined) return {};
  if (!isRecord(sidecar.expression_fixtures)) {
    throw new Error("O sidecar de fixtures do draft é inválido.");
  }
  const entries = Object.entries(sidecar.expression_fixtures);
  if (entries.length > WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures) {
    throw new Error(
      `O draft aceita no máximo ${WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures} fixtures de expression.`
    );
  }
  const fixtures: Record<string, JsonValue> = Object.create(null);
  for (const [name, value] of entries) {
    const parsedName = WorkflowExpressionFixtureNameSchema.safeParse(name);
    const parsedValue = StudioExpressionFixtureSchema.safeParse(value);
    if (!parsedName.success || !parsedValue.success) {
      throw new Error("O sidecar de fixtures do draft é inválido.");
    }
    fixtures[name] = parsedValue.data;
  }
  return fixtures;
}

export function workflowExpressionFixtureSources(
  layout: JsonValue | undefined
): WorkflowExpressionFixtureSources {
  const sidecar = workflowSidecar(layout);
  if (!isRecord(sidecar?.expression_fixture_sources)) return {};

  const fixtureNames = new Set(Object.keys(workflowExpressionFixtures(layout)));
  const sources: Record<string, WorkflowExpressionFixtureSource> =
    Object.create(null);
  for (const [name, value] of Object.entries(
    sidecar.expression_fixture_sources
  )) {
    const parsed = WorkflowExpressionFixtureSourceSchema.safeParse(value);
    if (fixtureNames.has(name) && parsed.success) sources[name] = parsed.data;
  }
  return sources;
}

function fixtureLimit(fixtures: WorkflowExpressionFixtures, name: string): void {
  if (
    !Object.hasOwn(fixtures, name) &&
    Object.keys(fixtures).length >=
      WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures
  ) {
    throw new Error(
      `O draft aceita no máximo ${WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures} fixtures de expression.`
    );
  }
}

export function withWorkflowExpressionFixture(
  layout: JsonValue | undefined,
  name: string,
  value: JsonValue,
  source?: WorkflowExpressionFixtureSource
): JsonValue {
  assertWorkflowExpressionFixtureName(name);
  const fixtureName = name;
  const fixture = StudioExpressionFixtureSchema.parse(value);
  const fixtures = strictWorkflowExpressionFixtures(layout);
  fixtureLimit(fixtures, fixtureName);

  const root = isRecord(layout) ? { ...layout } : {};
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {};
  // Provenance is an authorization boundary, so legacy or malformed entries
  // fail closed instead of making otherwise-valid preview data immutable.
  // The lenient projection retains only sources valid under the current schema.
  const sources = { ...workflowExpressionFixtureSources(layout) };
  if (source === undefined) Reflect.deleteProperty(sources, fixtureName);
  else sources[fixtureName] = WorkflowExpressionFixtureSourceSchema.parse(source);

  const nextWorkflow: Record<string, JsonValue> = {
    ...workflow,
    expression_fixtures: { ...fixtures, [fixtureName]: fixture }
  };
  if (Object.keys(sources).length === 0) {
    Reflect.deleteProperty(nextWorkflow, "expression_fixture_sources");
  } else {
    nextWorkflow.expression_fixture_sources = sources;
  }
  return { ...root, workflow: nextWorkflow };
}

export function withoutWorkflowExpressionFixture(
  layout: JsonValue | undefined,
  name: string
): JsonValue {
  const fixtures = { ...strictWorkflowExpressionFixtures(layout) };
  const sources = { ...workflowExpressionFixtureSources(layout) };
  Reflect.deleteProperty(fixtures, name);
  Reflect.deleteProperty(sources, name);
  const root = isRecord(layout) ? { ...layout } : {};
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {};
  const nextWorkflow: Record<string, JsonValue> = { ...workflow };

  if (Object.keys(fixtures).length === 0) {
    Reflect.deleteProperty(nextWorkflow, "expression_fixtures");
  } else {
    nextWorkflow.expression_fixtures = fixtures;
  }
  if (Object.keys(sources).length === 0) {
    Reflect.deleteProperty(nextWorkflow, "expression_fixture_sources");
  } else {
    nextWorkflow.expression_fixture_sources = sources;
  }
  return { ...root, workflow: nextWorkflow };
}

export function runNodeOutputExpressionFixture(
  nodeId: string,
  value: JsonValue
): JsonValue {
  const safeNodeId = WorkflowExpressionFixtureNodeIdSchema.parse(nodeId);
  return StudioExpressionFixtureSchema.parse({
    invocation: {},
    config: {},
    steps: Object.fromEntries([[safeNodeId, value]]),
    workspace: {}
  });
}
