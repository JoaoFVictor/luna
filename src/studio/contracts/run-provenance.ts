import { z } from "zod";
import { StudioDigestSchema } from "./digests.js";
import { StudioRunBoundedIdSchema } from "./run-launch-primitives.js";

export const StudioRunInputProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invocation") }).strict(),
  z
    .object({
      kind: z.literal("adapter"),
      adapter_id: StudioRunBoundedIdSchema,
      adapter_input_hash: StudioDigestSchema
    })
    .strict()
]);
export type StudioRunInputProvenance = z.infer<
  typeof StudioRunInputProvenanceSchema
>;
