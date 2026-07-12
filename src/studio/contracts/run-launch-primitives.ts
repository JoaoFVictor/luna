import { z } from "zod";

export const StudioRunTimestampSchema = z.string().datetime({ offset: true });

export const StudioRunPlanIdSchema = z
  .string()
  .min(25)
  .max(131)
  .regex(/^rp_[A-Za-z0-9_-]{22,128}$/);

export const StudioRunBoundedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

export const StudioRunBoundedDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000);

export const StudioRunOpaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/,
    "Identifier contains unsupported characters"
  );
