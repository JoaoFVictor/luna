import type { JsonValue } from "../../../core/json/value.js";

export type YamlPathSegment = string | number;
export type YamlValuePath = readonly YamlPathSegment[];

export type YamlSourcePosition = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

export type YamlSourceRange = {
  readonly start: YamlSourcePosition;
  readonly end: YamlSourcePosition;
};

export type YamlSourceDiagnostic = {
  readonly severity: "error" | "warning";
  readonly code:
    | "yaml_parse_error"
    | "yaml_parse_warning"
    | "yaml_path_invalid"
    | "yaml_path_not_found"
    | "yaml_path_type_mismatch"
    | "yaml_path_alias_unsupported"
    | "yaml_target_unsafe"
    | "yaml_value_invalid"
    | "yaml_replacement_invalid";
  readonly message: string;
  readonly path?: YamlValuePath;
  readonly range?: YamlSourceRange;
};

export type YamlTextEdit = {
  readonly range: YamlSourceRange;
  readonly replacement: string;
};

export type ReplaceYamlValueInput = {
  readonly source: string;
  readonly path: YamlValuePath;
  readonly value: JsonValue;
};

type ReplaceYamlValueSuccessBase = {
  readonly ok: true;
  readonly source: string;
  readonly targetRange: YamlSourceRange;
  readonly diagnostics: readonly YamlSourceDiagnostic[];
};

export type ReplaceYamlValueNoop = ReplaceYamlValueSuccessBase & {
  readonly changed: false;
};

export type ReplaceYamlValueApplied = ReplaceYamlValueSuccessBase & {
  readonly changed: true;
  readonly edit: YamlTextEdit;
};

export type ReplaceYamlValueSuccess =
  | ReplaceYamlValueNoop
  | ReplaceYamlValueApplied;

export type ReplaceYamlValueFailure = {
  readonly ok: false;
  readonly changed: false;
  readonly source: string;
  readonly targetRange?: YamlSourceRange;
  readonly diagnostics: readonly YamlSourceDiagnostic[];
};

export type ReplaceYamlValueResult =
  | ReplaceYamlValueSuccess
  | ReplaceYamlValueFailure;
