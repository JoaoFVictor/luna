import { isDeepStrictEqual } from "node:util";
import YAML, { isMap, isNode, isScalar, isSeq, type Node } from "yaml";
import { assertJsonValue, type JsonValue } from "../../../core/json/value.js";
import {
  parseYamlSource,
  type ParsedYamlSource,
  yamlSourceWarnings
} from "./yaml-source-document.js";
import { replaceYamlValueAtPath } from "./yaml-source-editor.js";
import {
  resolveYamlValuePath,
  validateYamlValuePath
} from "./yaml-source-path.js";
import { renderYamlReplacement } from "./yaml-source-render.js";
import type {
  ApplyYamlSourceOperationsInput,
  ApplyYamlSourceOperationsResult,
  YamlSourceDiagnostic,
  YamlSourceOperation,
  YamlValuePath
} from "./yaml-source-types.js";

type MutationFailure = {
  readonly ok: false;
  readonly diagnostics: readonly YamlSourceDiagnostic[];
};

type MutationResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly source: string;
      readonly diagnostics: readonly YamlSourceDiagnostic[];
    }
  | MutationFailure;

function diagnostic(
  code: YamlSourceDiagnostic["code"],
  message: string,
  path: YamlValuePath
): MutationFailure {
  return {
    ok: false,
    diagnostics: [{ severity: "error", code, message, path }]
  };
}

function lineEnding(source: string): string {
  return source.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
}

function lineStart(source: string, offset: number): number {
  const lf = source.lastIndexOf("\n", Math.max(0, offset - 1));
  const cr = source.lastIndexOf("\r", Math.max(0, offset - 1));
  return Math.max(lf, cr) + 1;
}

function startsWithLineEnding(source: string): boolean {
  return source.startsWith("\n") || source.startsWith("\r");
}

function endsWithLineEnding(source: string): boolean {
  return source.endsWith("\n") || source.endsWith("\r");
}

function indentFragment(fragment: string, indentation: number, eol: string): string {
  const prefix = " ".repeat(indentation);
  return fragment.replace(/\r\n|\n|\r/gu, `${eol}${prefix}`);
}

function insertIndentedBlock(
  source: string,
  offset: number,
  rendered: string,
  indentation: number,
  eol: string
): string {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const prefix = endsWithLineEnding(before) ? "" : eol;
  const suffix =
    (after.length > 0 && !startsWithLineEnding(after)) ||
    (after.length === 0 && endsWithLineEnding(source))
      ? eol
      : "";
  const fragment = indentFragment(rendered, indentation, eol);
  return `${before}${prefix}${" ".repeat(indentation)}${fragment}${suffix}${after}`;
}

function renderFragment(
  parsed: ParsedYamlSource,
  value: JsonValue
): string {
  const document = new YAML.Document(value, {
    version: parsed.document.directives.yaml.version
  });
  return document.toString({ lineWidth: 0 }).replace(/(?:\r\n|\n|\r)$/u, "");
}

function mapWithOwnKey(key: string, value: JsonValue): Record<string, JsonValue> {
  const result = Object.create(null) as Record<string, JsonValue>;
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  });
  return result;
}

function replaceResolvedNode(
  source: string,
  parsed: ParsedYamlSource,
  target: Node,
  value: JsonValue,
  path: YamlValuePath
): MutationResult {
  if (target.range === undefined || target.range === null) {
    return diagnostic(
      "yaml_target_unsafe",
      "The YAML value does not expose a parsed source range.",
      path
    );
  }
  if (target.anchor !== undefined || target.tag !== undefined) {
    return diagnostic(
      "yaml_target_unsafe",
      "Anchored or explicitly tagged YAML values require an anchor-aware edit.",
      path
    );
  }
  const current = target.toJS(parsed.document);
  if (isDeepStrictEqual(current, value)) {
    return {
      ok: true,
      changed: false,
      source,
      diagnostics: yamlSourceWarnings(parsed, source.length)
    };
  }
  const [startOffset, endOffset] = target.range;
  const replacement = renderYamlReplacement(
    parsed.document,
    target,
    source,
    startOffset,
    endOffset,
    value
  );
  const updated =
    source.slice(0, startOffset) + replacement + source.slice(endOffset);
  const reparsed = parseYamlSource(updated);
  if (!reparsed.ok) {
    return { ok: false, diagnostics: reparsed.diagnostics };
  }
  return {
    ok: true,
    changed: true,
    source: updated,
    diagnostics: yamlSourceWarnings(reparsed.value, updated.length)
  };
}

function parentPath(path: YamlValuePath): YamlValuePath {
  return path.slice(0, -1);
}

function requireParsed(source: string):
  | { readonly ok: true; readonly parsed: ParsedYamlSource }
  | { readonly ok: false; readonly diagnostics: readonly YamlSourceDiagnostic[] } {
  const parsed = parseYamlSource(source);
  return parsed.ok
    ? { ok: true, parsed: parsed.value }
    : { ok: false, diagnostics: parsed.diagnostics };
}

function resolveParent(
  parsed: ParsedYamlSource,
  path: YamlValuePath
): ReturnType<typeof resolveYamlValuePath> {
  const targetPath = parentPath(path);
  if (targetPath.length === 0) {
    return parsed.document.contents === null
      ? {
          ok: false,
          diagnostic: {
            severity: "error",
            code: "yaml_path_not_found",
            message: "The YAML document is empty.",
            path
          }
        }
      : { ok: true, node: parsed.document.contents };
  }
  return resolveYamlValuePath(parsed.document.contents, targetPath);
}

function mappingIndent(source: string, map: Node): number {
  if (map.range === undefined || map.range === null) return 0;
  return map.range[0] - lineStart(source, map.range[0]);
}

function insertBlockMappingEntry(
  source: string,
  parsed: ParsedYamlSource,
  target: Node,
  key: string,
  value: JsonValue,
  path: YamlValuePath
): MutationResult {
  if (!isMap(target) || target.range === undefined || target.range === null) {
    return diagnostic(
      "yaml_path_type_mismatch",
      "A missing YAML value can only be created inside a mapping.",
      path
    );
  }
  if (target.flow === true || target.items.length === 0) {
    const current = target.toJS(parsed.document);
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return diagnostic("yaml_path_type_mismatch", "Expected a YAML mapping.", path);
    }
    const next = Object.assign(Object.create(null), current) as Record<
      string,
      JsonValue
    >;
    Object.defineProperty(next, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
    return replaceResolvedNode(source, parsed, target, next, parentPath(path));
  }

  const offset = target.range[1];
  const eol = lineEnding(source);
  const rendered = renderFragment(parsed, mapWithOwnKey(key, value));
  const updated = insertIndentedBlock(
    source,
    offset,
    rendered,
    mappingIndent(source, target),
    eol
  );
  const reparsed = parseYamlSource(updated);
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  return {
    ok: true,
    changed: true,
    source: updated,
    diagnostics: yamlSourceWarnings(reparsed.value, updated.length)
  };
}

function setValue(
  source: string,
  path: YamlValuePath,
  value: JsonValue
): MutationResult {
  const replaced = replaceYamlValueAtPath({ source, path, value });
  if (replaced.ok) return replaced;
  if (!replaced.diagnostics.some((item) => item.code === "yaml_path_not_found")) {
    return { ok: false, diagnostics: replaced.diagnostics };
  }
  const finalSegment = path.at(-1);
  if (typeof finalSegment !== "string") {
    return { ok: false, diagnostics: replaced.diagnostics };
  }
  const loaded = requireParsed(source);
  if (!loaded.ok) return loaded;
  const parent = resolveParent(loaded.parsed, path);
  if (!parent.ok) return { ok: false, diagnostics: [parent.diagnostic] };
  return insertBlockMappingEntry(
    source,
    loaded.parsed,
    parent.node,
    finalSegment,
    value,
    path
  );
}

function mapPairIndex(target: Node, key: string): number {
  if (!isMap(target)) return -1;
  return target.items.findIndex(
    (pair) => isScalar(pair.key) && pair.key.value === key
  );
}

function deleteMapEntry(
  source: string,
  parsed: ParsedYamlSource,
  target: Node,
  key: string,
  path: YamlValuePath
): MutationResult {
  if (!isMap(target)) {
    return diagnostic(
      "yaml_path_type_mismatch",
      "A string path segment can only be deleted from a YAML mapping.",
      path
    );
  }
  const pairIndex = mapPairIndex(target, key);
  if (pairIndex < 0) {
    return diagnostic(
      "yaml_path_not_found",
      `YAML mapping key ${JSON.stringify(key)} was not found.`,
      path
    );
  }
  if (target.flow === true || target.items.length === 1) {
    const current = target.toJS(parsed.document) as Record<string, JsonValue>;
    const next = Object.assign(Object.create(null), current) as Record<
      string,
      JsonValue
    >;
    Reflect.deleteProperty(next, key);
    return replaceResolvedNode(source, parsed, target, next, parentPath(path));
  }

  const pair = target.items[pairIndex]!;
  if (
    !isScalar(pair.key) ||
    pair.key.range === undefined ||
    pair.key.range === null
  ) {
    return diagnostic("yaml_target_unsafe", "The YAML key has no safe source range.", path);
  }
  const valueEnd = isNode(pair.value)
    ? (pair.value.range?.[2] ?? pair.value.range?.[1])
    : undefined;
  const keyEnd = pair.key.range[2] ?? pair.key.range[1];
  let start = lineStart(source, pair.key.range[0]);
  let end = valueEnd ?? keyEnd;
  const prefixOnLine = source.slice(start, pair.key.range[0]);
  if (/^\s*-\s*$/u.test(prefixOnLine)) {
    const nextPair = target.items[pairIndex + 1];
    if (
      nextPair === undefined ||
      !isScalar(nextPair.key) ||
      nextPair.key.range === undefined ||
      nextPair.key.range === null
    ) {
      return diagnostic(
        "yaml_target_unsafe",
        "The first key of a sequence mapping cannot be deleted safely.",
        path
      );
    }
    start = pair.key.range[0];
    end = nextPair.key.range[0];
  }
  const updated = source.slice(0, start) + source.slice(end);
  const reparsed = parseYamlSource(updated);
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  return {
    ok: true,
    changed: true,
    source: updated,
    diagnostics: yamlSourceWarnings(reparsed.value, updated.length)
  };
}

function sequenceValue(
  target: Node,
  parsed: ParsedYamlSource,
  path: YamlValuePath
):
  | { readonly ok: true; readonly values: readonly JsonValue[] }
  | { readonly ok: false; readonly diagnostics: readonly YamlSourceDiagnostic[] } {
  if (!isSeq(target)) {
    return diagnostic(
      "yaml_path_type_mismatch",
      "The YAML operation requires a sequence target.",
      path
    );
  }
  const value = target.toJS(parsed.document);
  if (!Array.isArray(value)) {
    return diagnostic(
      "yaml_path_type_mismatch",
      "Expected a YAML sequence.",
      path
    );
  }
  return { ok: true, values: value as JsonValue[] };
}

function sequenceIndent(source: string, target: Node): number {
  if (!isSeq(target) || target.items.length === 0) return 0;
  const first = target.items[0];
  if (!isNode(first) || first.range === undefined || first.range === null) return 0;
  const start = lineStart(source, first.range[0]);
  const prefix = source.slice(start, first.range[0]);
  const marker = prefix.lastIndexOf("-");
  return marker < 0 ? Math.max(0, prefix.length - 2) : marker;
}

function insertSequenceItem(
  source: string,
  path: YamlValuePath,
  index: number | undefined,
  value: JsonValue
): MutationResult {
  const loaded = requireParsed(source);
  if (!loaded.ok) return loaded;
  const resolved = resolveYamlValuePath(loaded.parsed.document.contents, path);
  if (!resolved.ok) return { ok: false, diagnostics: [resolved.diagnostic] };
  const sequence = sequenceValue(resolved.node, loaded.parsed, path);
  if (!sequence.ok) return { ok: false, diagnostics: sequence.diagnostics };
  const insertionIndex = index ?? sequence.values.length;
  if (!Number.isSafeInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > sequence.values.length) {
    return diagnostic(
      "yaml_operation_invalid",
      `Sequence insertion index ${String(insertionIndex)} is out of bounds.`,
      path
    );
  }
  if (!isSeq(resolved.node)) {
    return diagnostic("yaml_path_type_mismatch", "Expected a YAML sequence.", path);
  }
  if (resolved.node.flow === true || resolved.node.items.length === 0) {
    const next = [...sequence.values];
    next.splice(insertionIndex, 0, value);
    return replaceResolvedNode(source, loaded.parsed, resolved.node, next, path);
  }
  const targetItem = resolved.node.items[insertionIndex];
  const offset =
    !isNode(targetItem) || targetItem.range === undefined || targetItem.range === null
      ? (resolved.node.range?.[1] ?? source.length)
      : lineStart(source, targetItem.range[0]);
  const eol = lineEnding(source);
  const rendered = renderFragment(loaded.parsed, [value]);
  const indentation = sequenceIndent(source, resolved.node);
  const updated = insertIndentedBlock(
    source,
    offset,
    rendered,
    indentation,
    eol
  );
  const reparsed = parseYamlSource(updated);
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  return {
    ok: true,
    changed: true,
    source: updated,
    diagnostics: yamlSourceWarnings(reparsed.value, updated.length)
  };
}

function removeSequenceItem(
  source: string,
  path: YamlValuePath,
  index: number
): MutationResult {
  const loaded = requireParsed(source);
  if (!loaded.ok) return loaded;
  const resolved = resolveYamlValuePath(loaded.parsed.document.contents, path);
  if (!resolved.ok) return { ok: false, diagnostics: [resolved.diagnostic] };
  const sequence = sequenceValue(resolved.node, loaded.parsed, path);
  if (!sequence.ok) return { ok: false, diagnostics: sequence.diagnostics };
  if (!Number.isSafeInteger(index) || index < 0 || index >= sequence.values.length) {
    return diagnostic(
      "yaml_operation_invalid",
      `Sequence removal index ${String(index)} is out of bounds.`,
      path
    );
  }
  if (!isSeq(resolved.node)) {
    return diagnostic("yaml_path_type_mismatch", "Expected a YAML sequence.", path);
  }
  if (resolved.node.flow === true || resolved.node.items.length === 1) {
    const next = [...sequence.values];
    next.splice(index, 1);
    return replaceResolvedNode(source, loaded.parsed, resolved.node, next, path);
  }
  const item = resolved.node.items[index];
  if (!isNode(item) || item.range === undefined || item.range === null) {
    return diagnostic("yaml_target_unsafe", "The YAML sequence item has no safe source range.", path);
  }
  const start = lineStart(source, item.range[0]);
  const end = item.range[2] ?? item.range[1];
  const updated = source.slice(0, start) + source.slice(end);
  const reparsed = parseYamlSource(updated);
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  return {
    ok: true,
    changed: true,
    source: updated,
    diagnostics: yamlSourceWarnings(reparsed.value, updated.length)
  };
}

function deleteValue(source: string, path: YamlValuePath): MutationResult {
  const loaded = requireParsed(source);
  if (!loaded.ok) return loaded;
  const finalSegment = path.at(-1);
  const parent = resolveParent(loaded.parsed, path);
  if (!parent.ok) return { ok: false, diagnostics: [parent.diagnostic] };
  if (typeof finalSegment === "string") {
    return deleteMapEntry(
      source,
      loaded.parsed,
      parent.node,
      finalSegment,
      path
    );
  }
  if (typeof finalSegment === "number") {
    return removeSequenceItem(source, parentPath(path), finalSegment);
  }
  return diagnostic("yaml_path_invalid", "The YAML path is invalid.", path);
}

function applyOperation(source: string, operation: YamlSourceOperation): MutationResult {
  const pathError = validateYamlValuePath(operation.path);
  if (pathError !== undefined) return { ok: false, diagnostics: [pathError] };
  try {
    if (operation.op === "set") {
      assertJsonValue(operation.value, "$.value");
      return setValue(source, operation.path, operation.value);
    }
    if (operation.op === "delete") {
      return deleteValue(source, operation.path);
    }
    if (operation.op === "sequence_insert") {
      assertJsonValue(operation.value, "$.value");
      return insertSequenceItem(
        source,
        operation.path,
        operation.index,
        operation.value
      );
    }
    return removeSequenceItem(source, operation.path, operation.index);
  } catch (error) {
    return diagnostic(
      "yaml_value_invalid",
      error instanceof Error ? error.message : "The YAML edit value is invalid.",
      operation.path
    );
  }
}

export function applyYamlSourceOperations(
  input: ApplyYamlSourceOperationsInput
): ApplyYamlSourceOperationsResult {
  let source = input.source;
  let changed = false;
  let diagnostics: readonly YamlSourceDiagnostic[] = [];
  for (const [operationIndex, operation] of input.operations.entries()) {
    const result = applyOperation(source, operation);
    if (!result.ok) {
      return {
        ok: false,
        changed: false,
        source: input.source,
        operationIndex,
        diagnostics: result.diagnostics
      };
    }
    source = result.source;
    changed ||= result.changed;
    diagnostics = result.diagnostics;
  }
  return { ok: true, changed, source, diagnostics };
}
