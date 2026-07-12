export type StudioNodeFieldPathSegment = string | number;

const NODE_PREFIX = /^\$\.nodes\[\d+\]/u;
const FIELD_SEGMENT = /^(?:\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\])/u;

/**
 * Converts the canonical workflow JSONPath into an index-independent path
 * relative to a node. Ownership is deliberately established by nodeId; the
 * numeric index in fieldPath is never used to identify a node.
 */
export function projectStudioNodeFieldPath(
  fieldPath: string | undefined,
  nodeId: string | undefined
): readonly StudioNodeFieldPathSegment[] | undefined {
  if (fieldPath === undefined || nodeId === undefined) return undefined;
  const prefix = fieldPath.match(NODE_PREFIX)?.[0];
  if (prefix === undefined) return undefined;

  let remaining = fieldPath.slice(prefix.length);
  const result: StudioNodeFieldPathSegment[] = [];
  while (remaining.length > 0) {
    const match = remaining.match(FIELD_SEGMENT);
    if (match === null) return undefined;
    result.push(match[1] ?? Number(match[2]));
    remaining = remaining.slice(match[0].length);
  }
  return result.length === 0 ? undefined : result;
}
