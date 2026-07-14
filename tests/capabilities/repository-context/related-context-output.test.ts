import { mkdtemp, rm } from "node:fs/promises";
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
  initializeGitRepository,
  repoContext,
  stateFor,
  write
} from "./related-context-test-support.js";

describe("repository-context.related_context output and task sources", () => {
  it("records omitted ranked paths and only emits edges between selected nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-omitted-"));
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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
    await initializeGitRepository(root);

    try {
      await write(root, "tsconfig.json", JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: {
            "@/*": ["*"],
            "~/*": ["../*"],
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
          repo_context: await repoContext(root, [
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
});
