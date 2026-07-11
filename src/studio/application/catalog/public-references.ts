import path from "node:path";
import { isInsideRoot } from "../../../core/security/path.js";
import { StudioCatalogReferenceSchema } from "../../contracts/catalog-references.js";

function referenceError(label: string): Error & { code: string } {
  const error = new Error(
    `Studio catalog cannot expose the ${label} reference.`
  ) as Error & { code: string };
  error.code = "studio_catalog_reference_invalid";
  return error;
}

export function publicCatalogReference(
  reference: string,
  label: string
): string {
  const parsed = StudioCatalogReferenceSchema.safeParse(reference);
  if (!parsed.success) {
    throw referenceError(label);
  }
  return parsed.data;
}

export function relativeCatalogFileReference(
  resourceDirectory: string,
  reference: string,
  label: string
): string {
  const root = path.resolve(resourceDirectory);
  const resolved = path.resolve(root, reference);
  if (!isInsideRoot(root, resolved)) {
    throw referenceError(label);
  }

  const relative = path.relative(root, resolved).split(path.sep).join("/");
  return publicCatalogReference(relative, label);
}
