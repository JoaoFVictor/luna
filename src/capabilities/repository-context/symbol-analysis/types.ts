export type SymbolEngine =
  | "typescript_symbol_graph"
  | "vue_sfc_symbol_graph"
  | "php_symbol_graph"
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

export type SymbolRole =
  | "definition"
  | "reference"
  | "import"
  | "write"
  | "read";

export const SYMBOL_ROLE_BITS = {
  definition: 0x1,
  import: 0x2,
  write: 0x4,
  read: 0x8
} as const;

export type SymbolRange = {
  readonly start_line: number;
  readonly start_character: number;
  readonly end_line: number;
  readonly end_character: number;
};

export type ImportKind = "import" | "dynamic_import" | "require" | "include" | "use";

export type SymbolOccurrence = {
  readonly symbol: string;
  readonly symbol_roles: number;
  readonly display_name: string;
  readonly kind: SymbolKind;
  readonly roles: readonly SymbolRole[];
  readonly range?: SymbolRange;
  readonly single_line_range?: {
    readonly line: number;
    readonly start_character: number;
    readonly end_character: number;
  };
  readonly multi_line_range?: SymbolRange;
  readonly import_value?: string;
  readonly import_kind?: ImportKind;
};

export type SymbolInformation = {
  readonly symbol: string;
  readonly display_name: string;
  readonly kind: number;
  readonly local_kind: SymbolKind;
};

export type SymbolDocument = {
  readonly relative_path: string;
  readonly language?: string;
  readonly position_encoding: "UTF16CodeUnitOffsetFromLineStart";
  readonly occurrences: readonly SymbolOccurrence[];
  readonly symbols: readonly SymbolInformation[];
};

export type FileSymbolGraph = {
  readonly engine: SymbolEngine;
  readonly document: SymbolDocument;
  readonly warnings: readonly string[];
};

export type FileSymbolGraphOptions = {
  readonly truncated?: boolean;
};
