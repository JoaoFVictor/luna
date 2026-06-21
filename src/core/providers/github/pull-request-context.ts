import { z } from "zod";
import {
  codedError,
  parsePayload,
  requireReferences,
  requireRepository,
  requireSubject
} from "../../invocation/helpers.js";
import {
  HeadRepositoryRefSchema,
  RepositoryRefSchema,
  type HeadRepositoryRef,
  type RepositoryRef
} from "../../types.js";
import type {
  InvocationSubject,
  NormalizedInvocation
} from "../../invocation/types.js";

const PullRequestPayloadSchema = z
  .object({
    number: z.number().int().positive()
  })
  .strict();

export type GitHubPullRequestContext = {
  owner: string;
  repo: string;
  pull_number: number;
  base_ref: string;
  base_repository: RepositoryRef;
  head_repository: HeadRepositoryRef;
  references: {
    base_sha: string;
    head_sha: string;
  };
  subject: InvocationSubject;
};

function githubPullRequestContextInvalid(message: string): Error & { code: string } {
  return codedError(message, "github_pull_request_context_invalid");
}

export function githubPullRequestContextFrom(
  invocation: NormalizedInvocation
): GitHubPullRequestContext {
  if (invocation.source !== "github" || invocation.event !== "pull_request") {
    throw githubPullRequestContextInvalid("Invocation is not a GitHub pull request event");
  }

  const repository = requireRepository(invocation);
  const subject = requireSubject(invocation, "pull_request");
  const references = requireReferences(invocation, ["base_sha", "head_sha"]);
  const baseRef = invocation.references?.base_ref;

  if (baseRef === undefined || baseRef.length === 0) {
    throw githubPullRequestContextInvalid("GitHub PR base ref is required");
  }

  const pullRequest = parsePayload(
    invocation,
    "pull_request",
    PullRequestPayloadSchema,
    "github_pull_request_context_invalid"
  );
  const baseRepository = parsePayload(
    invocation,
    "base_repository",
    RepositoryRefSchema,
    "github_pull_request_context_invalid"
  );
  const headRepository = parsePayload(
    invocation,
    "head_repository",
    HeadRepositoryRefSchema,
    "github_pull_request_context_invalid"
  );

  return {
    owner: repository.owner,
    repo: repository.name,
    pull_number: pullRequest.number,
    base_ref: baseRef,
    base_repository: baseRepository,
    head_repository: headRepository,
    references,
    subject
  };
}
