import YAML, {
  LineCounter,
  type Document,
  type ParsedNode,
  type YAMLError
} from "yaml";
import {
  assertJsonValue,
  type JsonValue
} from "../../../core/json/value.js";
import type {
  YamlSourceDiagnostic,
  YamlSourceRange
} from "./yaml-source-types.js";

export type ParsedYamlSource = {
  readonly document: Document.Parsed<ParsedNode>;
  readonly lineCounter: LineCounter;
};

export function yamlSourceRange(
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
    range: yamlSourceRange(
      lineCounter,
      sourceLength,
      error.pos[0],
      error.pos[1]
    )
  };
}

export function parseYamlSource(source: string):
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
    // document catches dangling aliases and bounded alias expansion.
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

export function yamlSourceWarnings(
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

export function projectYamlSourceValue(source: string):
  | {
      readonly ok: true;
      readonly value: JsonValue;
      readonly diagnostics: readonly YamlSourceDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly YamlSourceDiagnostic[];
    } {
  const parsed = parseYamlSource(source);
  if (!parsed.ok) return parsed;
  try {
    const value = parsed.value.document.toJS({ maxAliasCount: 100 });
    assertJsonValue(value, "$");
    return {
      ok: true,
      value,
      diagnostics: yamlSourceWarnings(parsed.value, source.length)
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "yaml_value_invalid",
          message:
            error instanceof Error
              ? error.message
              : "The YAML source is not JSON-compatible."
        }
      ]
    };
  }
}
