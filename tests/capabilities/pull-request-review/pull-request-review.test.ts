import { describe, expect, it, vi } from "vitest";
import {
  createPullRequestReviewPublishBuiltIn
} from "../../../src/capabilities/pull-request-review/built-ins.js";
import type {
  PullRequestReviewProviderFactory,
  PullRequestReviewProviderPort
} from "../../../src/capabilities/pull-request-review/contracts.js";
import {
  PullRequestReviewResolvedInputSchema
} from "../../../src/capabilities/pull-request-review/contracts.js";
import {
  publishAuthoringInputSchema
} from "../../../src/capabilities/pull-request-review/manifest.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import { createProviderRegistry } from "../../../src/core/providers/registry.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "code-review", mode: "read_only" },
  steps: {}
};

function factoryFor(
  port: PullRequestReviewProviderPort
): PullRequestReviewProviderFactory {
  return {
    provider_id: port.provider_id,
    createProvider: () => port
  };
}

function providerRegistry(
  factories: readonly PullRequestReviewProviderFactory[]
) {
  return createProviderRegistry(factories, {
    label: "pull request review",
    unsupportedCode: "pull_request_review_provider_unsupported"
  });
}

describe("pull-request-review capability", () => {
  it("keeps concrete authoring input aligned with the resolved built-in contract", () => {
    const input = {
      enabled: true,
      provider_id: "example",
      repository_path: "/repo/workspace",
      pull_request: {
        owner: "octo-org",
        repo: "hello-world",
        number: 42
      },
      event: "request_changes",
      body: "Luna found issues.",
      inline_comments: true
    };

    expect(matchesJsonSchema(publishAuthoringInputSchema, input)).toBe(true);
    expect(PullRequestReviewResolvedInputSchema.safeParse(input).success).toBe(true);
  });

  it("publishes request changes with inline comments for findings on right-side diff lines", async () => {
    const provider: PullRequestReviewProviderPort = {
      provider_id: "example",
      publishReview: vi.fn<PullRequestReviewProviderPort["publishReview"]>(
        async (input) => ({
          operation_id: "pull-request-review.publish",
          enabled: true,
          skipped: false,
          provider: "example",
          provider_id: "example",
          external_id: "review-1",
          url: "https://example.test/review-1",
          event: input.event,
          inline_comments: input.comments.length,
          fallback_comments: input.fallback_comments.length
        })
      )
    };
    const builtIn = createPullRequestReviewPublishBuiltIn({
      providers: providerRegistry([factoryFor(provider)])
    });

    await expect(
      builtIn.run({
        state,
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          pull_request: {
            owner: "octo-org",
            repo: "hello-world",
            number: 42
          },
          event: "request_changes",
          body: "Luna found issues.",
          findings: {
            findings: [
              {
                title: "Missing null guard",
                severity: "high",
                confidence: "high",
                description: "The changed branch can dereference null.",
                evidence: [
                  {
                    path: "src/app.ts",
                    line_start: 43,
                    line_end: 43
                  }
                ],
                recommendation: "Guard the nullable value before use."
              }
            ]
          },
          repo_context: {
            repository: {
              owner: "octo-org",
              name: "hello-world",
              full_name: "octo-org/hello-world"
            },
            base_sha: "base",
            head_sha: "head",
            files: [
              {
                path: "src/app.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch:
                  "diff --git a/src/app.ts b/src/app.ts\n@@ -41,3 +41,4 @@\n context\n context\n+dangerousCall(value)\n context\n",
                excerpt: {
                  start_line: 41,
                  end_line: 44,
                  content: "context\ncontext\ndangerousCall(value)\ncontext\n"
                }
              }
            ]
          }
        }
      })
    ).resolves.toMatchObject({
      external_id: "review-1",
      inline_comments: 1,
      fallback_comments: 0
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request_changes",
        comments: [
          expect.objectContaining({
            path: "src/app.ts",
            line: 43,
            body: expect.stringContaining("Missing null guard")
          })
        ],
        fallback_comments: []
      })
    );
  });

  it("falls back to the review body when evidence is not on a right-side diff line", async () => {
    const provider: PullRequestReviewProviderPort = {
      provider_id: "example",
      publishReview: vi.fn<PullRequestReviewProviderPort["publishReview"]>(
        async (input) => ({
          operation_id: "pull-request-review.publish",
          enabled: true,
          skipped: false,
          provider: "example",
          provider_id: "example",
          external_id: "review-2",
          url: "https://example.test/review-2",
          event: input.event,
          inline_comments: input.comments.length,
          fallback_comments: input.fallback_comments.length
        })
      )
    };
    const builtIn = createPullRequestReviewPublishBuiltIn({
      providers: providerRegistry([factoryFor(provider)])
    });

    await builtIn.run({
      state,
      input: {
        provider_id: "example",
        repository_path: "/repo/workspace",
        pull_request: {
          owner: "octo-org",
          repo: "hello-world",
          number: 42
        },
        event: "request_changes",
        body: "Luna found issues.",
        findings: {
          findings: [
            {
              title: "Old code issue",
              severity: "medium",
              confidence: "medium",
              description: "The issue points outside the patch.",
              evidence: [
                {
                  path: "src/app.ts",
                  line_start: 99,
                  line_end: 99
                }
              ],
              recommendation: "Move this to the changed code path."
            }
          ]
        },
        repo_context: {
          repository: {
            owner: "octo-org",
            name: "hello-world",
            full_name: "octo-org/hello-world"
          },
          base_sha: "base",
          head_sha: "head",
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch:
                "diff --git a/src/app.ts b/src/app.ts\n@@ -41,3 +41,4 @@\n context\n context\n+dangerousCall(value)\n context\n",
              excerpt: {
                start_line: 41,
                end_line: 44,
                content: "context\ncontext\ndangerousCall(value)\ncontext\n"
              }
            }
          ]
        }
      }
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: [],
        fallback_comments: [
          expect.objectContaining({
            path: "src/app.ts",
            line: 99,
            body: expect.stringContaining("Old code issue")
          })
        ]
      })
    );
  });
});
