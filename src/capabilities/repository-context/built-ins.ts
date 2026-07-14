import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { builtInError } from "../../core/built-ins/errors.js";
import {
  requiredInput,
  repositoryFrom,
  resolvedInput,
  workspaceFrom
} from "../../core/built-ins/state.js";
import { RepoContextSchema } from "../git/diff/types.js";
import {
  RelatedContextConfigSchema,
  RelatedContextTaskSchema,
  RelatedContextWorktreeDiffSchema
} from "./contracts.js";
import { collectRelatedContext } from "./collector.js";

export const relatedContextBuiltIn = defineBuiltInStep<"repository-context.related_context">({
  name: "repository-context.related_context",
  async run({ state, input, signal }) {
    const resolved = resolvedInput(input, state);
    const sourceCount = [resolved.repo_context, resolved.task, resolved.worktree_diff]
      .filter((value) => value !== undefined).length;
    if (sourceCount !== 1) {
      throw builtInError(
        "repository-context.related_context requires exactly one of repo_context, task, or worktree_diff.",
        "built_in_input_invalid"
      );
    }
    const repoContext = resolved.repo_context === undefined
      ? undefined
      : RepoContextSchema.safeParse(resolved.repo_context);
    const task = resolved.task === undefined
      ? undefined
      : RelatedContextTaskSchema.safeParse(resolved.task);
    const worktreeDiff = resolved.worktree_diff === undefined
      ? undefined
      : RelatedContextWorktreeDiffSchema.safeParse(resolved.worktree_diff);
    if (repoContext?.success === false || task?.success === false || worktreeDiff?.success === false) {
      throw builtInError(
        "repository-context.related_context source input does not match its schema.",
        "built_in_input_invalid"
      );
    }
    const config = resolved.config === undefined
      ? undefined
      : RelatedContextConfigSchema.safeParse(resolved.config);
    if (config !== undefined && !config.success) {
      throw builtInError(
        "repository-context.related_context config must match the related context config schema.",
        "built_in_input_invalid"
      );
    }
    const workspace = workspaceFrom<{ path: string }>(state);
    const repository = repositoryFrom(state);

    return await collectRelatedContext({
      root: requiredInput(workspace.path, "workspace.path"),
      repository: {
        owner: repository.owner,
        name: repository.name,
        full_name: `${repository.owner}/${repository.name}`
      },
      repoContext: repoContext?.data,
      task: task?.data,
      worktreeDiff: worktreeDiff?.data,
      config: config?.data,
      indexPolicy: repository.repository_context,
      signal
    });
  }
});
