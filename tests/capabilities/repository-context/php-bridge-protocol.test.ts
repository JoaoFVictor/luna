import { describe, expect, it } from "vitest";
import { enrichPhpCandidatesWithNikic } from "../../../src/capabilities/repository-context/symbol-analysis/php-bridge.js";
import { PHP_SYMBOL_GRAPH_SCRIPT } from "../../../src/capabilities/repository-context/symbol-analysis/php-symbol-graph-script.js";

describe("PHP symbol graph bridge protocol", () => {
  it("accepts candidates plus cancellation without a repository-root argument", async () => {
    expect(enrichPhpCandidatesWithNikic).toHaveLength(2);
    await expect(enrichPhpCandidatesWithNikic([])).resolves.toEqual({
      candidates: [],
      warnings: []
    });
  });

  it("parses stdin content and contains no repository filesystem operations", () => {
    expect(PHP_SYMBOL_GRAPH_SCRIPT).not.toMatch(/\brealpath\s*\(/u);
    expect(PHP_SYMBOL_GRAPH_SCRIPT).not.toMatch(/\bfile_get_contents\s*\(/u);
    expect(PHP_SYMBOL_GRAPH_SCRIPT).not.toContain("$input['root']");
    expect(PHP_SYMBOL_GRAPH_SCRIPT).toContain("$file['path']");
    expect(PHP_SYMBOL_GRAPH_SCRIPT).toContain("$file['content']");
    expect(PHP_SYMBOL_GRAPH_SCRIPT).toContain("$parser->parse($content)");
  });
});
