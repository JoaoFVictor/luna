import { z } from "zod";

export const StudioDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);
export type StudioDigest = z.infer<typeof StudioDigestSchema>;
