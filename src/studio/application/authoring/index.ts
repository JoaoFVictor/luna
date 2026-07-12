export { replaceYamlValueAtPath } from "./yaml-source-editor.js";
export { applyYamlSourceOperations } from "./yaml-structural-editor.js";
export { projectYamlSourceValue } from "./yaml-source-document.js";
export type {
  ApplyYamlSourceOperationsInput,
  ApplyYamlSourceOperationsResult,
  ReplaceYamlValueApplied,
  ReplaceYamlValueFailure,
  ReplaceYamlValueInput,
  ReplaceYamlValueNoop,
  ReplaceYamlValueResult,
  ReplaceYamlValueSuccess,
  YamlPathSegment,
  YamlSourceDiagnostic,
  YamlSourcePosition,
  YamlSourceRange,
  YamlTextEdit,
  YamlSourceOperation,
  YamlValuePath
} from "./yaml-source-types.js";
