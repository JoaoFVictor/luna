import { z } from "zod";

const RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isCanonicalRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".."
  );
}

export const StudioRootSchema = z.enum(["project", "config"]);
export type StudioRoot = z.infer<typeof StudioRootSchema>;

export const StudioRelativePathSchema = z
  .string()
  .max(1024)
  .refine(isCanonicalRelativePath, {
    message: "Path must be a canonical relative POSIX path"
  });

export const StudioPathSchema = z
  .object({
    root: StudioRootSchema,
    path: StudioRelativePathSchema
  })
  .strict();
export type StudioPath = z.infer<typeof StudioPathSchema>;

export const StudioResourceRefSchema = z
  .object({
    kind: z.enum(["workflow", "agent", "config"]),
    id: z.string().max(128).regex(RESOURCE_ID_PATTERN)
  })
  .strict();
export type StudioResourceRef = z.infer<typeof StudioResourceRefSchema>;

export function studioPathKey(file: StudioPath): string {
  return `${file.root}:${file.path}`;
}

export function studioResourceKey(resource: StudioResourceRef): string {
  return `${resource.kind}:${resource.id}`;
}
