import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCandidate
} from "../../../src/capabilities/repository-context/candidate-reader.js";
import {
  importTargets,
  projectImportResolutionFrom
} from "../../../src/capabilities/repository-context/import-resolution.js";
import {
  linkProjectSymbolReferences,
  primaryDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionSymbolsFromGraph,
  reverseReferenceDefinitionTermsFromGraph,
  reverseReferenceTermsFromGraph,
  symbolNamesFromGraph
} from "../../../src/capabilities/repository-context/symbol-analysis/index.js";
import { analyzeJavaScriptLike } from "../../../src/capabilities/repository-context/symbol-analysis/js-ts-vue.js";

async function write(root: string, filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

describe("repository-context symbol graph", () => {
  it("keeps symbol graph occurrences semantic instead of recording every identifier token", () => {
    const graph = analyzeJavaScriptLike([
      "import { computed } from 'vue';",
      "interface ProfileRules { name: string }",
      "const displayName = computed(() => user.name);",
      "export function renderProfile(rules: ProfileRules) {",
      "  return displayName;",
      "}"
    ].join("\n"), "src/ProfileCard.ts");

    expect(graph.document.position_encoding).toBe("UTF16CodeUnitOffsetFromLineStart");
    expect(graph.document.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        display_name: "renderProfile",
        kind: 17,
        local_kind: "function"
      })
    ]));
    expect(graph.document.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        display_name: "vue",
        import_value: "vue",
        import_kind: "import",
        roles: expect.arrayContaining(["import", "reference"]),
        symbol_roles: 10,
        single_line_range: expect.objectContaining({ line: 0 }),
        range: expect.objectContaining({ start_line: 0 })
      }),
      expect.objectContaining({
        display_name: "computed",
        kind: "variable",
        roles: expect.arrayContaining(["reference"])
      }),
      expect.objectContaining({
        display_name: "ProfileRules",
        kind: "type",
        roles: expect.arrayContaining(["reference"])
      })
    ]));
    expect(graph.document.occurrences).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ display_name: "Boolean" }),
      expect.objectContaining({ display_name: "const" }),
      expect.objectContaining({ display_name: "displayName", kind: "variable", roles: ["reference"] }),
      expect.objectContaining({ display_name: "renderProfile", kind: "variable", roles: ["reference"] }),
      expect.objectContaining({ display_name: "rules", kind: "variable", roles: ["reference"] })
    ]));
    expect(symbolNamesFromGraph(graph)).not.toEqual(expect.arrayContaining([
      "Boolean",
      "Map",
      "code",
      "const",
      "key",
      "ref"
    ]));
  });

  it("derives reverse-reference terms from graph references instead of text mentions", () => {
    const changedGraph = analyzeJavaScriptLike(
      "export function CheckoutFlow() { return true; }\n",
      "src/CheckoutFlow.ts"
    );
    const textOnlyGraph = analyzeJavaScriptLike(
      "export const checkoutFlowDocs = 'CheckoutFlow behavior';\n",
      "src/CheckoutFlowDocs.ts"
    );
    const importGraph = analyzeJavaScriptLike([
      "import { CheckoutFlow } from './CheckoutFlow';",
      "export const checkoutFlowDocs = CheckoutFlow.name;"
    ].join("\n"), "src/CheckoutFlowDocs.ts");

    expect(reverseReferenceDefinitionTermsFromGraph(changedGraph)).toContain("CheckoutFlow");
    expect(reverseReferenceTermsFromGraph(textOnlyGraph)).not.toContain("CheckoutFlow");
    expect(reverseReferenceTermsFromGraph(importGraph)).toContain("CheckoutFlow");
  });

  it("links imported references to the resolved definition symbol", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-symbol-link-"));

    try {
      await write(root, "src/CheckoutFlow.ts", "export function CheckoutFlow() { return true; }\n");
      await write(root, "src/CheckoutFlowDocs.ts", [
        "import { CheckoutFlow } from './CheckoutFlow';",
        "export const checkoutFlowDocs = CheckoutFlow.name;"
      ].join("\n"));

      const candidates = [
        await readCandidate(root, "src/CheckoutFlow.ts", 8_000),
        await readCandidate(root, "src/CheckoutFlowDocs.ts", 8_000)
      ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
      const importResolution = projectImportResolutionFrom(candidates);
      const linked = linkProjectSymbolReferences(
        candidates,
        (importValue, fromPath) => importTargets(importValue, fromPath, importResolution)
      );
      const definitionSymbol = linked
        .find((candidate) => candidate.path === "src/CheckoutFlow.ts")
        ?.symbol_graph.document.symbols.find((symbol) => symbol.display_name === "CheckoutFlow")
        ?.symbol;
      const referenceSymbols = linked
        .find((candidate) => candidate.path === "src/CheckoutFlowDocs.ts")
        ?.symbol_graph.document.occurrences
        .filter((occurrence) => occurrence.display_name === "CheckoutFlow")
        .map((occurrence) => occurrence.symbol);

      expect(definitionSymbol).toMatch(/^luna \. \. \. `src\/CheckoutFlow\.ts`\/CheckoutFlow\.$/u);
      expect(referenceSymbols).toContain(definitionSymbol);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers file-primary definitions for import-based reverse-reference evidence", () => {
    const graph = analyzeJavaScriptLike([
      "interface EnsureFeatureAccessOptions { force?: boolean }",
      "const localHelper = () => true;",
      "export const useFeatureAccess = () => localHelper();"
    ].join("\n"), "src/composables/useFeatureAccess.ts");

    expect(primaryDefinitionSymbolsFromGraph(graph)).toEqual([
      "luna . . . `src/composables/useFeatureAccess.ts`/useFeatureAccess."
    ]);
    expect(reverseReferenceDefinitionSymbolsFromGraph(graph)).toContain(
      "luna . . . `src/composables/useFeatureAccess.ts`/useFeatureAccess."
    );
  });

  it("keeps Vue SFC symbol ranges in the containing file coordinate space", () => {
    const graph = analyzeJavaScriptLike([
      "<template><AccountVerification :show=\"displayName\" /></template>",
      "<script setup lang=\"ts\">",
      "import { computed } from 'vue';",
      "const displayName = computed(() => 'Ada');",
      "</script>"
    ].join("\n"), "src/ProfileCard.vue");

    expect(graph.engine).toBe("vue_sfc_symbol_graph");
    expect(graph.document.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        display_name: "AccountVerification",
        kind: "component",
        roles: expect.arrayContaining(["reference"]),
        symbol_roles: 8,
        range: expect.objectContaining({ start_line: 0 })
      }),
      expect.objectContaining({
        display_name: "vue",
        import_value: "vue",
        roles: expect.arrayContaining(["import", "reference"]),
        range: expect.objectContaining({ start_line: 2 })
      }),
      expect.objectContaining({
        display_name: "displayName",
        roles: expect.arrayContaining(["definition"]),
        range: expect.objectContaining({ start_line: 3 })
      })
    ]));
  });
});
