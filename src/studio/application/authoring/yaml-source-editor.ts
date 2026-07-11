import { isDeepStrictEqual } from "node:util";
import YAML, {
  LineCounter,
  isAlias,
  type Document,
  type Node,
  type ParsedNode,
  type YAMLError
} from "yaml";
import { assertJsonValue } from "../../../core/json/value.js";
import {
  resolveYamlValuePath,
  validateYamlValuePath
} from "./yaml-source-path.js";
import { renderYamlReplacement } from "./yaml-source-render.js";
import type {
  ReplaceYamlValueFailure,
  ReplaceYamlValueInput,
  ReplaceYamlValueResult,
  YamlSourceDiagnostic,
  YamlSourceRange,
  YamlValuePath
} from "./yaml-source-types.js";

type ParsedYamlSource = {
  readonly document: Document.Parsed<ParsedNode>;
  readonly lineCounter: LineCounter;
};

function sourceRange(
  lineCounter: LineCounter,
  sourceLength: number,
  startOffset: number,
  endOffset: number
): YamlSourceRange {
  const start = Math.max(0, Math.min(sourceLength, startOffset));
  const end = Math.max(start, Math.min(sourceLength, endOffset));
  const startPosition = lineCounter.linePos(start);
  const endPosition = lineCounter.linePos(end);
  return {
    start: {
      offset: start,
      line: startPosition.line,
      column: startPosition.col
    },
    end: {
      offset: end,
      line: endPosition.line,
      column: endPosition.col
    }
  };
}

function yamlErrorDiagnostic(
  error: YAMLError,
  severity: "error" | "warning",
  lineCounter: LineCounter,
  sourceLength: number
): YamlSourceDiagnostic {
  return {
    severity,
    code: severity === "error" ? "yaml_parse_error" : "yaml_parse_warning",
    message: error.message,
    range: sourceRange(
      lineCounter,
      sourceLength,
      error.pos[0],
      error.pos[1]
    )
  };
}

function parseYamlSource(source: string):
  | { readonly ok: true; readonly value: ParsedYamlSource }
  | {
      readonly ok: false;
      readonly diagnostics: readonly YamlSourceDiagnostic[];
    } {
  const lineCounter = new LineCounter();
  let document: Document.Parsed<ParsedNode>;
  try {
    document = YAML.parseDocument(source, {
      keepSourceTokens: true,
      lineCounter,
      prettyErrors: false
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "yaml_parse_error",
          message:
            error instanceof Error ? error.message : "YAML parsing failed."
        }
      ]
    };
  }

  const errors = document.errors.map((error) =>
    yamlErrorDiagnostic(error, "error", lineCounter, source.length)
  );
  if (errors.length > 0) {
    return { ok: false, diagnostics: errors };
  }

  try {
    // Parsing alone does not resolve aliases. Materializing the complete
    // document catches dangling aliases (including ones left outside a
    // minimally replaced range) and excessive alias expansion before an edit
    // can be reported as safe.
    document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "yaml_parse_error",
          message:
            error instanceof Error
              ? error.message
              : "YAML semantic resolution failed."
        }
      ]
    };
  }

  return { ok: true, value: { document, lineCounter } };
}

function warnings(
  parsed: ParsedYamlSource,
  sourceLength: number
): readonly YamlSourceDiagnostic[] {
  return parsed.document.warnings.map((warning) =>
    yamlErrorDiagnostic(
      warning,
      "warning",
      parsed.lineCounter,
      sourceLength
    )
  );
}

function failure(
  source: string,
  diagnostics: readonly YamlSourceDiagnostic[],
  targetRange?: YamlSourceRange
): ReplaceYamlValueFailure {
  return {
    ok: false,
    changed: false,
    source,
    ...(targetRange === undefined ? {} : { targetRange }),
    diagnostics
  };
}

function unsafeTargetReason(node: Node): string | undefined {
  if (isAlias(node)) {
    return "YAML aliases do not own the source value they reference.";
  }
  if (node.range === undefined || node.range === null) {
    return "The YAML value does not expose a parsed source range.";
  }
  if (node.range[0] === node.range[1]) {
    return "Implicit empty YAML values cannot be replaced with a value-only edit.";
  }
  if (node.anchor !== undefined) {
    return "Anchored YAML values require an explicit anchor-aware edit.";
  }
  if (node.tag !== undefined) {
    return "Explicitly tagged YAML values require an explicit tag-aware edit.";
  }
  return undefined;
}

function resolvedValue(node: Node, document: Document.Parsed<ParsedNode>): unknown {
  return node.toJS(document);
}

function validateReplacementValue(
  source: string,
  path: YamlValuePath,
  value: unknown,
  targetRange: YamlSourceRange
): ReplaceYamlValueFailure | undefined {
  try {
    assertJsonValue(value, "$.value");
    return undefined;
  } catch (error) {
    return failure(
      source,
      [
        {
          severity: "error",
          code: "yaml_value_invalid",
          message:
            error instanceof Error
              ? error.message
              : "The replacement value is not valid JSON.",
          path,
          range: targetRange
        }
      ],
      targetRange
    );
  }
}

export function replaceYamlValueAtPath(
  input: ReplaceYamlValueInput
): ReplaceYamlValueResult {
  const pathError = validateYamlValuePath(input.path);
  if (pathError !== undefined) {
    return failure(input.source, [pathError]);
  }

  const parsed = parseYamlSource(input.source);
  if (!parsed.ok) {
    return failure(input.source, parsed.diagnostics);
  }

  const resolved = resolveYamlValuePath(
    parsed.value.document.contents,
    input.path
  );
  if (!resolved.ok) {
    return failure(input.source, [resolved.diagnostic]);
  }

  if (resolved.node.range === undefined || resolved.node.range === null) {
    return failure(input.source, [
      {
        severity: "error",
        code: "yaml_target_unsafe",
        message: "The YAML value does not expose a parsed source range.",
        path: input.path
      }
    ]);
  }

  const [startOffset, endOffset] = resolved.node.range;
  const targetRange = sourceRange(
    parsed.value.lineCounter,
    input.source.length,
    startOffset,
    endOffset
  );
  const invalidValue = validateReplacementValue(
    input.source,
    input.path,
    input.value,
    targetRange
  );
  if (invalidValue !== undefined) {
    return invalidValue;
  }

  if (
    isDeepStrictEqual(
      resolvedValue(resolved.node, parsed.value.document),
      input.value
    )
  ) {
    return {
      ok: true,
      changed: false,
      source: input.source,
      targetRange,
      diagnostics: warnings(parsed.value, input.source.length)
    };
  }

  const unsafeReason = unsafeTargetReason(resolved.node);
  if (unsafeReason !== undefined) {
    return failure(
      input.source,
      [
        {
          severity: "error",
          code: "yaml_target_unsafe",
          message: unsafeReason,
          path: input.path,
          range: targetRange
        }
      ],
      targetRange
    );
  }

  const replacement = renderYamlReplacement(
    parsed.value.document,
    resolved.node,
    input.source,
    startOffset,
    endOffset,
    input.value
  );
  const updatedSource =
    input.source.slice(0, startOffset) +
    replacement +
    input.source.slice(endOffset);
  const reparsed = parseYamlSource(updatedSource);
  if (!reparsed.ok) {
    return failure(input.source, reparsed.diagnostics, targetRange);
  }

  const updatedTarget = resolveYamlValuePath(
    reparsed.value.document.contents,
    input.path
  );
  if (
    !updatedTarget.ok ||
    !isDeepStrictEqual(
      resolvedValue(updatedTarget.node, reparsed.value.document),
      input.value
    )
  ) {
    return failure(
      input.source,
      [
        {
          severity: "error",
          code: "yaml_replacement_invalid",
          message:
            "The minimal YAML edit did not preserve the requested replacement value.",
          path: input.path,
          range: targetRange
        }
      ],
      targetRange
    );
  }

  return {
    ok: true,
    changed: true,
    source: updatedSource,
    targetRange,
    edit: { range: targetRange, replacement },
    diagnostics: warnings(reparsed.value, updatedSource.length)
  };
}
