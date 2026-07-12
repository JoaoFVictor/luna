import { z } from "zod";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  runGraphOutcomeMatchesProof,
  StoredRunGraphOutcomeSchema,
  type StoredRunGraphOutcome
} from "../../application/runs/graph-snapshot.js";
import {
  AppendRunTransitionInputSchema,
  type AppendRunTransitionInput
} from "../../application/runs/ports.js";
import {
  RunOpaqueIdSchema,
  RunTerminalStatusSchema
} from "../../contracts/runs.js";
import { StudioDigestSchema } from "../../contracts/digests.js";

const TerminalIntentShape = {
  schema_version: z.literal(1),
  run_id: RunOpaqueIdSchema,
  command: AppendRunTransitionInputSchema,
  outcome: StoredRunGraphOutcomeSchema.optional()
} as const;

function validateTerminalIntent(
  intent: z.infer<z.ZodObject<typeof TerminalIntentShape>>,
  context: z.RefinementCtx
): void {
    const transition = intent.command.transition;
    if (
      intent.command.run_id !== intent.run_id ||
      transition.kind !== "runtime_status" ||
      !RunTerminalStatusSchema.safeParse(transition.status).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "Terminal intent must contain a terminal transition for its run"
      });
      return;
    }

    const expectedRevision = intent.command.expected_revision + 1;
    if (!Number.isSafeInteger(expectedRevision)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command", "expected_revision"],
        message: "Terminal intent revision is exhausted"
      });
    }
    if (intent.outcome === undefined) {
      if (
        transition.completeness !== "partial" ||
        transition.outcome_proof !== undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command", "transition", "completeness"],
          message: "A terminal transition without an outcome must be partial and unproved"
        });
      }
      return;
    }
    if (
      (transition.completeness !== "complete" &&
        transition.completeness !== "partial") ||
      transition.outcome_proof === undefined ||
      !runGraphOutcomeMatchesProof(
        intent.outcome,
        transition.outcome_proof
      ) ||
      intent.outcome.identity.run_id !== intent.run_id ||
      intent.outcome.record_revision !== expectedRevision ||
      intent.outcome.run_status !== transition.status
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Terminal outcome must exactly match its terminal proof"
      });
    }
}

const TerminalIntentMaterialSchema = z
  .object(TerminalIntentShape)
  .strict()
  .superRefine(validateTerminalIntent);

export const NativeStudioRunTerminalIntentSchema =
  z.object({
    ...TerminalIntentShape,
    intent_hash: StudioDigestSchema
  })
    .strict()
    .superRefine(validateTerminalIntent)
    .superRefine((intent, context) => {
      const material = {
        schema_version: intent.schema_version,
        run_id: intent.run_id,
        command: intent.command,
        ...(intent.outcome === undefined ? {} : { outcome: intent.outcome })
      };
      if (intent.intent_hash !== sha256Digest(material)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intent_hash"],
          message: "Terminal intent failed integrity validation"
        });
      }
    });

export type NativeStudioRunTerminalIntent = z.infer<
  typeof NativeStudioRunTerminalIntentSchema
>;

export function createNativeStudioRunTerminalIntent(input: {
  readonly runId: string;
  readonly command: AppendRunTransitionInput;
  readonly outcome?: StoredRunGraphOutcome;
}): NativeStudioRunTerminalIntent {
  const material = TerminalIntentMaterialSchema.parse({
    schema_version: 1,
    run_id: input.runId,
    command: input.command,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome })
  });
  return NativeStudioRunTerminalIntentSchema.parse({
    ...material,
    intent_hash: sha256Digest(material)
  });
}
