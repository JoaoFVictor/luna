import { z } from "zod";
import type { JsonValue } from "../../core/json/value.js";

export const StudioJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(StudioJsonValueSchema),
    z.record(StudioJsonValueSchema)
  ])
);
