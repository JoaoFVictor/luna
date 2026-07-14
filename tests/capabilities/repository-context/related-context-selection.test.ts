import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relatedContextBuiltIn } from "../../../src/capabilities/repository-context/built-ins.js";
import { runGit } from "../../../src/capabilities/git/client.js";
import {
  RelatedContextSchema,
  type RelatedContext
} from "../../../src/capabilities/repository-context/contracts.js";
import {
  initializeGitRepository,
  repoContext,
  repoContextAtSha,
  stateFor,
  write
} from "./related-context-test-support.js";
import { fileKind } from "../../../src/capabilities/repository-context/file-analysis.js";
import { importTargets } from "../../../src/capabilities/repository-context/import-resolution.js";
import { analyzeJavaScriptLike } from "../../../src/capabilities/repository-context/symbol-analysis/js-ts-vue.js";

describe("repository-context.related_context core", () => {
  it("classifies PHP files in config directories without reclassifying application PHP", () => {
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
    expect(importTargets("~/components/ProfileCard.vue", "app/pages/ProfilePage.ts")).toEqual([]);
  });

  it("rejects invalid related-context config before scanning the repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-invalid-"));

    try {
      await write(root, "src/app.ts", "export const App = 1;\n");

      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: repoContextAtSha([
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

  it("fails closed when pull-request context belongs to another repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-repository-mismatch-"));
    try {
      const foreign = repoContextAtSha([]);
      foreign.repository = {
        owner: "other",
        name: "repository",
        full_name: "other/repository"
      };
      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: { repo_context: foreign }
      })).rejects.toThrow("belongs to other/repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the indexed checkout SHA is unrelated to the PR context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-sha-mismatch-"));
    await initializeGitRepository(root);
    try {
      await write(root, "src/app.ts", "export const app = true;\n");
      await runGit(root, ["add", "src/app.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna", "-c", "user.email=luna@example.test",
        "commit", "--quiet", "-m", "initial"
      ]);
      const mismatched = await repoContext(root, []);
      const checkoutSha = mismatched.head_sha;
      mismatched.base_sha = checkoutSha;
      mismatched.head_sha = "b".repeat(40);
      mismatched.merge_base = checkoutSha;

      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: { repo_context: mismatched }
      })).rejects.toThrow("not compatible with the supplied pull request context");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a non-head checkout only when capture explicitly authorizes its SHA", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-explicit-checkout-"));
    await initializeGitRepository(root);
    try {
      const captured = await repoContext(root, []);
      const checkoutSha = captured.head_sha;
      captured.head_sha = "b".repeat(40);
      captured.allowed_checkout_shas = [checkoutSha];

      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: { repo_context: captured }
      })).resolves.toMatchObject({
        snapshot: { head_sha: checkoutSha },
        head_sha: captured.head_sha
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects abbreviated or symbolic pull-request Git identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-invalid-oid-"));
    await initializeGitRepository(root);
    try {
      const invalid = await repoContext(root, []);
      invalid.head_sha = "head";

      await expect(relatedContextBuiltIn.run({
        state: stateFor(root),
        input: { repo_context: invalid }
      })).rejects.toThrow("source input does not match its schema");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("centers changed-file excerpts on diff hunks instead of file prefixes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-hunks-"));
    await initializeGitRepository(root);

    try {
      const lines = Array.from({ length: 220 }, (_, index) =>
        index === 179 ? "export const touchedBusinessRule = true;" : `const filler${index + 1} = ${index + 1};`
      );
      await write(root, "src/LargeFeature.ts", `${lines.join("\n")}\n`);

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: await repoContext(root, [
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
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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
            max_excerpt_bytes: 400
          }
        }
      }) as RelatedContext;

      expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "src/CheckoutFlow.ts",
        "src/depA.ts",
        "src/depB.ts",
        "src/CheckoutFlow.test.ts",
        "src/CheckoutFlowDocs.ts",
        "docs/checkout.md"
      ]));
      expect(result.files.map((file) => file.path)).not.toContain("package.json");
      expect(result.files.map((file) => file.path)).not.toContain(".claude/settings.json");
      expect(result.files.map((file) => file.path)).not.toContain(".claude/rules/architecture.md");
      expect(result.files.map((file) => file.relation)).toEqual(expect.arrayContaining([
        "changed_file",
        "import_dependency",
        "reverse_reference"
      ]));
      expect(result.files.find((file) => file.path === "src/CheckoutFlow.test.ts"))
        .toEqual(expect.objectContaining({
          relation: "reverse_reference",
          score_breakdown: expect.objectContaining({ test: 60 })
        }));
      expect(result.files.find((file) => file.path === "src/CheckoutFlowDocs.ts")?.matched_symbols).toEqual(expect.arrayContaining([
        expect.stringMatching(/^luna \. \. \. `src\/CheckoutFlow\.ts`\/CheckoutFlow\.$/u)
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply framework-specific path-role bonuses when dependency budget is tight", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-path-roles-"));
    await initializeGitRepository(root);

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
          repo_context: await repoContext(root, [
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
      expect(paths).toEqual(expect.arrayContaining([
        "app/models/UserPlan.ts"
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes docs and config guidance when budget remains after code impact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-related-context-guidance-"));
    await initializeGitRepository(root);

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
      await write(root, "package.json", "{\"scripts\":{\"checkoutFlow\":\"vitest\"}}\n");

      const result = await relatedContextBuiltIn.run({
        state: stateFor(root),
        input: {
          repo_context: await repoContext(root, [
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
});
