import { z } from "zod";
import { FindingsPayloadSchema } from "../../core/findings/types.js";
import { RepoContextSchema } from "../git/diff/types.js";

const NonEmptyStringSchema = z.string().min(1);

export const PullRequestReviewEventSchema = z.enum([
  "comment",
  "request_changes",
  "approve"
]);
export type PullRequestReviewEvent = "comment" | "request_changes" | "approve";

export const PullRequestReviewConfiguredEventSchema = z.enum([
  "auto",
  "comment",
  "request_changes",
  "approve"
]);
export type PullRequestReviewConfiguredEvent =
  | "auto"
  | PullRequestReviewEvent;

export const PullRequestReviewAcceptanceSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "needs_human_review"]),
    summary: NonEmptyStringSchema,
    blocking_reasons: z.array(NonEmptyStringSchema),
    recommended_action: z.enum([
      "approve",
      "comment",
      "request_changes",
      "continue",
      "stop",
      "human_review"
    ])
  })
  .strict();
export type PullRequestReviewAcceptance = z.infer<
  typeof PullRequestReviewAcceptanceSchema
>;

export const PullRequestReviewResolvedInputSchema = z
  .object({
    operation_id: z.literal("pull-request-review.publish").optional(),
    enabled: z.boolean().default(true),
    provider_id: NonEmptyStringSchema,
    repository_path: NonEmptyStringSchema,
    pull_request: z
      .object({
        owner: NonEmptyStringSchema,
        repo: NonEmptyStringSchema,
        number: z.number().int().positive()
      })
      .strict(),
    event: PullRequestReviewConfiguredEventSchema.default("auto"),
    body: NonEmptyStringSchema,
    acceptance: PullRequestReviewAcceptanceSchema.optional(),
    inline_comments: z.boolean().default(true),
    findings: FindingsPayloadSchema.optional(),
    repo_context: RepoContextSchema.optional()
  })
  .strict();
export type PullRequestReviewBuiltInInput = z.infer<
  typeof PullRequestReviewResolvedInputSchema
>;

export type PullRequestReviewComment = {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
};

export type PullRequestReviewFallbackComment = {
  readonly path: string;
  readonly line: number;
  readonly body: string;
};

export type PullRequestReviewPublishInput = {
  readonly operation_id: "pull-request-review.publish";
  readonly enabled: boolean;
  readonly provider_id: string;
  readonly repository_path: string;
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly event: PullRequestReviewEvent;
  readonly body: string;
  readonly comments: readonly PullRequestReviewComment[];
  readonly fallback_comments: readonly PullRequestReviewFallbackComment[];
};

export type PullRequestReviewPublishedResult = {
  readonly operation_id: "pull-request-review.publish";
  readonly enabled: true;
  readonly skipped: false;
  readonly provider: string;
  readonly provider_id: string;
  readonly external_id: string;
  readonly url: string;
  readonly event: PullRequestReviewEvent;
  readonly inline_comments: number;
  readonly fallback_comments: number;
};

export type PullRequestReviewSkippedResult = {
  readonly operation_id: "pull-request-review.publish";
  readonly enabled: boolean;
  readonly skipped: true;
  readonly reason: string;
  readonly error?: {
    readonly code?: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

export type PullRequestReviewPublishResult =
  | PullRequestReviewPublishedResult
  | PullRequestReviewSkippedResult;

export type PullRequestReviewProviderPort = {
  readonly provider_id: string;
  publishReview(
    input: PullRequestReviewPublishInput
  ): PullRequestReviewPublishResult | Promise<PullRequestReviewPublishResult>;
};

export type PullRequestReviewProviderFactory = {
  readonly provider_id: string;
  createProvider(): PullRequestReviewProviderPort;
};

export type PullRequestReviewProviderRegistry = {
  get(providerId: string): PullRequestReviewProviderPort;
};

export type PullRequestReviewBuiltInPorts = {
  readonly providers: PullRequestReviewProviderRegistry;
};
