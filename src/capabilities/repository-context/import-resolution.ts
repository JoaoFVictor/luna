import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { Candidate } from "./file-analysis.js";
import { dirnameOf, sourcePathVariants, unique } from "./file-analysis.js";

const VIRTUAL_ROOT = "/__luna_repository__";

type TsResolutionScope = {
  readonly directory: string;
  readonly manifest: string;
  readonly compilerOptions: ts.CompilerOptions;
};

type Psr4Namespace = {
  readonly namespace: string;
  readonly directory: string;
};

type ComposerResolutionScope = {
  readonly directory: string;
  readonly manifest: string;
  readonly namespaces: readonly Psr4Namespace[];
};

export type ProjectImportResolution = {
  readonly tsScopes: readonly TsResolutionScope[];
  readonly composerScopes: readonly ComposerResolutionScope[];
  readonly warnings: readonly string[];
  readonly signature: string;
  readonly estimated_working_bytes: number;
  readonly candidateByPath: ReadonlyMap<string, Candidate>;
  readonly resolutionHost: ts.ModuleResolutionHost;
  readonly moduleResolutionCache: ts.ModuleResolutionCache;
  readonly tsScopeByDirectory: ReadonlyMap<string, TsResolutionScope>;
  readonly composerScopeByDirectory: ReadonlyMap<string, ComposerResolutionScope>;
};

const EMPTY_RESOLUTION: ProjectImportResolution = {
  tsScopes: [],
  composerScopes: [],
  warnings: [],
  signature: "sha256:empty",
  estimated_working_bytes: 0,
  candidateByPath: new Map(),
  resolutionHost: { fileExists: () => false, readFile: () => undefined },
  moduleResolutionCache: ts.createModuleResolutionCache(VIRTUAL_ROOT, (value) => value),
  tsScopeByDirectory: new Map(),
  composerScopeByDirectory: new Map()
};


function toVirtualPath(filePath: string): string {
  return path.posix.join(VIRTUAL_ROOT, filePath);
}

function fromVirtualPath(filePath: string): string | undefined {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  const prefix = `${VIRTUAL_ROOT}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

function snapshotTypeScriptHost(
  candidatesByPath: ReadonlyMap<string, Candidate>,
  warnings: string[] = []
): ts.ParseConfigFileHost {
  const syntheticFiles = new Map<string, string>();
  for (const candidate of candidatesByPath.values()) {
    const extension = path.posix.extname(candidate.path);
    if (candidate.kind !== "source" || /^(?:\.[cm]?[jt]sx?)$/u.test(extension)) {
      continue;
    }
    syntheticFiles.set(
      `${candidate.path.slice(0, -extension.length)}.d${extension}.ts`,
      candidate.content
    );
  }
  const paths = unique([...candidatesByPath.keys(), ...syntheticFiles.keys()]);
  const directories = new Set<string>([""]);
  const children = new Map<string, Set<string>>();
  for (const candidatePath of paths) {
    const segments = dirnameOf(candidatePath).split("/").filter(Boolean);
    let parent = "";
    for (const segment of segments) {
      const directory = parent === "" ? segment : `${parent}/${segment}`;
      directories.add(directory);
      const directChildren = children.get(parent) ?? new Set<string>();
      directChildren.add(directory);
      children.set(parent, directChildren);
      parent = directory;
    }
  }
  const relative = (filePath: string): string | undefined => fromVirtualPath(filePath);
  return {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    fileExists(filePath) {
      const candidatePath = relative(filePath);
      return candidatePath !== undefined &&
        (candidatesByPath.has(candidatePath) || syntheticFiles.has(candidatePath));
    },
    readFile(filePath) {
      const candidatePath = relative(filePath);
      return candidatePath === undefined
        ? undefined
        : candidatesByPath.get(candidatePath)?.content ?? syntheticFiles.get(candidatePath);
    },
    // Repository-context needs compiler options and extends, not tsconfig's
    // file inclusion expansion. Avoid an O(configs * files) enumeration.
    readDirectory: () => [],
    directoryExists(directoryName) {
      const directory = relative(directoryName);
      if (directory === undefined) {
        return directoryName === VIRTUAL_ROOT;
      }
      return directories.has(directory);
    },
    getDirectories(directoryName) {
      const directory = relative(directoryName) ?? "";
      return [...(children.get(directory) ?? [])].map(toVirtualPath);
    },
    realpath: (filePath) => filePath,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      warnings.push(`TypeScript config diagnostic: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " "
      )}`);
    }
  };
}

export function projectImportResolutionFrom(
  candidates: readonly Candidate[]
): ProjectImportResolution {
  const warnings: string[] = [];
  const candidatesByPath = new Map(candidates.map((candidate) => [
    path.posix.normalize(candidate.path),
    candidate
  ]));
  const host = snapshotTypeScriptHost(candidatesByPath, warnings);
  const manifests = candidates
    .filter((candidate) => ["tsconfig.json", "jsconfig.json"].includes(path.posix.basename(candidate.path)));
  const tsScopes = manifests
    .map((candidate) => tsScopeFrom(candidate, warnings, host))
    .sort(compareScopes);
  const composerScopes = candidates
    .filter((candidate) => path.posix.basename(candidate.path) === "composer.json")
    .map((candidate) => composerScopeFrom(candidate, warnings))
    .sort(compareScopes);
  const uniqueWarnings = unique(warnings);
  const serialized = JSON.stringify({ tsScopes, composerScopes, warnings: uniqueWarnings });
  const estimatedWorkingBytes = candidates.reduce((total, candidate) =>
    total + 256 + candidate.path.length * 2 + candidate.imports.reduce(
      (imports, value) => imports + 512 + value.length * 2,
      0
    ), 0
  ) + Buffer.byteLength(serialized, "utf8") * 4;
  return {
    tsScopes,
    composerScopes,
    warnings: uniqueWarnings,
    signature: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    // Conservatively account for UTF-16 strings, arrays, maps, and object
    // headers rather than pretending serialized JSON equals heap retention.
    estimated_working_bytes: estimatedWorkingBytes,
    candidateByPath: candidatesByPath,
    resolutionHost: host,
    moduleResolutionCache: ts.createModuleResolutionCache(VIRTUAL_ROOT, (value) => value),
    tsScopeByDirectory: scopeMap(tsScopes),
    composerScopeByDirectory: scopeMap(composerScopes)
  };
}

export function importTargets(
  importValue: string,
  fromPath: string,
  resolution: ProjectImportResolution = EMPTY_RESOLUTION
): string[] {
  const importPath = stripImportKind(importValue);
  const tsScope = nearestScope(resolution.tsScopeByDirectory, fromPath);
  if (tsScope !== undefined) {
    const resolved = ts.resolveModuleName(
      importPath,
      toVirtualPath(fromPath),
      tsScope.compilerOptions,
      resolution.resolutionHost,
      resolution.moduleResolutionCache
    ).resolvedModule?.resolvedFileName;
    const relative = resolved === undefined ? undefined : fromVirtualPath(resolved);
    const canonical = relative === undefined
      ? undefined
      : canonicalResolvedPath(relative, resolution.candidateByPath);
    if (canonical !== undefined) {
      return [canonical];
    }
  }
  if (importPath.startsWith(".")) {
    return sourcePathVariants(path.posix.normalize(
      path.posix.join(dirnameOf(fromPath), importPath)
    ));
  }

  const composerScope = nearestScope(resolution.composerScopeByDirectory, fromPath);
  return unique([
    ...(composerScope === undefined
      ? []
      : psr4Targets(importPath, composerScope.namespaces))
  ]);
}

function canonicalResolvedPath(
  resolved: string,
  candidatesByPath: ReadonlyMap<string, Candidate>
): string | undefined {
  if (candidatesByPath.has(resolved)) {
    return resolved;
  }
  const arbitraryDeclaration = /^(.*)\.d(\.[^/]+)\.ts$/u.exec(resolved);
  const arbitrary = arbitraryDeclaration === null
    ? undefined
    : `${arbitraryDeclaration[1]}${arbitraryDeclaration[2]}`;
  return arbitrary !== undefined && candidatesByPath.has(arbitrary) ? arbitrary : undefined;
}

function tsScopeFrom(
  candidate: Candidate,
  warnings: string[],
  host: ts.ParseConfigFileHost
): TsResolutionScope {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    toVirtualPath(candidate.path),
    undefined,
    host
  );
  for (const diagnostic of parsed?.errors ?? []) {
    if (diagnostic.code === 18003) {
      continue;
    }
    warnings.push(`TypeScript config diagnostic: ${ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " "
    )}`);
  }
  return {
    directory: dirnameOf(candidate.path),
    manifest: candidate.path,
    compilerOptions: parsed?.options ?? {}
  };
}

function composerScopeFrom(candidate: Candidate, warnings: string[]): ComposerResolutionScope {
  const directory = dirnameOf(candidate.path);
  const parsed = parseJsonObject(candidate.content);
  if (parsed === undefined) {
    warnings.push(`Unable to parse Composer manifest from captured content: ${candidate.path}`);
  }
  const autoload = objectRecord(parsed?.autoload);
  const autoloadDev = objectRecord(parsed?.["autoload-dev"]);
  const psr4Entries = [
    ...Object.entries(objectRecord(autoload?.["psr-4"]) ?? {}),
    ...Object.entries(objectRecord(autoloadDev?.["psr-4"]) ?? {})
  ];
  const namespaces = psr4Entries.flatMap(([namespace, rawDirectory]) => {
    const directories = Array.isArray(rawDirectory) ? rawDirectory : [rawDirectory];
    return directories
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => {
        const resolved = resolveWithinRepository(directory, entry);
        return resolved === undefined ? [] : [{ namespace, directory: resolved }];
      });
  });
  return {
    directory,
    manifest: candidate.path,
    namespaces
  };
}

function scopeMap<T extends { readonly directory: string; readonly manifest: string }>(
  scopes: readonly T[]
): ReadonlyMap<string, T> {
  const byDirectory = new Map<string, T>();
  for (const scope of scopes) {
    if (!byDirectory.has(scope.directory)) {
      byDirectory.set(scope.directory, scope);
    }
  }
  return byDirectory;
}

function nearestScope<T extends { readonly directory: string; readonly manifest: string }>(
  scopes: ReadonlyMap<string, T>,
  fromPath: string
): T | undefined {
  let directory = dirnameOf(fromPath);
  while (true) {
    const scope = scopes.get(directory);
    if (scope !== undefined) {
      return scope;
    }
    if (directory === "") {
      return undefined;
    }
    directory = dirnameOf(directory);
  }
}

function compareScopes(
  left: { readonly directory: string; readonly manifest: string },
  right: { readonly directory: string; readonly manifest: string }
): number {
  return directoryDepth(right.directory) - directoryDepth(left.directory) ||
    manifestPreference(left.manifest) - manifestPreference(right.manifest) ||
    left.manifest.localeCompare(right.manifest);
}

function manifestPreference(manifest: string): number {
  return path.posix.basename(manifest) === "tsconfig.json" ? 0 : 1;
}

function directoryDepth(directory: string): number {
  return directory === "" ? 0 : directory.split("/").length;
}

function resolveWithinRepository(directory: string, target: string): string | undefined {
  const normalizedTarget = target.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalizedTarget)) {
    return undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(directory, normalizedTarget));
  return resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
}

function psr4Targets(importPath: string, namespaces: readonly Psr4Namespace[]): string[] {
  const normalizedImport = importPath.replace(/^\\+/u, "");
  return namespaces.flatMap((namespace) => {
    if (!normalizedImport.startsWith(namespace.namespace)) {
      return [];
    }
    const relativeClass = normalizedImport
      .slice(namespace.namespace.length)
      .replace(/\\/gu, "/");
    return [path.posix.normalize(`${namespace.directory}/${relativeClass}.php`).replace(/^\/+/u, "")];
  });
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    return objectRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stripImportKind(importValue: string): string {
  const separator = importValue.indexOf(":");
  return separator === -1 ? importValue : importValue.slice(separator + 1);
}
