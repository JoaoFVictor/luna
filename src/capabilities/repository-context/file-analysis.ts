import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  analyzeFileSymbols,
  heuristicSymbolNames,
  importValuesFromAnalysis,
  symbolNamesFromAnalysis,
  type FileSymbolAnalysis
} from "./symbol-analysis/index.js";

export type CandidateKind = "source" | "test" | "config" | "docs" | "other";

export type Candidate = {
  readonly path: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly language?: string;
  readonly kind: CandidateKind;
  readonly symbol_analysis: FileSymbolAnalysis;
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
};

export type ProjectImportResolution = {
  readonly tsPathAliases: readonly TsPathAlias[];
  readonly baseUrlDirectories: readonly string[];
  readonly psr4Namespaces: readonly Psr4Namespace[];
};

type TsPathAlias = {
  readonly prefix: string;
  readonly suffix: string;
  readonly targets: readonly string[];
};

type Psr4Namespace = {
  readonly namespace: string;
  readonly directory: string;
};

const IGNORED_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".git",
  ".hg",
  ".idea",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  "tmp",
  "temp"
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".php"
]);

const CONFIG_FILES = new Set([
  "composer.json",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.js",
  "vite.config.ts",
  "nuxt.config.js",
  "nuxt.config.ts",
  "next.config.js",
  "webpack.config.js",
  "phpunit.xml",
  "phpstan.neon",
  "psalm.xml"
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".neon", ".xml"]);
const CONFIG_DIRECTORIES = [
  ".circleci",
  ".github",
  ".gitlab",
  ".vscode",
  "config"
];

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function safeAbsolutePath(root: string, relativePath: string): string | undefined {
  const absolutePath = path.resolve(root, relativePath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSeparator)) {
    return undefined;
  }

  return absolutePath;
}

function languageFor(filePath: string): string | undefined {
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
  if (SOURCE_EXTENSIONS.has(extension)) {
    return "source";
  }

  return "other";
}

function isConfigPath(filePath: string, basename: string, extension: string): boolean {
  if (CONFIG_FILES.has(basename)) {
    return true;
  }
  if (!CONFIG_EXTENSIONS.has(extension)) {
    return false;
  }

  const normalized = normalizePath(filePath).toLowerCase();
  const directory = dirnameOf(normalized);
  return directory === "" || CONFIG_DIRECTORIES.some((prefix) =>
    directory === prefix || directory.startsWith(`${prefix}/`)
  );
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

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

export function wordsFrom(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_]+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

export function extractSymbols(content: string, filePath: string): string[] {
  return heuristicSymbolNames(content, filePath);
}

export async function walkFiles(root: string, options: {
  readonly maxScanFiles: number;
}): Promise<{ readonly files: readonly string[]; readonly skipped: number }> {
  const pending = [root];
  const files: string[] = [];
  let skipped = 0;

  while (pending.length > 0) {
    const current = pending.shift() as string;
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizePath(path.relative(root, absolutePath));

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }

      if (!entry.isFile() || !isSupportedFile(relativePath)) {
        continue;
      }

      if (files.length >= options.maxScanFiles) {
        skipped += 1;
        continue;
      }

      files.push(relativePath);
    }
  }

  return { files, skipped };
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

export async function readCandidate(
  root: string,
  relativePath: string,
  maxFileBytes: number
): Promise<Candidate | undefined> {
  const absolutePath = safeAbsolutePath(root, relativePath);
  if (absolutePath === undefined) {
    return undefined;
  }

  const stat = await lstat(absolutePath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (stat === undefined) {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }

  const raw = await readFile(absolutePath, "utf8");
  const truncated = Buffer.byteLength(raw, "utf8") > maxFileBytes;
  const content = truncated ? truncateUtf8(raw, maxFileBytes) : raw;
  const symbolAnalysis = analyzeFileSymbols(content, relativePath, { truncated });

  return {
    path: relativePath,
    absolutePath,
    content,
    truncated,
    language: languageFor(relativePath),
    kind: fileKind(relativePath),
    symbol_analysis: symbolAnalysis,
    symbols: symbolNamesFromAnalysis(symbolAnalysis),
    imports: importValuesFromAnalysis(symbolAnalysis)
  };
}

export function projectImportResolutionFrom(
  candidates: readonly Candidate[]
): ProjectImportResolution {
  return {
    tsPathAliases: candidates.flatMap((candidate) =>
      ["tsconfig.json", "jsconfig.json"].includes(candidate.path)
        ? tsPathAliasesFrom(candidate.content)
        : []
    ),
    baseUrlDirectories: candidates.flatMap((candidate) =>
      ["tsconfig.json", "jsconfig.json"].includes(candidate.path)
        ? baseUrlDirectoriesFrom(candidate.content)
        : []
    ),
    psr4Namespaces: candidates.flatMap((candidate) =>
      candidate.path === "composer.json"
        ? psr4NamespacesFrom(candidate.content)
        : []
    )
  };
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content);
    return objectRecord(parsed);
  } catch {
    return undefined;
  }
}

function tsPathAliasesFrom(content: string): readonly TsPathAlias[] {
  const parsed = parseJsonObject(content);
  const compilerOptions = objectRecord(parsed?.compilerOptions);
  if (compilerOptions === undefined) {
    return [];
  }

  const paths = objectRecord(compilerOptions.paths);
  if (paths === undefined) {
    return [];
  }

  const aliases: TsPathAlias[] = [];
  for (const [pattern, rawTargets] of Object.entries(paths)) {
    if (!Array.isArray(rawTargets)) {
      continue;
    }

    const starIndex = pattern.indexOf("*");
    aliases.push({
      prefix: starIndex === -1 ? pattern : pattern.slice(0, starIndex),
      suffix: starIndex === -1 ? "" : pattern.slice(starIndex + 1),
      targets: rawTargets.filter((target): target is string => typeof target === "string")
    });
  }

  return aliases;
}

function baseUrlDirectoriesFrom(content: string): readonly string[] {
  const parsed = parseJsonObject(content);
  const compilerOptions = objectRecord(parsed?.compilerOptions);
  if (compilerOptions === undefined) {
    return [];
  }

  const baseUrl = compilerOptions.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim() !== ""
    ? [normalizePath(baseUrl).replace(/\/+$/u, "")]
    : [];
}

function psr4NamespacesFrom(content: string): readonly Psr4Namespace[] {
  const parsed = parseJsonObject(content);
  const autoload = objectRecord(parsed?.autoload);
  if (autoload === undefined) {
    return [];
  }

  const psr4 = objectRecord(autoload["psr-4"]);
  if (psr4 === undefined) {
    return [];
  }

  return Object.entries(psr4)
    .flatMap(([namespace, rawDirectory]) => {
      const directories = Array.isArray(rawDirectory) ? rawDirectory : [rawDirectory];
      return directories
        .filter((directory): directory is string => typeof directory === "string")
        .map((directory) => ({
          namespace,
          directory: normalizePath(directory).replace(/\/+$/u, "")
        }));
    });
}

export function importTargets(
  importValue: string,
  fromPath: string,
  resolution: ProjectImportResolution = {
    tsPathAliases: [],
    baseUrlDirectories: [],
    psr4Namespaces: []
  }
): string[] {
  const importPath = stripImportKind(importValue);
  if (!importPath.startsWith(".")) {
    return unique([
      ...tsAliasTargets(importPath, resolution.tsPathAliases),
      ...baseUrlTargets(importPath, resolution.baseUrlDirectories),
      ...commonJsAliasTargets(importPath),
      ...psr4Targets(importPath, resolution.psr4Namespaces)
    ]);
  }

  const base = path.posix.normalize(path.posix.join(dirnameOf(fromPath), importPath));
  return withSourceExtensions(base);
}

function withSourceExtensions(base: string): string[] {
  if (path.posix.extname(base) !== "") {
    return [base];
  }

  const extensions = [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".php",
    "/index.ts",
    "/index.js",
    "/index.php"
  ];
  return unique(extensions.map((extension) => `${base}${extension}`));
}

function tsAliasTargets(
  importPath: string,
  aliases: readonly TsPathAlias[]
): readonly string[] {
  const targets: string[] = [];

  for (const alias of aliases) {
    if (!importPath.startsWith(alias.prefix) || !importPath.endsWith(alias.suffix)) {
      continue;
    }

    const matched = importPath.slice(
      alias.prefix.length,
      alias.suffix.length === 0 ? undefined : -alias.suffix.length
    );
    for (const target of alias.targets) {
      const resolved = target.includes("*")
        ? target.replace("*", matched)
        : target;
      targets.push(...withSourceExtensions(normalizePath(resolved)));
    }
  }

  return targets;
}

function baseUrlTargets(
  importPath: string,
  baseUrlDirectories: readonly string[]
): readonly string[] {
  if (importPath.startsWith("@") || importPath.startsWith("#")) {
    return [];
  }

  return baseUrlDirectories.flatMap((directory) =>
    withSourceExtensions(`${directory}/${importPath}`.replace(/^\/+/u, ""))
  );
}

function commonJsAliasTargets(importPath: string): readonly string[] {
  const aliasPrefixes = ["@/", "~/", "@@/", "~~/"];
  const alias = aliasPrefixes.find((prefix) => importPath.startsWith(prefix));
  if (alias === undefined) {
    return [];
  }

  const relative = importPath.slice(alias.length);
  return unique([
    ...withSourceExtensions(relative),
    ...withSourceExtensions(`app/${relative}`),
    ...withSourceExtensions(`src/${relative}`)
  ]);
}

function psr4Targets(
  importPath: string,
  namespaces: readonly Psr4Namespace[]
): readonly string[] {
  const normalizedImport = importPath.replace(/^\\+/u, "");
  const targets: string[] = [];

  for (const namespace of namespaces) {
    if (!normalizedImport.startsWith(namespace.namespace)) {
      continue;
    }

    const relativeClass = normalizedImport
      .slice(namespace.namespace.length)
      .replace(/\\/gu, "/");
    targets.push(`${namespace.directory}/${relativeClass}.php`.replace(/^\/+/u, ""));
  }

  return targets;
}

function stripImportKind(importValue: string): string {
  const separator = importValue.indexOf(":");
  if (separator === -1) {
    return importValue;
  }

  return importValue.slice(separator + 1);
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingFileError(error: unknown): boolean {
  const record = objectRecord(error);
  return record !== undefined && ["ENOENT", "ENOTDIR"].includes(String(record.code));
}
