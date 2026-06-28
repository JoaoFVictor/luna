import { createHash } from "node:crypto";

export type DefinitionDigestResolver = {
  digestExternalDefinition(reference: string): Promise<string>;
};

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortCanonical(nested)])
  );
}
