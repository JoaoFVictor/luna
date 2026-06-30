import { spawn } from "node:child_process";
import type { Candidate } from "../file-analysis.js";
import {
  importValuesFromAnalysis,
  mergeAnalysis,
  symbolNamesFromAnalysis
} from "./common.js";
import { analyzeHeuristically } from "./heuristic.js";
import type {
  FileSymbolAnalysis,
  ImportFact,
  SymbolFact
} from "./types.js";

const PHP_BRIDGE_TIMEOUT_MS = 10_000;

type BridgeFile = {
  readonly path?: unknown;
  readonly declarations?: unknown;
  readonly references?: unknown;
  readonly imports?: unknown;
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
    const byPath = new Map(result.files.map((file) => [file.path, file.analysis]));
    return {
      candidates: candidates.map((candidate) => {
        const analysis = byPath.get(candidate.path);
        if (analysis === undefined) {
          return candidate;
        }

        const mergedAnalysis = mergeAnalysis(analysis, candidate.symbol_analysis);
        const merged = {
          ...mergedAnalysis,
          warnings: analysis.warnings
        };
        return {
          ...candidate,
          symbol_analysis: merged,
          symbols: symbolNamesFromAnalysis(merged),
          imports: importValuesFromAnalysis(merged)
        };
      }),
      warnings: result.warnings
    };
  } catch (error) {
    return {
      candidates,
      warnings: [`PHP AST bridge unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function runPhpBridge(
  root: string,
  files: readonly string[]
): Promise<{
  readonly files: readonly { readonly path: string; readonly analysis: FileSymbolAnalysis }[];
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
      reject(new Error("PHP AST bridge timed out."));
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
  readonly analysis: FileSymbolAnalysis;
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
    analysis: {
      engine: "php_nikic",
      declarations: arrayOfSymbols(file.declarations),
      references: arrayOfSymbols(file.references),
      imports: arrayOfImports(file.imports),
      warnings: arrayOfStrings(file.warnings)
    }
  }];
}

function arrayOfSymbols(value: unknown): SymbolFact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.kind !== "string") {
      return [];
    }
    return [{
      name: record.name,
      kind: symbolKind(record.kind),
      ...(typeof record.line === "number" ? { line: record.line } : {})
    }];
  });
}

function arrayOfImports(value: unknown): ImportFact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string" || record.value === "") {
      return [];
    }
    return [{
      value: record.value,
      kind: importKind(record.kind),
      ...(typeof record.line === "number" ? { line: record.line } : {})
    }];
  });
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

function symbolKind(kind: string): SymbolFact["kind"] {
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

function importKind(kind: unknown): ImportFact["kind"] {
  return kind === "include" || kind === "require" || kind === "use"
    ? kind
    : "use";
}

export function phpFallbackAnalysis(content: string, filePath: string): FileSymbolAnalysis {
  return analyzeHeuristically(content, filePath, "php_heuristic");
}

const PHP_SYMBOL_GRAPH_SCRIPT = String.raw`
$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) {
    fwrite(STDERR, "Invalid JSON input\n");
    exit(2);
}

$root = $input['root'] ?? null;
$files = $input['files'] ?? [];
if (!is_string($root) || !is_array($files)) {
    fwrite(STDERR, "Invalid root/files input\n");
    exit(2);
}

$rootReal = realpath($root);
if ($rootReal === false) {
    fwrite(STDERR, "Repository root not found\n");
    exit(2);
}

$autoload = $rootReal . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "vendor/autoload.php not found\n");
    exit(3);
}

require_once $autoload;
if (!class_exists(\PhpParser\ParserFactory::class)) {
    fwrite(STDERR, "nikic/php-parser not found\n");
    exit(3);
}

$factory = new \PhpParser\ParserFactory();
if (method_exists($factory, 'createForNewestSupportedVersion')) {
    $parser = $factory->createForNewestSupportedVersion();
} else {
    $parser = $factory->create(\PhpParser\ParserFactory::PREFER_PHP7);
}

$result = ['files' => [], 'warnings' => []];
foreach ($files as $relativePath) {
    if (!is_string($relativePath) || $relativePath === '') {
        continue;
    }

    $absolutePath = realpath($rootReal . DIRECTORY_SEPARATOR . $relativePath);
    if ($absolutePath === false || !str_starts_with($absolutePath, $rootReal . DIRECTORY_SEPARATOR)) {
        $result['warnings'][] = 'Skipped unsafe PHP path: ' . $relativePath;
        continue;
    }

    try {
        $ast = $parser->parse(file_get_contents($absolutePath));
        $analysis = [
            'path' => str_replace(DIRECTORY_SEPARATOR, '/', $relativePath),
            'declarations' => [],
            'references' => [],
            'imports' => [],
            'warnings' => [],
        ];
        collect_nodes($ast ?? [], $analysis);
        $result['files'][] = dedupe_file($analysis);
    } catch (\Throwable $exception) {
        $result['files'][] = [
            'path' => str_replace(DIRECTORY_SEPARATOR, '/', $relativePath),
            'declarations' => [],
            'references' => [],
            'imports' => [],
            'warnings' => [$exception->getMessage()],
        ];
    }
}

echo json_encode($result, JSON_THROW_ON_ERROR);

function collect_nodes(array $nodes, array &$analysis): void {
    foreach ($nodes as $node) {
        if (!$node instanceof \PhpParser\Node) {
            continue;
        }

        collect_node($node, $analysis);
        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof \PhpParser\Node) {
                collect_nodes([$child], $analysis);
            } elseif (is_array($child)) {
                collect_nodes($child, $analysis);
            }
        }
    }
}

function collect_node(\PhpParser\Node $node, array &$analysis): void {
    $line = $node->getStartLine();

    if ($node instanceof \PhpParser\Node\Stmt\Namespace_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'namespace', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Class_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'class', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Interface_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'interface', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Trait_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'trait', 'line' => $line];
    } elseif (class_exists(\PhpParser\Node\Stmt\Enum_::class) && $node instanceof \PhpParser\Node\Stmt\Enum_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'enum', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Function_ && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'function', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\ClassMethod && $node->name !== null) {
        $analysis['declarations'][] = ['name' => $node->name->toString(), 'kind' => 'method', 'line' => $line];
    }

    if ($node instanceof \PhpParser\Node\Stmt\Use_) {
        foreach ($node->uses as $use) {
            $analysis['imports'][] = ['value' => $use->name->toString(), 'kind' => 'use', 'line' => $line];
        }
    } elseif ($node instanceof \PhpParser\Node\Stmt\GroupUse) {
        foreach ($node->uses as $use) {
            $analysis['imports'][] = ['value' => $node->prefix->toString() . '\\' . $use->name->toString(), 'kind' => 'use', 'line' => $line];
        }
    } elseif ($node instanceof \PhpParser\Node\Name) {
        $analysis['references'][] = ['name' => $node->toString(), 'kind' => 'class', 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Expr\Include_) {
        if ($node->expr instanceof \PhpParser\Node\Scalar\String_) {
            $kind = in_array($node->type, [\PhpParser\Node\Expr\Include_::TYPE_REQUIRE, \PhpParser\Node\Expr\Include_::TYPE_REQUIRE_ONCE], true)
                ? 'require'
                : 'include';
            $analysis['imports'][] = ['value' => $node->expr->value, 'kind' => $kind, 'line' => $line];
        }
    }
}

function dedupe_file(array $analysis): array {
    foreach (['declarations', 'references', 'imports'] as $key) {
        $seen = [];
        $deduped = [];
        foreach ($analysis[$key] as $entry) {
            $identity = ($entry['kind'] ?? '') . "\0" . ($entry['name'] ?? $entry['value'] ?? '');
            if (!isset($seen[$identity])) {
                $seen[$identity] = true;
                $deduped[] = $entry;
            }
        }
        $analysis[$key] = $deduped;
    }
    return $analysis;
}
`;
