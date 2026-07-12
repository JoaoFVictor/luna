import {
  lstat,
  mkdir,
  realpath
} from "node:fs/promises";
import path from "node:path";

export type PathSecurityError = Error & {
  code: "path_security_violation";
};

function pathSecurityError(message: string): PathSecurityError {
  const error = new Error(message) as PathSecurityError;
  error.code = "path_security_violation";

  return error;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-._]{2,}/g, "-");

  return slug === "" ? "unknown" : slug;
}

export function assertSafeSegment(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    path.isAbsolute(segment) ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    throw pathSecurityError(`Unsafe path segment: ${segment}`);
  }
}

export function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  const [firstSegment] = relative.split(path.sep);

  return relative === "" || (firstSegment !== ".." && !path.isAbsolute(relative));
}

async function realpathNearestExisting(
  candidate: string
): Promise<{ ancestorReal: string; missingSegments: string[] }> {
  const missingSegments: string[] = [];
  let current = candidate;

  while (true) {
    let exists = false;
    try {
      await lstat(current);
      exists = true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw cause;
      }
    }

    if (exists) {
      try {
        return {
          ancestorReal: await realpath(current),
          missingSegments: missingSegments.reverse()
        };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          throw pathSecurityError(
            "Existing path cannot be resolved; it may contain a dangling symbolic link"
          );
        }
        throw cause;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw pathSecurityError(`No existing ancestor for path: ${candidate}`);
    }

    missingSegments.push(path.basename(current));
    current = parent;
  }
}

export async function safeJoin(
  root: string,
  segments: readonly string[]
): Promise<string> {
  for (const segment of segments) {
    assertSafeSegment(segment);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await resolvePathInsideRoot(root, segments);
}

export async function resolvePathInsideRoot(
  root: string,
  segments: readonly string[]
): Promise<string> {
  for (const segment of segments) {
    assertSafeSegment(segment);
  }

  const rootReal = await realpath(root);
  const candidate = path.resolve(root, ...segments);
  const { ancestorReal, missingSegments } = await realpathNearestExisting(candidate);
  const candidateReal = path.join(ancestorReal, ...missingSegments);

  if (!isInsideRoot(rootReal, candidateReal)) {
    throw pathSecurityError("Resolved path is outside the root");
  }

  // Return the physical path derived from the validated existing ancestor so
  // the caller does not retain the logical symlink alias used for resolution.
  // This is a point-in-time check, not an openat-style capability: callers that
  // admit concurrent same-principal filesystem mutation must additionally pin
  // and compare opened-file identity before consuming the path.
  return candidateReal;
}
