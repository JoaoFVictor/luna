import path from "node:path";
import {
  heuristicSymbolNames,
  unique,
  type FileSymbolGraph
} from "./symbol-analysis/index.js";
export { unique, wordsFrom } from "./symbol-analysis/index.js";

export type CandidateKind = "source" | "test" | "config" | "docs" | "other";

export type Candidate = {
  readonly path: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly content_digest?: string;
  readonly truncated: boolean;
  readonly language?: string;
  readonly kind: CandidateKind;
  readonly symbol_graph: FileSymbolGraph;
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
};

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".scala",
  ".sc",
  ".swift",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".vue",
  ".php",
  ".zig",
  ".hcl",
  ".tf",
  ".tfvars"
]);
const SOURCE_BASENAMES = new Set([
  "containerfile",
  "dockerfile",
  "jenkinsfile",
  "makefile"
]);

const RESOLUTION_MANIFEST_FILES = new Set([
  "composer.json",
  "package.json",
  "tsconfig.json",
  "jsconfig.json"
]);

const DOC_EXTENSIONS = new Set([".adoc", ".md", ".mdx", ".rst", ".txt"]);
const CONFIG_EXTENSIONS = new Set([
  ".ini",
  ".json",
  ".neon",
  ".properties",
  ".toml",
  ".xml",
  ".yaml",
  ".yml"
]);
const CONFIG_DIRECTORIES = [
  ".circleci",
  ".github",
  ".gitlab",
  ".vscode",
  "config"
];
const GENERIC_LANGUAGES: Readonly<Record<string, string>> = {
  ".astro": "astro",
  ".bash": "shell",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".less": "less",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sc": "scala",
  ".scala": "scala",
  ".sass": "sass",
  ".scss": "scss",
  ".sh": "shell",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".hcl": "hcl",
  ".tf": "hcl",
  ".tfvars": "hcl",
  ".zig": "zig"
};

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function languageFor(filePath: string): string | undefined {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile" || basename === "containerfile") {
    return "dockerfile";
  }
  if (basename === "makefile") {
    return "makefile";
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".php") {
    return "php";
  }
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    return "javascript";
  }
  if ([".ts", ".tsx"].includes(extension)) {
    return "typescript";
  }
  if (extension === ".vue") {
    return "vue";
  }
  if (GENERIC_LANGUAGES[extension] !== undefined) {
    return GENERIC_LANGUAGES[extension];
  }
  if (extension === ".json") {
    return "json";
  }
  if ([".yaml", ".yml"].includes(extension)) {
    return "yaml";
  }

  return undefined;
}

export function fileKind(filePath: string): CandidateKind {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();

  if (isTestPath(filePath)) {
    return "test";
  }
  if (isConfigPath(filePath, basename, extension)) {
    return "config";
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return "docs";
  }
  if (SOURCE_EXTENSIONS.has(extension) || SOURCE_BASENAMES.has(basename)) {
    return "source";
  }

  return "other";
}

function isConfigPath(filePath: string, basename: string, extension: string): boolean {
  if (
    RESOLUTION_MANIFEST_FILES.has(basename) ||
    /(?:^|[._-])config(?:[._-]|$)/u.test(basename)
  ) {
    return true;
  }

  const normalized = normalizePath(filePath).toLowerCase();
  const directory = dirnameOf(normalized);
  const inConfigDirectory = CONFIG_DIRECTORIES.some((prefix) =>
    directory === prefix || directory.startsWith(`${prefix}/`)
  );
  if (extension === ".php" && inConfigDirectory) {
    return true;
  }
  if (!CONFIG_EXTENSIONS.has(extension)) {
    return false;
  }

  return directory === "" || inConfigDirectory;
}

export function isSupportedFile(filePath: string): boolean {
  const kind = fileKind(filePath);
  return kind !== "other";
}

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const basename = path.basename(normalized);
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/spec/") ||
    normalized.includes("/__tests__/") ||
    basename.includes(".test.") ||
    basename.includes(".spec.") ||
    basename.endsWith("test.php")
  );
}

export function dirnameOf(filePath: string): string {
  const directory = path.posix.dirname(normalizePath(filePath));
  return directory === "." ? "" : directory;
}

export function basenameStem(filePath: string): string {
  const basename = path.posix.basename(normalizePath(filePath));
  return basename.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/i, "");
}

export function extractSymbols(content: string, filePath: string): string[] {
  return heuristicSymbolNames(content, filePath);
}

export function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }

  let bytes = 0;
  let truncated = "";
  for (const character of content) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) {
      break;
    }
    truncated += character;
    bytes += size;
  }
  return truncated;
}

export function sourcePathVariants(base: string): string[] {
  const emittedExtensionVariants: Readonly<Record<string, readonly string[]>> = {
    ".js": [".js", ".ts", ".tsx", ".d.ts", ".jsx"],
    ".mjs": [".mjs", ".mts", ".d.mts"],
    ".cjs": [".cjs", ".cts", ".d.cts"]
  };
  const extension = path.posix.extname(base);
  const substitutions = emittedExtensionVariants[extension];
  if (substitutions !== undefined) {
    const stem = base.slice(0, -extension.length);
    return substitutions.map((substitution) => `${stem}${substitution}`);
  }
  if (extension !== "") {
    return [base];
  }

  const extensions = [
    "",
    ...SOURCE_EXTENSIONS,
    ...[...SOURCE_EXTENSIONS].map((extension) => `/index${extension}`)
  ];
  return unique(extensions.map((extension) => `${base}${extension}`));
}

export function importEdgeType(importValue: string): "imports" | "includes" | "requires" {
  const kind = importValue.slice(0, Math.max(0, importValue.indexOf(":"))).toLowerCase();
  if (kind.includes("require")) {
    return "requires";
  }
  if (kind.includes("include")) {
    return "includes";
  }
  return "imports";
}
