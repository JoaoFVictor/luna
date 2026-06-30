import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relatedContextBuiltIn } from "../../../src/capabilities/repository-context/built-ins.js";
import type { RepoContext } from "../../../src/capabilities/git/diff/types.js";
import {
  RelatedContextSchema,
  type RelatedContext
} from "../../../src/capabilities/repository-context/contracts.js";
import { importTargets } from "../../../src/capabilities/repository-context/file-analysis.js";
import { symbolNamesFromAnalysis } from "../../../src/capabilities/repository-context/symbol-analysis/index.js";
import { analyzeJavaScriptLike } from "../../../src/capabilities/repository-context/symbol-analysis/js-ts-vue.js";
import type { WorkflowState } from "../../../src/core/workflow/state.js";

async function write(root: string, filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function repoContext(files: RepoContext["files"]): RepoContext {
  return {
    repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    base_sha: "base",
    head_sha: "head",
    merge_base: "merge-base",
    files
  };
}

function stateFor(root: string): WorkflowState {
  return {
    invocation: {},
    repository: {
      id: "repo",
      provider: "github",
      owner: "octo-org",
      name: "hello-world",
      default_branch: "main",
      path: root
    },
    workspace: { path: root },
    run: { run_id: "run-1" },
    workflow: { id: "code-review", mode: "read_only" },
    steps: {}
  };
}

describe("repository-context.related_context", () => {
  it("keeps symbol references semantic instead of recording every identifier token", () => {
    const analysis = analyzeJavaScriptLike([
      "import { computed } from 'vue';",
      "interface ProfileRules { name: string }",
      "const displayName = computed(() => user.name);",
      "export function renderProfile(rules: ProfileRules) {",
      "  return displayName;",
      "}"
    ].join("\n"), "src/ProfileCard.ts");

    expect(analysis.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "computed", kind: "variable" }),
      expect.objectContaining({ name: "ProfileRules", kind: "type" })
    ]));
    expect(analysis.references).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Boolean" }),
      expect.objectContaining({ name: "const" }),
      expect.objectContaining({ name: "displayName", kind: "variable" }),
      expect.objectContaining({ name: "renderProfile", kind: "variable" }),
      expect.objectContaining({ name: "rules", kind: "variable" })
    ]));
    expect(symbolNamesFromAnalysis(analysis)).not.toEqual(expect.arrayContaining([
      "Boolean",
      "Map",
      "code",
      "const",
      "key",
      "ref"
    ]));
  });

  it("suppresses Vue parser warnings when content is known to be truncated", () => {
    const truncated = analyzeJavaScriptLike(
      "<template>\n  <section>\n",
      "src/ProfilePage.vue",
      { truncated: true }
    );
    const completeCandidate = analyzeJavaScriptLike(
      "<template>\n  <section>\n",
      "src/ProfilePage.vue"
    );

    expect(truncated.warnings).toEqual([]);
    expect(completeCandidate.warnings.length).toBeGreaterThan(0);
  });

  it("does not append source extensions to imports that already name a file", () => {
    expect(importTargets("../Support/ProfileFormatter.php", "app/Http/ProfileController.php")).toEqual([
      "app/Support/ProfileFormatter.php"
    ]);
    expect(importTargets("~/components/ProfileCard.vue", "app/pages/ProfilePage.ts")).toEqual([
      "app/components/ProfileCard.vue",
      "components/ProfileCard.vue",
      "src/components/ProfileCard.vue"
    ]);
  });

  it("rejects invalid related-context config before scanning the repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-invalid-"));

    try {
      await write(root, "src/app.ts", "export const App = 1;\n");

      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,1 @@\n+export const App = 1;\n",
              excerpt: {
                start_line: 1,
                end_line: 1,
                content: "export const App = 1;\n"
              }
            }
          ]),
          config: {
            max_related_files: 0
          }
        }
      })).rejects.toThrow("repository-context.related_context config must match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("centers changed-file excerpts on diff hunks instead of file prefixes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-hunks-"));

    try {
      const lines = Array.from({ length: 220 }, (_, index) =>
        index === 179 ? "export const touchedBusinessRule = true;" : `const filler${index + 1} = ${index + 1};`
      );
      await write(root, "src/LargeFeature.ts", `${lines.join("\n")}\n`);

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/LargeFeature.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -180,1 +180,1 @@\n+export const touchedBusinessRule = true;\n",
              excerpt: {
                start_line: 1,
                end_line: 20,
                content: lines.slice(0, 20).join("\n"),
                truncated: true
              }
            }
          ]),
          config: {
            max_related_files: 4,
            max_scan_files: 10,
            max_file_bytes: 12_000,
            max_excerpt_bytes: 600
          }
        }
      }) as RelatedContext;

      const changedFile = result.files.find((file) => file.path === "src/LargeFeature.ts");
      expect(changedFile?.excerpt?.start_line).toBeGreaterThan(1);
      expect(changedFile?.excerpt?.content).toContain("touchedBusinessRule");
      expect(changedFile?.excerpt?.content).not.toContain("filler1 = 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prioritizes code-impact relations when related context budget is tight", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-diverse-"));

    try {
      await write(root, "src/CheckoutFlow.ts", [
        "import { depA } from './depA';",
        "import { depB } from './depB';",
        "import { depC } from './depC';",
        "export function CheckoutFlow() { return depA() + depB() + depC(); }"
      ].join("\n"));
      await write(root, "src/depA.ts", "export function depA() { return 'a'; }\n");
      await write(root, "src/depB.ts", "export function depB() { return 'b'; }\n");
      await write(root, "src/depC.ts", "export function depC() { return 'c'; }\n");
      await write(root, "src/CheckoutFlow.test.ts", "import { CheckoutFlow } from './CheckoutFlow';\nCheckoutFlow();\n");
      await write(root, "src/CheckoutFlowDocs.ts", "export const checkoutFlowDocs = 'CheckoutFlow behavior';\n");
      await write(root, "docs/checkout.md", "CheckoutFlow behavior and review notes.\n");
      await write(root, "package.json", "{\"scripts\":{\"test\":\"vitest\"}}\n");
      await write(root, ".claude/settings.json", "{\"permissions\":{\"allow\":[\"Read\"]}}\n");
      await write(root, ".claude/rules/architecture.md", "CheckoutFlow local agent guidance.\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/CheckoutFlow.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,2 @@\n+export function CheckoutFlow() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 4,
                content: "export function CheckoutFlow() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 6,
            max_scan_files: 20,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "src/CheckoutFlow.ts",
        "src/depA.ts",
        "src/depB.ts",
        "src/depC.ts",
        "src/CheckoutFlow.test.ts",
        "src/CheckoutFlowDocs.ts"
      ]));
      expect(result.files.map((file) => file.path)).not.toContain("package.json");
      expect(result.files.map((file) => file.path)).not.toContain("docs/checkout.md");
      expect(result.files.map((file) => file.path)).not.toContain(".claude/settings.json");
      expect(result.files.map((file) => file.path)).not.toContain(".claude/rules/architecture.md");
      expect(result.files.map((file) => file.relation)).toEqual(expect.arrayContaining([
        "changed_file",
        "import_dependency",
        "test",
        "reverse_reference"
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes docs and config guidance when budget remains after code impact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-guidance-"));

    try {
      await write(root, "src/CheckoutFlow.ts", [
        "import { depA } from './depA';",
        "import { depB } from './depB';",
        "import { depC } from './depC';",
        "export function CheckoutFlow() { return depA() + depB() + depC(); }"
      ].join("\n"));
      await write(root, "src/depA.ts", "export function depA() { return 'a'; }\n");
      await write(root, "src/depB.ts", "export function depB() { return 'b'; }\n");
      await write(root, "src/depC.ts", "export function depC() { return 'c'; }\n");
      await write(root, "src/CheckoutFlow.test.ts", "import { CheckoutFlow } from './CheckoutFlow';\nCheckoutFlow();\n");
      await write(root, "src/CheckoutFlowDocs.ts", "export const checkoutFlowDocs = 'CheckoutFlow behavior';\n");
      await write(root, "docs/checkout.md", "CheckoutFlow behavior and review notes.\n");
      await write(root, "package.json", "{\"scripts\":{\"test\":\"vitest\"}}\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/CheckoutFlow.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,2 @@\n+export function CheckoutFlow() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 4,
                content: "export function CheckoutFlow() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 8,
            max_scan_files: 20,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "package.json",
        "docs/checkout.md"
      ]));
      expect(result.files.map((file) => file.relation)).toEqual(expect.arrayContaining([
        "config",
        "docs"
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds an auditable JS and PHP impact graph around changed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-"));

    try {
      await write(root, "src/UserProfile.ts", [
        "import { formatName } from './formatName';",
        "export function UserProfile() {",
        "  return formatName('Ada');",
        "}"
      ].join("\n"));
      await write(root, "src/formatName.ts", "export function formatName(name: string) { return name.trim(); }\n");
      await write(root, "src/routes.ts", "import { UserProfile } from './UserProfile';\nUserProfile();\n");
      await write(root, "src/UserProfile.test.ts", "import { UserProfile } from './UserProfile';\n");
      await write(root, "src/UserSettings.ts", "export function UserSettings() { return null; }\n");
      await write(root, "docs/profile.md", "UserProfile behavior and profile display rules.\n");
      await write(root, "package.json", "{\"scripts\":{\"test\":\"vitest\"}}\n");
      await write(root, "app/Http/ProfileController.php", [
        "<?php",
        "require_once '../Support/ProfileFormatter.php';",
        "function profile_controller() { return ProfileFormatter::format('Ada'); }"
      ].join("\n"));
      await write(root, "app/Support/ProfileFormatter.php", "<?php class ProfileFormatter { public static function format($name) { return trim($name); } }\n");
      await write(root, "app/Routes.php", "<?php require './Http/ProfileController.php';\n");
      await write(root, "tests/ProfileControllerTest.php", "<?php require '../app/Http/ProfileController.php';\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/UserProfile.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
              patch: "@@ -1,2 +1,3 @@\n+export function UserProfile() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 4,
                content: "export function UserProfile() {}\n"
              }
            },
            {
              path: "app/Http/ProfileController.php",
              status: "modified",
              additions: 2,
              deletions: 0,
              patch: "@@ -1,2 +1,3 @@\n+function profile_controller() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 3,
                content: "<?php function profile_controller() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 12,
            max_scan_files: 40,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(() => RelatedContextSchema.parse(result)).not.toThrow();
      expect(result).toMatchObject({
        kind: "luna.related_context.v1",
        schema_version: "1",
        repository: {
          full_name: "octo-org/hello-world"
        },
        base_sha: "base",
        head_sha: "head",
        merge_base: "merge-base",
        budgets: {
          max_related_files: 12,
          max_scan_files: 40
        },
        audit: {
          enabled: true
        }
      });
      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "src/UserProfile.ts",
        "app/Http/ProfileController.php",
        "src/formatName.ts",
        "src/routes.ts",
        "src/UserProfile.test.ts",
        "app/Support/ProfileFormatter.php",
        "app/Routes.php",
        "tests/ProfileControllerTest.php",
        "package.json",
        "docs/profile.md"
      ]));
      expect(result.nodes.map((node) => node.id)).toEqual(result.files.map((file) => file.path));
      expect(result.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "src/UserProfile.ts",
          reason: "File is changed by the pull request."
        }),
        expect.objectContaining({
          id: "src/formatName.ts",
          reason: "Changed file imports/includes this file."
        })
      ]));
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: "src/UserProfile.ts",
          to: "src/formatName.ts",
          type: "imports"
        }),
        expect.objectContaining({
          from: "src/routes.ts",
          to: "src/UserProfile.ts",
          type: "imports"
        }),
        expect.objectContaining({
          from: "src/UserProfile.test.ts",
          to: "src/UserProfile.ts",
          type: "tests"
        }),
        expect.objectContaining({
          from: "app/Http/ProfileController.php",
          to: "app/Support/ProfileFormatter.php"
        })
      ]));
      expect(result.audit.languages).toEqual(expect.arrayContaining([
        "php",
        "typescript",
        "json"
      ]));
      expect(result.audit.symbol_engines).toEqual(expect.arrayContaining([
        "typescript_ast",
        "php_heuristic"
      ]));
      expect(result.audit.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("PHP AST bridge unavailable")
      ]));
      expect(result.truncation.unsupported_files).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records budget truncation and unsupported changed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-budget-"));

    try {
      await write(root, "src/app.ts", "export const App = 1;\n");
      await write(root, "src/other.ts", "export const Other = App;\n");
      await write(root, "assets/logo.png", "not really binary in this fixture\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,1 @@\n+export const App = 1;\n",
              excerpt: {
                start_line: 1,
                end_line: 1,
                content: "export const App = 1;\n"
              }
            },
            {
              path: "assets/logo.png",
              status: "modified",
              additions: 0,
              deletions: 0,
              binary: true,
              patch_omitted_reason: "binary",
              patch: null,
              excerpt: null
            }
          ]),
          config: {
            max_related_files: 1,
            max_scan_files: 1,
            max_file_bytes: 12,
            max_excerpt_bytes: 8
          }
        }
      }) as RelatedContext;

      expect(result.files).toHaveLength(1);
      expect(result.truncation.unsupported_files).toEqual(["assets/logo.png"]);
      expect(result.audit.skipped_files).toBeGreaterThan(0);
      expect(result.audit.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Repository scan skipped")
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript path aliases and Composer PSR-4 namespaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-alias-"));

    try {
      await write(root, "tsconfig.json", JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: {
            "@/*": ["src/*"],
            "~shared/*": ["shared/*"]
          }
        }
      }));
      await write(root, "composer.json", JSON.stringify({
        autoload: {
          "psr-4": {
            "App\\": "app/",
            "Domain\\Shared\\": "domain/shared/"
          }
        }
      }));
      await write(root, "src/pages/ProfilePage.ts", [
        "import { formatName } from '@/utils/formatName';",
        "import { profileRules } from 'lib/profileRules';",
        "import ProfileCard from '~/components/ProfileCard.vue';",
        "export function ProfilePage() { return formatName(profileRules.name); }"
      ].join("\n"));
      await write(root, "src/utils/formatName.ts", "export function formatName(name: string) { return name; }\n");
      await write(root, "src/lib/profileRules.ts", "export const profileRules = { name: 'Ada' };\n");
      await write(root, "components/ProfileCard.vue", "<template><div /></template>\n");
      await write(root, "app/Http/ProfileController.php", [
        "<?php",
        "use App\\Support\\ProfileFormatter;",
        "function show_profile() { return ProfileFormatter::format('Ada'); }"
      ].join("\n"));
      await write(root, "app/Support/ProfileFormatter.php", "<?php namespace App\\Support; class ProfileFormatter {}\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/pages/ProfilePage.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,2 @@\n+export function ProfilePage() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 2,
                content: "export function ProfilePage() {}\n"
              }
            },
            {
              path: "app/Http/ProfileController.php",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,2 @@\n+function show_profile() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 3,
                content: "<?php function show_profile() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 10,
            max_scan_files: 20,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "src/utils/formatName.ts",
        "src/lib/profileRules.ts",
        "components/ProfileCard.vue",
        "app/Support/ProfileFormatter.php"
      ]));
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: "src/pages/ProfilePage.ts",
          to: "src/utils/formatName.ts",
          type: "imports"
        }),
        expect.objectContaining({
          from: "src/pages/ProfilePage.ts",
          to: "src/lib/profileRules.ts",
          type: "imports"
        }),
        expect.objectContaining({
          from: "src/pages/ProfilePage.ts",
          to: "components/ProfileCard.vue",
          type: "imports"
        }),
        expect.objectContaining({
          from: "app/Http/ProfileController.php",
          to: "app/Support/ProfileFormatter.php",
          type: "imports"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts Vue SFC script imports through the Luna-owned parser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-vue-"));

    try {
      await write(root, "app/components/ProfileCard.vue", [
        "<template><div>{{ displayName }}</div></template>",
        "<script setup lang=\"ts\">",
        "import { computed } from 'vue';",
        "import { useAuthStore } from '@/stores/auth';",
        "import { useProfileName } from '~/composables/useProfileName';",
        "const displayName = computed(() => `${useAuthStore().name}:${useProfileName()}`);",
        "</script>"
      ].join("\n"));
      await write(root, "composables/useProfileName.ts", [
        "export function useProfileName() {",
        "  return 'Ada';",
        "}"
      ].join("\n"));
      await write(root, "app/stores/auth.ts", "export const useAuthStore = () => ({ name: 'Ada' });\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "app/components/ProfileCard.vue",
              status: "modified",
              additions: 3,
              deletions: 0,
              patch: "@@ -1,1 +1,3 @@\n+<script setup lang=\"ts\">\n",
              excerpt: {
                start_line: 1,
                end_line: 6,
                content: "import { useProfileName } from '~/composables/useProfileName';\n"
              }
            }
          ]),
          config: {
            max_related_files: 5,
            max_scan_files: 10,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(() => RelatedContextSchema.parse(result)).not.toThrow();
      expect(result.audit.symbol_engines).toEqual(expect.arrayContaining([
        "vue_sfc_ast",
        "typescript_ast"
      ]));
      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "app/components/ProfileCard.vue",
        "app/stores/auth.ts",
        "composables/useProfileName.ts"
      ]));
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: "app/components/ProfileCard.vue",
          to: "app/stores/auth.ts",
          type: "imports"
        }),
        expect.objectContaining({
          from: "app/components/ProfileCard.vue",
          to: "composables/useProfileName.ts",
          type: "imports"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
