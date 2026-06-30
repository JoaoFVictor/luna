export type SymbolEngine =
  | "typescript_ast"
  | "vue_sfc_ast"
  | "php_nikic"
  | "php_heuristic"
  | "heuristic";

export type SymbolKind =
  | "class"
  | "component"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "method"
  | "namespace"
  | "store"
  | "trait"
  | "type"
  | "variable";

export type SymbolFact = {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line?: number;
};

export type ImportFact = {
  readonly value: string;
  readonly kind: "import" | "dynamic_import" | "require" | "include" | "use";
  readonly line?: number;
};

export type FileSymbolAnalysis = {
  readonly engine: SymbolEngine;
  readonly declarations: readonly SymbolFact[];
  readonly references: readonly SymbolFact[];
  readonly imports: readonly ImportFact[];
  readonly warnings: readonly string[];
};

export type FileSymbolAnalysisOptions = {
  readonly truncated?: boolean;
};

export const EMPTY_SYMBOL_ANALYSIS: FileSymbolAnalysis = {
  engine: "heuristic",
  declarations: [],
  references: [],
  imports: [],
  warnings: []
};
