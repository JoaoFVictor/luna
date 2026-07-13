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
  it("extracts Vue SFC script imports through the Luna-owned parser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-vue-"));
    await initializeGitRepository(root);

    try {
      await write(root, "tsconfig.json", JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["app/*"],
            "~/*": ["*"]
          }
        }
      }));
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
          repo_context: await repoContext(root, [
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
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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

  it("uses deterministic task seeds and expands them through the canonical graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-task-"));
    await initializeGitRepository(root);

    try {
      await write(root, "src/BillingService.ts", "import { charge } from './charge';\nexport function bill() { return charge(); }\n");
      await write(root, "src/charge.ts", "import { ledger } from './ledger';\nexport function charge() { return ledger(); }\n");
      await write(root, "src/ledger.ts", "import { account } from './account';\nexport function ledger() { return account; }\n");
      await write(root, "src/account.ts", "export const account = true;\n");
      await write(root, "src/BillingBehaviorNote.ts", "export const billingBehaviorNote = true;\n");
      await write(root, "src/unrelated.ts", "export const unrelated = true;\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          task: {
            text: "Change billing behavior",
            paths: ["src/BillingService.ts"],
            symbols: ["bill"]
          },
          config: {
            max_seed_files: 1,
            max_related_files: 5,
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(result.source).toEqual({ kind: "task" });
      expect(result.seed_files).toEqual(["src/BillingService.ts"]);
      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "src/BillingService.ts",
        "src/charge.ts",
        "src/ledger.ts",
        "src/account.ts"
      ]));
      expect(result.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "src/BillingBehaviorNote.ts",
          relation: "query_match"
        })
      ]));
      expect(result.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "src/BillingBehaviorNote.ts",
          source: "lexical_retrieval"
        })
      ]));
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "src/BillingService.ts", to: "src/charge.ts" }),
        expect.objectContaining({ from: "src/charge.ts", to: "src/ledger.ts" }),
        expect.objectContaining({ from: "src/ledger.ts", to: "src/account.ts" })
      ]));
      expect(result.snapshot.dirty).toBe(true);
      expect(result.coverage.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps worktree diff seeds while retaining the complete changed-file inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-worktree-"));
    await initializeGitRepository(root);

    try {
      await write(root, "src/a.ts", "export const a = 1;\n");
      await write(root, "src/b.ts", "export const b = 1;\n");
      await write(root, "src/c.ts", "export const c = 1;\n");
      const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          worktree_diff: {
            diff: {
              files: files.map((filePath) => ({
                path: filePath,
                status: "modified",
                index_status: " ",
                worktree_status: "M"
              })),
              untracked_files: [],
              untracked_summaries: [],
              staged_diff: "",
              unstaged_diff: "+export const changed = true;",
              staged_diff_truncated: false,
              unstaged_diff_truncated: false,
              max_diff_bytes: 10_000,
              status_files_omitted_count: 0,
              untracked_files_omitted_count: 0,
              untracked_summary_bytes: 0,
              max_untracked_summary_bytes: 4_194_304
            }
          },
          config: {
            max_seed_files: 1,
            max_related_files: 3,
            max_excerpt_bytes: 200
          }
        }
      }) as RelatedContext;

      expect(result.source).toEqual({ kind: "worktree_diff" });
      expect(result.changed_files).toEqual(files);
      expect(result.seed_files).toEqual(["src/a.ts"]);
      expect(result.truncation.unseeded_changed_paths).toEqual(["src/b.ts", "src/c.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps pull-request seeds and never emits graph edges outside selected nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-pr-seeds-"));
    await initializeGitRepository(root);

    try {
      await write(root, "src/a.ts", "import { shared } from './shared';\nexport const a = shared;\n");
      await write(root, "src/b.ts", "import { shared } from './shared';\nexport const b = shared;\n");
      await write(root, "src/c.ts", "import { shared } from './shared';\nexport const c = shared;\n");
      await write(root, "src/shared.ts", "export const shared = true;\n");
      const changedFiles: RepoContext["files"] = ["src/c.ts", "src/a.ts", "src/b.ts"].map((filePath) => ({
        path: filePath,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,1 @@\n+export const changed = true;\n",
        excerpt: null
      }));
      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: await repoContext(root, changedFiles),
          config: {
            max_seed_files: 2,
            max_related_files: 4,
            max_excerpt_bytes: 200
          }
        }
      }) as RelatedContext;

      expect(result.changed_files).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
      expect(result.seed_files).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.truncation.unseeded_changed_paths).toEqual(["src/c.ts"]);
      const selected = new Set(result.nodes.map((node) => node.id));
      expect(result.edges.every((edge) => selected.has(edge.from) && selected.has(edge.to))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
