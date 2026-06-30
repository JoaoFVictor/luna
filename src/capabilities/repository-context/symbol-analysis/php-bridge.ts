import { spawn } from "node:child_process";
import type { Candidate } from "../file-analysis.js";
import {
  symbolGraphFromOccurrences,
  importValuesFromGraph,
  occurrence,
  symbolNamesFromGraph
} from "./common.js";
import { analyzeHeuristically } from "./heuristic.js";
import { PHP_SYMBOL_GRAPH_SCRIPT } from "./php-symbol-graph-script.js";
import type {
  FileSymbolGraph,
  ImportKind,
  SymbolKind,
  SymbolOccurrence
} from "./types.js";

const PHP_BRIDGE_TIMEOUT_MS = 10_000;

type BridgeFile = {
  readonly path?: unknown;
  readonly occurrences?: unknown;
  readonly warnings?: unknown;
};

type BridgeResult = {
  readonly files?: unknown;
  readonly warnings?: unknown;
};

export async function enrichPhpCandidatesWithNikic(
  root: string,
  candidates: readonly Candidate[]
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly warnings: readonly string[];
}> {
  const phpCandidates = candidates.filter((candidate) => candidate.language === "php");
  if (phpCandidates.length === 0) {
    return { candidates, warnings: [] };
  }

  try {
    const result = await runPhpBridge(root, phpCandidates.map((candidate) => candidate.path));
    const byPath = new Map(result.files.map((file) => [file.path, file.graph]));
    return {
      candidates: candidates.map((candidate) => {
        const graph = byPath.get(candidate.path);
        if (graph === undefined) {
          return candidate;
        }

        return {
          ...candidate,
          symbol_graph: graph,
          symbols: symbolNamesFromGraph(graph),
          imports: importValuesFromGraph(graph)
        };
      }),
      warnings: result.warnings
    };
  } catch (error) {
    return {
      candidates,
      warnings: [`PHP symbol graph bridge unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function runPhpBridge(
  root: string,
  files: readonly string[]
): Promise<{
  readonly files: readonly { readonly path: string; readonly graph: FileSymbolGraph }[];
  readonly warnings: readonly string[];
}> {
  const stdout = await spawnPhpBridge(JSON.stringify({ root, files }));
  const parsed = JSON.parse(stdout) as BridgeResult;
  const warnings = arrayOfStrings(parsed.warnings);
  const filesResult = Array.isArray(parsed.files)
    ? parsed.files.flatMap((file) => bridgeFile(file))
    : [];

  return { files: filesResult, warnings };
}

async function spawnPhpBridge(input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("php", ["-r", PHP_SYMBOL_GRAPH_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("PHP symbol graph bridge timed out."));
    }, PHP_BRIDGE_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `php exited with ${code ?? "unknown status"}`));
    });

    child.stdin.end(input);
  });
}

function bridgeFile(value: unknown): readonly {
  readonly path: string;
  readonly graph: FileSymbolGraph;
}[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  const file = value as BridgeFile;
  if (typeof file.path !== "string" || file.path === "") {
    return [];
  }

  return [{
    path: file.path,
    graph: symbolGraphFromOccurrences({
      engine: "php_symbol_graph",
      filePath: file.path,
      language: "php",
      occurrences: arrayOfOccurrences(file.path, file.occurrences),
      warnings: arrayOfStrings(file.warnings)
    })
  }];
}

function arrayOfOccurrences(filePath: string, value: unknown): SymbolOccurrence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.kind !== "string" ||
      !Array.isArray(record.roles)
    ) {
      return [];
    }
    const importKind = typeof record.import_kind === "string"
      ? importKindFrom(record.import_kind)
      : undefined;
    const roles = record.roles.filter((role): role is SymbolOccurrence["roles"][number] =>
      role === "definition" || role === "reference" || role === "import" || role === "read" || role === "write"
    );
    if (roles.length === 0) {
      return [];
    }
    return [occurrence({
      filePath,
      name: record.name,
      kind: symbolKind(record.kind),
      roles,
      ...(typeof record.line === "number"
        ? {
            range: {
              start_line: Math.max(0, record.line - 1),
              start_character: 0,
              end_line: Math.max(0, record.line - 1),
              end_character: record.name.length
            }
          }
        : {}),
      ...(typeof record.import_value === "string" ? { import_value: record.import_value } : {}),
      ...(importKind === undefined ? {} : { import_kind: importKind })
    })];
  });
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

function symbolKind(kind: string): SymbolKind {
  switch (kind) {
    case "class":
    case "const":
    case "enum":
    case "function":
    case "interface":
    case "method":
    case "namespace":
    case "trait":
      return kind;
    default:
      return "variable";
  }
}

function importKindFrom(kind: unknown): ImportKind {
  return kind === "include" || kind === "require" || kind === "use"
    ? kind
    : "use";
}

export function phpFallbackAnalysis(content: string, filePath: string): FileSymbolGraph {
  return analyzeHeuristically(content, filePath, "php_heuristic");
}
