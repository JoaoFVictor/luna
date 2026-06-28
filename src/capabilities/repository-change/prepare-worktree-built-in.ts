import {
  prepareImplementationWorktree as defaultPrepareImplementationWorktree
} from "./worktree.js";
import { prepareImplementationWorktreeMetadata } from "./metadata.js";
import type { RepositoryConfig } from "../../core/config/schemas.js";
import type { ImplementationWorktreeRecord } from "./worktree.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  repositoryFrom,
  requiredInput,
  resolvedInput,
  runIdFrom,
  workspaceRootFrom
} from "../../core/built-ins/state.js";
import { requiredImplementationFrom } from "./state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";
import { lifecycleContractError } from "./shared.js";

type ImplementationSubject = {
  key: string;
  title?: string;
};

type PrepareWorktreeDependencies = BuiltInStepDependencies & {
  prepareImplementationWorktree?: (input: {
    subject: ImplementationSubject;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
    baseRef: string;
    branchPattern: string;
  }) => MaybePromise<ImplementationWorktreeRecord>;
};

function implementationSubjectFrom(input: unknown): ImplementationSubject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw lifecycleContractError("Implementation subject must be an object");
  }

  const subject = input as { key?: unknown; title?: unknown };
  if (typeof subject.key !== "string" || subject.key === "") {
    throw lifecycleContractError("Implementation subject key is required");
  }

  if (subject.title !== undefined && typeof subject.title !== "string") {
    throw lifecycleContractError("Implementation subject title must be a string");
  }

  return {
    key: subject.key,
    ...(subject.title === undefined ? {} : { title: subject.title })
  };
}

export const prepareImplementationWorktreeBuiltIn = defineBuiltInStep<
  "repository-change.prepare_worktree",
  PrepareWorktreeDependencies
>({
  name: "repository-change.prepare_worktree",
  metadata: prepareImplementationWorktreeMetadata,
  async run({ state, input, dependencies = {} }) {
    const prepareImplementationWorktree =
      dependencies.prepareImplementationWorktree ??
      defaultPrepareImplementationWorktree;
    const implementation = requiredImplementationFrom(state);
    const resolved = resolvedInput(input, state);

    return await prepareImplementationWorktree({
      subject: implementationSubjectFrom(requiredInput(resolved.subject, "subject")),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state),
      baseRef: implementation.change_request.base_ref,
      branchPattern: implementation.branch_pattern
    });
  }
});
