import { z } from "zod";
import { StudioDigestSchema } from "./digests.js";
import { StudioExpressionFixtureSchema } from "./expression-evaluation.js";
import {
  WorkflowExpressionFixtureNameSchema,
  WorkflowExpressionFixtureSourceSchema
} from "./workflow-expression-fixtures.js";

export const StudioDraftTestDataSelectionSchema = z
  .object({
    fixture_name: WorkflowExpressionFixtureNameSchema
  })
  .strict();
export type StudioDraftTestDataSelection = z.infer<
  typeof StudioDraftTestDataSelectionSchema
>;

export const STUDIO_MANUAL_TEST_DATA_LIMITS = Object.freeze({
  maxActiveFixtures: 16
} as const);

function canonicalSelections<T extends { readonly fixture_name: string }>(
  selections: readonly T[]
): T[] {
  return [...selections].sort((left, right) =>
    left.fixture_name.localeCompare(right.fixture_name)
  );
}

export const StudioDraftTestDataSelectionsSchema = z
  .union([
    StudioDraftTestDataSelectionSchema,
    z.array(StudioDraftTestDataSelectionSchema)
      .min(1)
      .max(STUDIO_MANUAL_TEST_DATA_LIMITS.maxActiveFixtures)
  ])
  .transform((value) => canonicalSelections(Array.isArray(value) ? value : [value]))
  .superRefine((selections, context) => {
    const names = new Set<string>();
    selections.forEach((selection, index) => {
      if (names.has(selection.fixture_name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "fixture_name"],
          message: "The same draft fixture cannot be selected more than once"
        });
      }
      names.add(selection.fixture_name);
    });
  });
export type StudioDraftTestDataSelections = z.infer<
  typeof StudioDraftTestDataSelectionsSchema
>;
export type StudioDraftTestDataSelectionsInput = z.input<
  typeof StudioDraftTestDataSelectionsSchema
>;

export const StudioManualTestDataSummarySchema = z
  .object({
    kind: z.literal("draft_fixture"),
    fixture_name: WorkflowExpressionFixtureNameSchema,
    node_id: z.string().trim().min(1).max(256),
    output_hash: StudioDigestSchema,
    source: WorkflowExpressionFixtureSourceSchema
  })
  .strict();
export type StudioManualTestDataSummary = z.infer<
  typeof StudioManualTestDataSummarySchema
>;

export const StudioManualTestDataSchema =
  StudioManualTestDataSummarySchema.extend({
    output: StudioExpressionFixtureSchema
  })
    .strict()
    .superRefine((value, context) => {
      if (value.source.node_id !== value.node_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source", "node_id"],
          message: "Manual test data source must match its substituted node"
        });
      }
    });
export type StudioManualTestData = z.infer<
  typeof StudioManualTestDataSchema
>;

function canonicalManualTestData<T extends {
  readonly node_id: string;
  readonly fixture_name: string;
}>(testData: readonly T[]): T[] {
  return [...testData].sort((left, right) =>
    left.node_id.localeCompare(right.node_id) ||
    left.fixture_name.localeCompare(right.fixture_name)
  );
}

function manualTestDataListSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .union([
      item,
      z.array(item).min(1).max(STUDIO_MANUAL_TEST_DATA_LIMITS.maxActiveFixtures)
    ])
    .transform((value) => canonicalManualTestData(
      (Array.isArray(value) ? value : [value]) as z.infer<T>[]
    ))
    .superRefine((testData, context) => {
      const nodeIds = new Set<string>();
      testData.forEach((entry, index) => {
        if (nodeIds.has(entry.node_id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "node_id"],
            message: "A workflow node can have only one active manual test output"
          });
        }
        nodeIds.add(entry.node_id);
      });
    });
}

export const StudioManualTestDataListSchema = manualTestDataListSchema(
  StudioManualTestDataSchema
);
export type StudioManualTestDataList = z.infer<
  typeof StudioManualTestDataListSchema
>;

export const StudioRunExecutionProfileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard") }).strict(),
    z
      .object({
        kind: z.literal("manual_test"),
        test_data: StudioManualTestDataListSchema
      })
    .strict()
]);
export type StudioRunExecutionProfile = z.infer<
  typeof StudioRunExecutionProfileSchema
>;

export const StudioRunExecutionProfileSummarySchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("standard") }).strict(),
    z
      .object({
        kind: z.literal("manual_test"),
        test_data: manualTestDataListSchema(StudioManualTestDataSummarySchema)
      })
      .strict()
  ]
);
export type StudioRunExecutionProfileSummary = z.infer<
  typeof StudioRunExecutionProfileSummarySchema
>;

export const STUDIO_STANDARD_EXECUTION_PROFILE_HASH =
  "sha256:58357d4f1b0bc407393348d291fcf08c24b1dc455aa8fde794d79951bc0e90fc";

export function studioManualTestDataSummary(
  value: StudioManualTestData
): StudioManualTestDataSummary {
  const parsed = StudioManualTestDataSchema.parse(value);
  const { output: _output, ...summary } = parsed;
  return StudioManualTestDataSummarySchema.parse(summary);
}

export function studioRunExecutionProfileSummary(
  value: StudioRunExecutionProfile
): StudioRunExecutionProfileSummary {
  const profile = StudioRunExecutionProfileSchema.parse(value);
  return profile.kind === "standard"
    ? { kind: "standard" }
    : {
        kind: "manual_test",
        test_data: profile.test_data.map(studioManualTestDataSummary)
      };
}
