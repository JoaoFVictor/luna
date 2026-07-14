import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/capabilities/repository-context/file-analysis.js";
import {
  importTargets,
  projectImportResolutionFrom
} from "../../../src/capabilities/repository-context/import-resolution.js";
import { analyzeFileSymbolGraph } from "../../../src/capabilities/repository-context/symbol-analysis/index.js";

function manifest(filePath: string, content: object | string): Candidate {
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  return {
    path: filePath,
    absolutePath: `/repository/${filePath}`,
    content: serialized,
    truncated: false,
    language: "json",
    kind: "config",
    symbol_graph: analyzeFileSymbolGraph(serialized, filePath),
    symbols: [],
    imports: []
  };
}

function source(filePath: string, content = "export const service = true;\n"): Candidate {
  return {
    path: filePath,
    absolutePath: `/repository/${filePath}`,
    content,
    truncated: false,
    language: "typescript",
    kind: "source",
    symbol_graph: analyzeFileSymbolGraph(content, filePath),
    symbols: [],
    imports: []
  };
}

describe("monorepo import resolution", () => {
  it("uses the nearest ancestral TS/JS manifest without aliases bleeding across packages", () => {
    const resolution = projectImportResolutionFrom([
      manifest("tsconfig.json", {
        compilerOptions: { paths: { "@/*": ["root-src/*"] } }
      }),
      manifest("packages/alpha/tsconfig.json", {
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        }
      }),
      manifest("packages/beta/jsconfig.json", {
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["lib/*"] }
        }
      }),
      source("root-src/service.ts"),
      source("packages/alpha/src/service.ts"),
      source("packages/beta/lib/service.ts")
    ]);

    expect(importTargets("@/service", "packages/alpha/app/main.ts", resolution))
      .toContain("packages/alpha/src/service.ts");
    expect(importTargets("@/service", "packages/alpha/app/main.ts", resolution))
      .not.toEqual(expect.arrayContaining([
        "packages/beta/lib/service.ts",
        "root-src/service.ts"
      ]));
    expect(importTargets("@/service", "packages/beta/app/main.ts", resolution))
      .toContain("packages/beta/lib/service.ts");
    expect(importTargets("@/service", "apps/standalone/main.ts", resolution))
      .toContain("root-src/service.ts");
  });

  it("resolves nested Composer PSR-4 directories relative to their manifest scope", () => {
    const resolution = projectImportResolutionFrom([
      manifest("composer.json", {
        autoload: { "psr-4": { "Domain\\": "src/" } }
      }),
      manifest("packages/alpha/composer.json", {
        autoload: { "psr-4": { "Domain\\": "app/Domain/" } },
        "autoload-dev": { "psr-4": { "Tests\\": "tests/" } }
      }),
      manifest("packages/beta/composer.json", {
        autoload: { "psr-4": { "Domain\\": ["lib/Domain/", "generated/"] } }
      })
    ]);

    expect(importTargets("use:Domain\\Order", "packages/alpha/app/Controller.php", resolution))
      .toEqual(["packages/alpha/app/Domain/Order.php"]);
    expect(importTargets("use:Domain\\Order", "packages/beta/app/Controller.php", resolution))
      .toEqual([
        "packages/beta/generated/Order.php",
        "packages/beta/lib/Domain/Order.php"
      ]);
    expect(importTargets("use:Domain\\Order", "app/Controller.php", resolution))
      .toEqual(["src/Order.php"]);
    expect(importTargets("use:Tests\\OrderTest", "packages/alpha/tests/OrderTest.php", resolution))
      .toEqual(["packages/alpha/tests/OrderTest.php"]);
  });

  it("parses JSONC local extends with official compiler-option override semantics", () => {
    const resolution = projectImportResolutionFrom([
      manifest("configs/base.json", `{
        // parent aliases stay relative to this captured config
        "compilerOptions": {
          "paths": { "@base/*": ["../shared/*"], },
        },
      }`),
      manifest("packages/isolated/tsconfig.json", `{
        "extends": "../../configs/base.json",
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@local/*": ["src/*"], },
        },
      }`),
      source("shared/service.ts"),
      source("packages/isolated/src/service.ts")
    ]);

    expect(importTargets("@base/service", "packages/isolated/main.ts", resolution))
      .not.toContain("shared/service.ts");
    expect(importTargets("@local/service", "packages/isolated/main.ts", resolution))
      .toContain("packages/isolated/src/service.ts");
    expect(resolution.warnings).toEqual([]);
  });

  it("uses the TypeScript resolver for NodeNext emitted .js specifiers", () => {
    const resolution = projectImportResolutionFrom([
      manifest("tsconfig.json", {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext"
        }
      }),
      source("src/main.ts", "import { value } from './value.js';\n"),
      source("src/value.ts", "export const value = 1;\n")
    ]);

    expect(importTargets("./value.js", "src/main.ts", resolution))
      .toEqual(["src/value.ts"]);
  });

  it("ignores external, outside-root, and cyclic extends with audit warnings", () => {
    const resolution = projectImportResolutionFrom([
      manifest("packages/cycle/tsconfig.json", {
        extends: "./base.json"
      }),
      manifest("packages/cycle/base.json", {
        extends: "./tsconfig.json"
      }),
      manifest("packages/outside/tsconfig.json", {
        extends: "../../../../outside.json"
      }),
      manifest("packages/external/tsconfig.json", {
        extends: "@company/tsconfig"
      })
    ]);

    expect(resolution.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Circularity detected"),
      expect.stringContaining("Cannot read file '/outside.json'"),
      expect.stringContaining("File '@company/tsconfig' not found")
    ]));
  });
});
