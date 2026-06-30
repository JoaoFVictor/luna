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
import {
  fileKind,
  importTargets
} from "../../../src/capabilities/repository-context/file-analysis.js";
import {
  analyzeJavaScriptLike
} from "../../../src/capabilities/repository-context/symbol-analysis/js-ts-vue.js";
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
  it("classifies PHP framework config files as config without reclassifying app PHP", () => {
    expect(fileKind("config/autoload/dependencies.php")).toBe("config");
    expect(fileKind("app/Service/Post/PostMountListService.php")).toBe("source");
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
      await write(root, "src/CheckoutFlowDocs.ts", [
        "import { CheckoutFlow } from './CheckoutFlow';",
        "export const checkoutFlowDocs = CheckoutFlow.name;"
      ].join("\n"));
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
      expect(result.files.find((file) => file.path === "src/CheckoutFlowDocs.ts")?.matched_symbols).toEqual(expect.arrayContaining([
        expect.stringMatching(/^luna \. \. \. `src\/CheckoutFlow\.ts`\/CheckoutFlow\.$/u)
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers behavioral collaborators over passive models when dependency budget is tight", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-path-roles-"));

    try {
      await write(root, "app/use-cases/GrantPlan.ts", [
        "import { UserPlan } from '../models/UserPlan';",
        "import { UserPlanRepository } from '../repositories/UserPlanRepository';",
        "import { ManageFeatureExpiration } from '../services/ManageFeatureExpiration';",
        "export function grantPlan(repo: UserPlanRepository, manager: ManageFeatureExpiration, plan: UserPlan) {",
        "  manager.handle(plan);",
        "  return repo.save(plan);",
        "}"
      ].join("\n"));
      await write(root, "app/models/UserPlan.ts", "export interface UserPlan { id: string; }\n");
      await write(root, "app/repositories/UserPlanRepository.ts", [
        "import type { UserPlan } from '../models/UserPlan';",
        "export class UserPlanRepository { save(plan: UserPlan) { return plan; } }"
      ].join("\n"));
      await write(root, "app/services/ManageFeatureExpiration.ts", [
        "import type { UserPlan } from '../models/UserPlan';",
        "export class ManageFeatureExpiration { handle(plan: UserPlan) { return plan.id; } }"
      ].join("\n"));
      await write(root, "app/controllers/GrantPlanController.ts", [
        "import { grantPlan } from '../use-cases/GrantPlan';",
        "export function handleGrant() { return grantPlan; }"
      ].join("\n"));

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "app/use-cases/GrantPlan.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -4,1 +4,1 @@\n+export function grantPlan() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 7,
                content: "export function grantPlan() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 4,
            max_scan_files: 20,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      const paths = result.files.map((file) => file.path);
      expect(paths).toEqual(expect.arrayContaining([
        "app/use-cases/GrantPlan.ts",
        "app/controllers/GrantPlanController.ts"
      ]));
      expect(paths).toEqual(expect.arrayContaining([
        expect.stringMatching(/^app\/(repositories|services)\//u)
      ]));
      expect(paths).not.toEqual(expect.arrayContaining([
        "app/models/UserPlan.ts"
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
        "typescript_symbol_graph",
        "php_heuristic"
      ]));
      expect(result.audit.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("PHP symbol graph bridge unavailable")
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

  it("records omitted ranked paths and only emits edges between selected nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-omitted-"));

    try {
      await write(root, "src/Changed.ts", [
        "import { UsedDependency } from './UsedDependency';",
        "export function Changed() { return UsedDependency(); }"
      ].join("\n"));
      await write(root, "src/UsedDependency.ts", "export function UsedDependency() { return true; }\n");
      await write(root, "src/Changed.test.ts", "import { Changed } from './Changed';\nChanged();\n");
      await write(root, "src/ChangedDocs.ts", "import { Changed } from './Changed';\nChanged();\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "src/Changed.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,1 @@\n+export function Changed() {}\n",
              excerpt: {
                start_line: 1,
                end_line: 2,
                content: "export function Changed() {}\n"
              }
            }
          ]),
          config: {
            max_related_files: 2,
            max_scan_files: 10,
            max_file_bytes: 8000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      const selectedPaths = new Set(result.nodes.map((node) => node.id));
      expect(result.truncation.omitted_paths.length).toBeGreaterThan(0);
      expect(result.truncation.omitted_count).toBeGreaterThanOrEqual(result.truncation.omitted_paths.length);
      expect(result.truncation.omitted_paths).not.toEqual(expect.arrayContaining([...selectedPaths]));
      for (const edge of result.edges) {
        expect(selectedPaths.has(edge.from)).toBe(true);
        expect(selectedPaths.has(edge.to)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips generated runtime and storage outputs during repository scans", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-generated-"));

    try {
      await write(root, "composer.json", "{\"autoload\":{\"psr-4\":{\"App\\\\\":\"app/\"}}}\n");
      await write(root, "app/Request/Post/PostCreateRequest.php", [
        "<?php",
        "namespace App\\Request\\Post;",
        "class PostCreateRequest {}"
      ].join("\n"));
      await write(root, "app/Controller/Post/PostCreateController.php", [
        "<?php",
        "namespace App\\Controller\\Post;",
        "use App\\Request\\Post\\PostCreateRequest;",
        "class PostCreateController { public function __invoke(PostCreateRequest $request): void {} }"
      ].join("\n"));
      await write(root, "runtime/container/proxy/App_Controller_Post_PostCreateController.proxy.php", [
        "<?php",
        "use App\\Request\\Post\\PostCreateRequest;",
        "class App_Controller_Post_PostCreateController_proxy { public function __invoke(PostCreateRequest $request): void {} }"
      ].join("\n"));
      await write(root, "storage/swagger/openapi.json", "{\"components\":{}}\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "app/Request/Post/PostCreateRequest.php",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,1 +1,1 @@\n+class PostCreateRequest {}\n",
              excerpt: null
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
        "app/Request/Post/PostCreateRequest.php",
        "app/Controller/Post/PostCreateController.php"
      ]));
      expect(result.files.map((file) => file.path)).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^runtime\//u),
        expect.stringMatching(/^storage\//u)
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
        "vue_sfc_symbol_graph",
        "typescript_symbol_graph"
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

  it("links reverse references in large Vue SFC files when script imports are late in the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-large-vue-"));

    try {
      await write(root, "app/components/AccountVerification.vue", [
        "<template><section>Verify</section></template>",
        "<script setup lang=\"ts\">",
        "defineOptions({ name: 'AccountVerification' });",
        "</script>"
      ].join("\n"));
      await write(root, "app/components/DesktopSidebar.vue", [
        "<template>",
        "  <aside>",
        "    <AccountVerification />",
        "  </aside>",
        "</template>",
        ...Array.from({ length: 900 }, (_, index) => `<!-- filler ${index} -->`),
        "<script setup lang=\"ts\">",
        "const AccountVerification = defineAsyncComponent(() => import('./AccountVerification.vue'));",
        "</script>"
      ].join("\n"));

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContext([
            {
              path: "app/components/AccountVerification.vue",
              status: "modified",
              additions: 2,
              deletions: 0,
              patch: "@@ -1,2 +1,4 @@\n+defineOptions({ name: 'AccountVerification' });\n",
              excerpt: null
            }
          ]),
          config: {
            max_related_files: 4,
            max_scan_files: 10,
            max_file_bytes: 160_000,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(() => RelatedContextSchema.parse(result)).not.toThrow();
      const sidebar = result.files.find((file) => file.path === "app/components/DesktopSidebar.vue");
      expect(sidebar).toEqual(expect.objectContaining({
        relation: "reverse_reference"
      }));
      expect(sidebar?.matched_symbols).toEqual(expect.arrayContaining([
        expect.stringMatching(/^luna \. \. \. `app\/components\/AccountVerification\.vue`\/AccountVerification#$/)
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
