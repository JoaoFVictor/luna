import { STUDIO_SCHEMA_PATH_MAX_LENGTH } from "../../contracts/schema-validation.js";

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function appendStudioSchemaPointer(
  base: string,
  segment: string | number
): string {
  const pointer = `${base}/${escapePointerSegment(String(segment))}`;
  return pointer.length <= STUDIO_SCHEMA_PATH_MAX_LENGTH ? pointer : base;
}
