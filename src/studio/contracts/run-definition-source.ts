import { z } from "zod";

export const StudioRunDefinitionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installed") }).strict(),
  z
    .object({
      kind: z.literal("draft"),
      draft_id: z.string().uuid(),
      etag: z.string().min(1).max(512)
    })
    .strict()
]);

export type StudioRunDefinitionSource = z.infer<
  typeof StudioRunDefinitionSourceSchema
>;
