import { describe, expect, it, vi } from "vitest";
import {
  createPullRequestReviewPublishBuiltIn
} from "../../../src/capabilities/pull-request-review/built-ins.js";
import type {
  PullRequestReviewAcceptance,
  PullRequestReviewBuiltInInput,
  PullRequestReviewProviderFactory,
  PullRequestReviewProviderPort
} from "../../../src/capabilities/pull-request-review/contracts.js";
import {
  PullRequestReviewResolvedInputSchema
} from "../../../src/capabilities/pull-request-review/contracts.js";
import {
  publishAuthoringInputSchema
} from "../../../src/capabilities/pull-request-review/manifest.js";
import type { RepoContext } from "../../../src/capabilities/git/diff/types.js";
import type { Finding } from "../../../src/core/findings/types.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import { createProviderRegistry } from "../../../src/core/providers/registry.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "code-review", mode: "read_only" },
  steps: {}
};

const pullRequest = {
  owner: "octo-org",
  repo: "hello-world",
  number: 42
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

function recordingProvider(providerId = "example"): PullRequestReviewProviderPort {
  return {
    provider_id: providerId,
    publishReview: vi.fn<PullRequestReviewProviderPort["publishReview"]>(
      async (input) => ({
        operation_id: "pull-request-review.publish",
        enabled: true,
        skipped: false,
        provider: providerId,
        provider_id: providerId,
        external_id: `review-${input.event}`,
        url: `https://example.test/review-${input.event}`,
        event: input.event,
        inline_comments: input.comments.length,
        fallback_comments: input.fallback_comments.length
      })
    )
  };
}

function builtInFor(provider: PullRequestReviewProviderPort) {
  return createPullRequestReviewPublishBuiltIn({
    providers: providerRegistry([factoryFor(provider)])
  });
}

function finding({
  title = "Missing null guard",
  severity = "high",
  confidence = "high",
  description = "The changed branch can dereference null.",
  path = "src/app.ts",
  line = 43,
  recommendation = "Guard the nullable value before use."
}: {
  readonly title?: string;
  readonly severity?: Finding["severity"];
  readonly confidence?: Finding["confidence"];
  readonly description?: string;
  readonly path?: string;
  readonly line?: number;
  readonly recommendation?: string;
} = {}): Finding {
  return {
    title,
    severity,
    confidence,
    description,
    evidence: [
      {
        path,
        line_start: line,
        line_end: line
      }
    ],
    recommendation
  };
}

function repoContextWithRightSideLine(): RepoContext {
  return {
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
  };
}

function publishInput(
  overrides: Partial<PullRequestReviewBuiltInInput> = {}
): PullRequestReviewBuiltInInput {
  return {
    enabled: true,
    provider_id: "example",
    repository_path: "/repo/workspace",
    pull_request: pullRequest,
    event: "comment",
    body: "Luna found issues.",
    inline_comments: true,
    findings: { findings: [] },
    ...overrides
  };
}

function acceptance(
  overrides: Partial<PullRequestReviewAcceptance> = {}
): PullRequestReviewAcceptance {
  return {
    status: "accepted",
    summary: "No blocking issues found.",
    blocking_reasons: [],
    recommended_action: "approve",
    ...overrides
  };
}

describe("pull-request-review capability", () => {
  it("keeps concrete authoring input aligned with the resolved built-in contract", () => {
    const input = publishInput({
      enabled: true,
      event: "request_changes",
      inline_comments: true
    });

    expect(matchesJsonSchema(publishAuthoringInputSchema, input)).toBe(true);
    expect(PullRequestReviewResolvedInputSchema.safeParse(input).success).toBe(true);
  });

  it("publishes an explicit approved review result when acceptance passes without findings", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "auto",
        body: "fallback summary",
        acceptance: acceptance()
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "comment",
        body: [
          "Review result: approved",
          "",
          "No blocking issues found."
        ].join("\n")
      })
    );
  });

  it("publishes a changes requested review result with blocking reasons", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "auto",
        acceptance: acceptance({
          status: "rejected",
          summary: "The review found blocking problems.",
          blocking_reasons: ["The API path can return stale data."],
          recommended_action: "request_changes"
        }),
        findings: { findings: [finding()] },
        repo_context: repoContextWithRightSideLine()
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request_changes",
        body: [
          "Review result: changes requested",
          "",
          "The review found blocking problems.",
          "",
          "Blocking reasons:",
          "- The API path can return stale data."
        ].join("\n")
      })
    );
  });

  it("publishes a needs human review result when acceptance cannot decide", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "auto",
        acceptance: acceptance({
          status: "needs_human_review",
          summary: "The automated review could not determine the outcome.",
          recommended_action: "human_review"
        })
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "comment",
        body: [
          "Review result: needs human review",
          "",
          "The automated review could not determine the outcome."
        ].join("\n")
      })
    );
  });

  it("does not turn generic acceptance rejection into a PR change request label", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "auto",
        acceptance: acceptance({
          status: "rejected",
          summary: "The review gate did not accept the current result.",
          blocking_reasons: ["The review result needs human verification."],
          recommended_action: "comment"
        })
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "comment",
        body: [
          "Review result: not accepted",
          "",
          "The review gate did not accept the current result.",
          "",
          "Blocking reasons:",
          "- The review result needs human verification."
        ].join("\n")
      })
    );
  });

  it("keeps the legacy body when no structured acceptance result is provided", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        body: "Plain legacy review body."
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Plain legacy review body."
      })
    );
  });

  it("uses request changes automatically only when validated findings exist", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "auto",
        findings: { findings: [finding()] },
        repo_context: repoContextWithRightSideLine()
      })
    });

    expect(provider.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request_changes",
        comments: [
          expect.objectContaining({
            path: "src/app.ts",
            line: 43
          })
        ]
      })
    );
  });

  it("downgrades unsafe review events when the finding state disagrees", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "request_changes",
        body: "No validated findings."
      })
    });

    await builtIn.run({
      state,
      input: publishInput({
        event: "approve",
        body: "There are validated findings.",
        findings: { findings: [finding()] }
      })
    });

    expect(provider.publishReview).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "comment",
        comments: [],
        fallback_comments: []
      })
    );
    expect(provider.publishReview).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "comment"
      })
    );
  });

  it("returns a diagnostic skipped result when provider publishing fails", async () => {
    const error = Object.assign(new Error("Failed to publish"), {
      code: "pull_request_review_publish_failed",
      details: {
        endpoint: "repos/octo-org/hello-world/pulls/42/reviews",
        event: "COMMENT",
        inline_comments: 0,
        fallback_comments: 0,
        body_bytes: 18
      }
    });
    const provider: PullRequestReviewProviderPort = {
      provider_id: "example",
      publishReview: vi.fn<PullRequestReviewProviderPort["publishReview"]>(
        async () => {
          throw error;
        }
      )
    };
    const builtIn = builtInFor(provider);

    await expect(
      builtIn.run({
        state,
        input: publishInput()
      })
    ).resolves.toMatchObject({
      operation_id: "pull-request-review.publish",
      enabled: true,
      skipped: true,
      reason: "publish_failed",
      error: {
        code: "pull_request_review_publish_failed",
        message: "Failed to publish",
        details: {
          endpoint: "repos/octo-org/hello-world/pulls/42/reviews"
        }
      }
    });
  });

  it("does not convert unsupported provider configuration into a skipped publish result", async () => {
    const builtIn = createPullRequestReviewPublishBuiltIn({
      providers: providerRegistry([])
    });

    await expect(
      builtIn.run({
        state,
        input: publishInput({ provider_id: "missing" })
      })
    ).rejects.toMatchObject({
      code: "pull_request_review_provider_unsupported",
      details: {
        provider: "missing"
      }
    });
  });

  it("publishes request changes with inline comments for findings on right-side diff lines", async () => {
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await expect(
      builtIn.run({
        state,
        input: publishInput({
          event: "request_changes",
          findings: { findings: [finding()] },
          repo_context: repoContextWithRightSideLine()
        })
      })
    ).resolves.toMatchObject({
      external_id: "review-request_changes",
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
    const provider = recordingProvider();
    const builtIn = builtInFor(provider);

    await builtIn.run({
      state,
      input: publishInput({
        event: "request_changes",
        findings: {
          findings: [
            finding({
              title: "Old code issue",
              severity: "medium",
              confidence: "medium",
              description: "The issue points outside the patch.",
              line: 99,
              recommendation: "Move this to the changed code path."
            })
          ]
        },
        repo_context: repoContextWithRightSideLine()
      })
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
