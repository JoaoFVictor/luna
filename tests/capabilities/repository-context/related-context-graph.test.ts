import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relatedContextBuiltIn } from "../../../src/capabilities/repository-context/built-ins.js";
import {
  RelatedContextSchema,
  type RelatedContext
} from "../../../src/capabilities/repository-context/contracts.js";
import {
  initializeGitRepository,
  repoContext,
  stateFor,
  write
} from "./related-context-test-support.js";
import { fileKind } from "../../../src/capabilities/repository-context/file-analysis.js";
import { importTargets } from "../../../src/capabilities/repository-context/import-resolution.js";
import { analyzeJavaScriptLike } from "../../../src/capabilities/repository-context/symbol-analysis/js-ts-vue.js";

describe("repository-context.related_context core", () => {
  it("builds an auditable JS and PHP impact graph around changed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-"));
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(() => RelatedContextSchema.parse(result)).not.toThrow();
      expect(result).toMatchObject({
        kind: "luna.repository_context.v2",
        schema_version: "2",
        source: { kind: "pull_request_diff" },
        repository: {
          full_name: "octo-org/hello-world"
        },
        base_sha: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        head_sha: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        merge_base: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        budgets: {
          max_related_files: 12,
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
          reason: "1-hop import/include relation through src/UserProfile.ts."
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
        expect.stringContaining("PHP structural coverage unavailable")
      ]));
      expect(result.truncation.unsupported_files).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records budget truncation and unsupported changed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-budget-"));
    await initializeGitRepository(root);

    try {
      await write(root, "src/app.ts", "export const App = 1;\n");
      await write(root, "src/other.ts", "export const Other = App;\n");
      await write(root, "assets/logo.png", "not really binary in this fixture\n");
      await write(root, "src/rules.unknownext", "generic searchable text\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: await repoContext(root, [
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
            },
            {
              path: "src/rules.unknownext",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+generic searchable text\n",
              excerpt: {
                start_line: 1,
                end_line: 1,
                content: "generic searchable text\n"
              }
            }
          ]),
          config: {
            max_related_files: 1,
            max_excerpt_bytes: 8
          }
        }
      }) as RelatedContext;

      expect(result.files).toHaveLength(1);
      expect(result.truncation.unsupported_files).toEqual(["assets/logo.png"]);
      expect(result.coverage.complete).toBe(true);
      expect(result.audit.skipped_files).toBe(0);
      expect(result.audit.warnings).not.toEqual(expect.arrayContaining([
        expect.stringContaining("Repository scan skipped")
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
