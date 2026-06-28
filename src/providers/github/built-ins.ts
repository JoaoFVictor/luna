import { prepare as defaultPrepareWorktree } from "./worktree-manager.js";
import type { Invocation } from "../../core/router/invocation.js";
import type {
  WorkspaceRecord
} from "../../capabilities/repository-change/types.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  prepareWorktreeMetadata,
} from "../../core/built-ins/metadata.js";
import {
  repositoryFrom,
  requiredState,
  runIdFrom,
  workspaceRootFrom
} from "../../core/built-ins/state.js";
import { builtInError } from "../../core/built-ins/errors.js";
import { githubPullRequestContextFrom } from "./pull-request-context.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type GitHubBuiltInDependencies = BuiltInStepDependencies & {
  prepareWorktree?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
  }) => MaybePromise<WorkspaceRecord>;
};

function githubPullRequestInvocationFrom(state: { invocation?: unknown }): Invocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  try {
    githubPullRequestContextFrom(invocation);
  } catch {
    throw builtInError(
      "Built-in step requires GitHub pull request invocation",
      "built_in_unsupported"
    );
  }

  return invocation;
}

export const prepareWorktreeBuiltIn = defineBuiltInStep<
  "pull-request-workspace.prepare_worktree",
  GitHubBuiltInDependencies
>({
  name: "pull-request-workspace.prepare_worktree",
  metadata: prepareWorktreeMetadata,
  async run({ state, dependencies = {} }) {
    const prepareWorktree = dependencies.prepareWorktree ?? defaultPrepareWorktree;

    return await prepareWorktree({
      invocation: githubPullRequestInvocationFrom(state),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state)
    });
  }
});
