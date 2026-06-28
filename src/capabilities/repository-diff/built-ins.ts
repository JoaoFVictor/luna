import { collectRepoContext as defaultCollectRepoContext } from "../git/diff/repo-context.js";
import type { RepoContext } from "../git/diff/types.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import type { Invocation } from "../../core/router/invocation.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { repositoryRequiredMetadata } from "../../core/built-ins/metadata.js";
import {
  repositoryFrom,
  requiredInput,
  resolvedInput,
  workspaceFrom
} from "../../core/built-ins/state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type RepositoryDiffDependencies = BuiltInStepDependencies & {
  collectRepoContext?: (input: {
    repository: RepositoryConfig;
    baseSha: string;
    headSha: string;
  }) => MaybePromise<RepoContext>;
};

function invocationRefsFrom(state: {
  readonly invocation?: unknown;
}): { baseSha?: string; headSha?: string } {
  const references = (state.invocation as Partial<Invocation> | undefined)?.references;

  return {
    baseSha: references?.base_sha,
    headSha: references?.head_sha
  };
}

export const collectRepoContextBuiltIn = defineBuiltInStep<
  "repository-diff.collect_context",
  RepositoryDiffDependencies
>({
  name: "repository-diff.collect_context",
  metadata: repositoryRequiredMetadata,
  async run({ state, input, dependencies = {} }) {
    const collectRepoContext =
      dependencies.collectRepoContext ?? defaultCollectRepoContext;
    const resolved = resolvedInput(input, state);
    const refs = invocationRefsFrom(state);
    const workspace = workspaceFrom(state);

    return await collectRepoContext({
      repository: {
        ...repositoryFrom(state),
        path: workspace.path
      },
      baseSha: requiredInput(
        (resolved.base_sha as string | undefined) ?? refs.baseSha,
        "base_sha"
      ),
      headSha: requiredInput(
        (resolved.head_sha as string | undefined) ?? refs.headSha,
        "head_sha"
      )
    });
  }
});
