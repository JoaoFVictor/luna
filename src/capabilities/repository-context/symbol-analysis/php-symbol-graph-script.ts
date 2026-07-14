export const PHP_SYMBOL_GRAPH_SCRIPT = String.raw`
$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) {
    fwrite(STDERR, "Invalid JSON input\n");
    exit(2);
}

$files = $input['files'] ?? [];
if (!is_array($files)) {
    fwrite(STDERR, "Invalid files input\n");
    exit(2);
}

$autoload = '/usr/share/php/PhpParser/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "Luna PHP parser autoload not found\n");
    exit(3);
}

require_once $autoload;
if (!class_exists(\PhpParser\ParserFactory::class)) {
    fwrite(STDERR, "Luna PHP parser unavailable\n");
    exit(3);
}

$factory = new \PhpParser\ParserFactory();
if (method_exists($factory, 'createForNewestSupportedVersion')) {
    $parser = $factory->createForNewestSupportedVersion();
} else {
    $parser = $factory->create(\PhpParser\ParserFactory::PREFER_PHP7);
}

$result = ['files' => [], 'warnings' => []];
foreach ($files as $file) {
    if (!is_array($file)) {
        continue;
    }
    $relativePath = $file['path'] ?? null;
    $content = $file['content'] ?? null;
    if (!is_string($relativePath) || $relativePath === '' || !is_string($content)) {
        $result['warnings'][] = 'Skipped invalid PHP source entry';
        continue;
    }

    try {
        $ast = $parser->parse($content);
        $graph = [
            'path' => str_replace(DIRECTORY_SEPARATOR, '/', $relativePath),
            'occurrences' => [],
            'warnings' => [],
        ];
        collect_nodes($ast ?? [], $graph);
        $result['files'][] = dedupe_file($graph);
    } catch (\Throwable $exception) {
        $result['files'][] = [
            'path' => str_replace(DIRECTORY_SEPARATOR, '/', $relativePath),
            'occurrences' => [],
            'warnings' => [$exception->getMessage()],
        ];
    }
}

echo json_encode($result, JSON_THROW_ON_ERROR);

function collect_nodes(array $nodes, array &$graph): void {
    foreach ($nodes as $node) {
        if (!$node instanceof \PhpParser\Node) {
            continue;
        }

        collect_node($node, $graph);
        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof \PhpParser\Node) {
                collect_nodes([$child], $graph);
            } elseif (is_array($child)) {
                collect_nodes($child, $graph);
            }
        }
    }
}

function collect_node(\PhpParser\Node $node, array &$graph): void {
    $line = $node->getStartLine();

    if ($node instanceof \PhpParser\Node\Stmt\Namespace_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'namespace', 'roles' => ['definition'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Class_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'class', 'roles' => ['definition'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Interface_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'interface', 'roles' => ['definition'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Trait_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'trait', 'roles' => ['definition'], 'line' => $line];
    } elseif (class_exists(\PhpParser\Node\Stmt\Enum_::class) && $node instanceof \PhpParser\Node\Stmt\Enum_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'enum', 'roles' => ['definition'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\Function_ && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'function', 'roles' => ['definition'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Stmt\ClassMethod && $node->name !== null) {
        $graph['occurrences'][] = ['name' => $node->name->toString(), 'kind' => 'method', 'roles' => ['definition'], 'line' => $line];
    }

    if ($node instanceof \PhpParser\Node\Stmt\Use_) {
        foreach ($node->uses as $use) {
            $graph['occurrences'][] = ['name' => $use->name->toString(), 'kind' => 'class', 'roles' => ['import', 'reference'], 'line' => $line, 'import_value' => $use->name->toString(), 'import_kind' => 'use'];
        }
    } elseif ($node instanceof \PhpParser\Node\Stmt\GroupUse) {
        foreach ($node->uses as $use) {
            $value = $node->prefix->toString() . '\\' . $use->name->toString();
            $graph['occurrences'][] = ['name' => $value, 'kind' => 'class', 'roles' => ['import', 'reference'], 'line' => $line, 'import_value' => $value, 'import_kind' => 'use'];
        }
    } elseif ($node instanceof \PhpParser\Node\Name) {
        $graph['occurrences'][] = ['name' => $node->toString(), 'kind' => 'class', 'roles' => ['reference', 'read'], 'line' => $line];
    } elseif ($node instanceof \PhpParser\Node\Expr\Include_) {
        if ($node->expr instanceof \PhpParser\Node\Scalar\String_) {
            $kind = in_array($node->type, [\PhpParser\Node\Expr\Include_::TYPE_REQUIRE, \PhpParser\Node\Expr\Include_::TYPE_REQUIRE_ONCE], true)
                ? 'require'
                : 'include';
            $graph['occurrences'][] = ['name' => $node->expr->value, 'kind' => 'variable', 'roles' => ['import', 'reference'], 'line' => $line, 'import_value' => $node->expr->value, 'import_kind' => $kind];
        }
    }
}

function dedupe_file(array $graph): array {
    $seen = [];
    $deduped = [];
    foreach ($graph['occurrences'] as $entry) {
        $identity = ($entry['kind'] ?? '') . "\0" . ($entry['name'] ?? '') . "\0" . implode(',', $entry['roles'] ?? []) . "\0" . ($entry['line'] ?? '');
        if (!isset($seen[$identity])) {
            $seen[$identity] = true;
            $deduped[] = $entry;
        }
    }
    $graph['occurrences'] = $deduped;
    return $graph;
}
`;
