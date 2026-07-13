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
const PHP_BRIDGE_MAX_BATCH_FILES = 128;
const PHP_BRIDGE_MAX_BATCH_SOURCE_BYTES = 8 * 1024 * 1024;
const PHP_BRIDGE_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const PHP_BRIDGE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PHP_BRIDGE_MAX_STDERR_BYTES = 64 * 1024;

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
  candidates: readonly Candidate[],
  signal?: AbortSignal
): Promise<{
  readonly candidates: readonly Candidate[];
  readonly warnings: readonly string[];
}> {
  const phpCandidates = candidates.filter((candidate) => candidate.language === "php");
  if (phpCandidates.length === 0) {
    return { candidates, warnings: [] };
  }

  const files: { readonly path: string; readonly graph: FileSymbolGraph }[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  for (const batch of phpBatches(phpCandidates)) {
    signal?.throwIfAborted();
    try {
      const result = await runPhpBridge(batch, signal);
      files.push(...result.files);
      warnings.push(...result.warnings);
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const byPath = new Map(files.map((file) => [file.path, file.graph]));
  const missingPaths = phpCandidates
    .map((candidate) => candidate.path)
    .filter((filePath) => !byPath.has(filePath));
  const failureSummary = [...new Set(failures)].slice(0, 3).join("; ");
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
    warnings: [
      ...warnings,
      ...(missingPaths.length === 0
        ? []
        : [
            `PHP structural coverage unavailable for ${missingPaths.length === phpCandidates.length ? `all ${phpCandidates.length}` : `${missingPaths.length}/${phpCandidates.length}`} indexed files: ${missingPaths.slice(0, 10).join(", ")}${failureSummary === "" ? "" : `. ${failureSummary}`}`
          ])
    ]
  };
}

function phpBatches(candidates: readonly Candidate[]): readonly (readonly Candidate[])[] {
  const batches: Candidate[][] = [];
  let batch: Candidate[] = [];
  let batchBytes = 0;
  for (const candidate of candidates) {
    const bytes = Buffer.byteLength(candidate.content, "utf8");
    if (
      batch.length > 0 &&
      (batch.length >= PHP_BRIDGE_MAX_BATCH_FILES ||
        batchBytes + bytes > PHP_BRIDGE_MAX_BATCH_SOURCE_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(candidate);
    batchBytes += bytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

async function runPhpBridge(
  candidates: readonly Candidate[],
  signal?: AbortSignal
): Promise<{
  readonly files: readonly { readonly path: string; readonly graph: FileSymbolGraph }[];
  readonly warnings: readonly string[];
}> {
  const input = JSON.stringify({
    files: candidates.map((candidate) => ({
      path: candidate.path,
      content: candidate.content
    }))
  });
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > PHP_BRIDGE_MAX_INPUT_BYTES) {
    throw new Error(`PHP symbol graph bridge input exceeded ${PHP_BRIDGE_MAX_INPUT_BYTES} bytes.`);
  }
  const stdout = await spawnPhpBridge(input, signal);
  const parsed = JSON.parse(stdout) as BridgeResult;
  const warnings = arrayOfStrings(parsed.warnings);
  const filesResult = Array.isArray(parsed.files)
    ? parsed.files.flatMap((file) => bridgeFile(file))
    : [];

  return { files: filesResult, warnings };
}

async function spawnPhpBridge(input: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn("php", ["-r", PHP_SYMBOL_GRAPH_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("PHP symbol graph bridge timed out."));
    }, PHP_BRIDGE_TIMEOUT_MS);
    const abort = () => {
      child.kill("SIGTERM");
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let outputExceeded = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputExceeded) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > PHP_BRIDGE_MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
        reject(new Error(`PHP symbol graph bridge output exceeded ${PHP_BRIDGE_MAX_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = stderr.reduce((total, buffered) => total + buffered.length, 0);
      if (captured < PHP_BRIDGE_MAX_STDERR_BYTES) {
        stderr.push(chunk.subarray(0, PHP_BRIDGE_MAX_STDERR_BYTES - captured));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
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
