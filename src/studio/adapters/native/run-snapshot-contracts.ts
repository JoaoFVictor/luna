import { z } from "zod";
import { WorkflowIdSchema } from "../../../core/router/invocation.js";
import { StudioDigestSchema } from "../../contracts/digests.js";

export const NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 512,
  maxDirectories: 512,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxRelativePathBytes: 1_024
} as const);

const RelativeSnapshotPathSchema = z
  .string()
  .min(1)
  .max(NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxRelativePathBytes)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every(
        (segment) => segment !== "" && segment !== "." && segment !== ".."
      ),
    "Snapshot paths must be normalized relative POSIX paths"
  );

export const NativeStudioRunSnapshotFileManifestSchema = z
  .object({
    root: z.enum(["project", "config"]),
    path: RelativeSnapshotPathSchema,
    sha256: StudioDigestSchema,
    mode: z.number().int().min(0).max(0o777),
    bytes: z.number().int().safe().nonnegative().max(
      NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxFileBytes
    )
  })
  .strict();
export type NativeStudioRunSnapshotFileManifest = z.infer<
  typeof NativeStudioRunSnapshotFileManifestSchema
>;

export const NativeStudioRunSnapshotManifestSchema = z
  .object({
    schema_version: z.literal(1),
    workflow_id: WorkflowIdSchema,
    bundle_hash: StudioDigestSchema,
    total_bytes: z.number().int().safe().nonnegative().max(
      NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxTotalBytes
    ),
    files: z
      .array(NativeStudioRunSnapshotFileManifestSchema)
      .min(1)
      .max(NATIVE_STUDIO_RUN_SNAPSHOT_LIMITS.maxFiles)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const keys = snapshot.files.map((file) => `${file.root}/${file.path}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "Snapshot file paths must be unique"
      });
    }
    const total = snapshot.files.reduce((sum, file) => sum + file.bytes, 0);
    if (total !== snapshot.total_bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total_bytes"],
        message: "Snapshot byte total does not match its file manifest"
      });
    }
  });
export type NativeStudioRunSnapshotManifest = z.infer<
  typeof NativeStudioRunSnapshotManifestSchema
>;

export type NativeStudioRunSnapshotFile =
  NativeStudioRunSnapshotFileManifest & {
    readonly content: Buffer;
  };

export type NativeStudioRunSnapshot = Omit<
  NativeStudioRunSnapshotManifest,
  "files"
> & {
  readonly files: readonly NativeStudioRunSnapshotFile[];
};
export type NativeStudioRunDispatchPayload = {
  readonly snapshot: NativeStudioRunSnapshot;
};
