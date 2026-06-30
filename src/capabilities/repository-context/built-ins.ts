import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { builtInError } from "../../core/built-ins/errors.js";
import {
  requiredInput,
  resolvedInput,
  workspaceFrom
} from "../../core/built-ins/state.js";
import { RepoContextSchema } from "../git/diff/types.js";
import { RelatedContextConfigSchema } from "./contracts.js";
import { collectRelatedContext } from "./collector.js";

export const relatedContextBuiltIn = defineBuiltInStep<"repository-context.related_context">({
  name: "repository-context.related_context",
  async run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const rawRepoContext = requiredInput(resolved.repo_context, "repo_context");
    const repoContext = RepoContextSchema.safeParse(rawRepoContext);
    if (!repoContext.success) {
      throw builtInError(
        "repository-context.related_context repo_context must match the repository context schema.",
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

    return await collectRelatedContext({
      root: requiredInput(workspace.path, "workspace.path"),
      repoContext: repoContext.data,
      config: config?.data
    });
  }
});
