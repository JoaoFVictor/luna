import { collectWorktreeDiff as defaultCollectWorktreeDiff } from "../git/diff/worktree-diff.js";
import type { WorktreeDiff } from "../git/diff/worktree-diff.js";
import { collectWorktreeDiffMetadata } from "./metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { workspaceFrom } from "../../core/built-ins/state.js";
import { requiredImplementationFrom } from "./state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type CollectWorktreeDiffDependencies = BuiltInStepDependencies & {
  collectWorktreeDiff?: (input: {
    cwd: string;
    maxDiffBytes: number;
  }) => MaybePromise<WorktreeDiff>;
};

export const collectWorktreeDiffBuiltIn = defineBuiltInStep<
  "repository-change.collect_worktree_diff",
  CollectWorktreeDiffDependencies
>({
  name: "repository-change.collect_worktree_diff",
  metadata: collectWorktreeDiffMetadata,
  async run({ state, dependencies = {} }) {
    const collectWorktreeDiff =
      dependencies.collectWorktreeDiff ?? defaultCollectWorktreeDiff;
    const implementation = requiredImplementationFrom(state);

    return await collectWorktreeDiff({
      cwd: workspaceFrom(state).path,
      maxDiffBytes: implementation.validation.max_output_bytes
    });
  }
});
