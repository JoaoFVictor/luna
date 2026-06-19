import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { runGit } from "../core/git.js";

export function repositoryStatusTool(cwd: string) {
  return defineTool({
    name: "repository_status",
    description: "Return short git status for the bound repository worktree.",
    parameters: v.object({}),
    execute: async () => await runGit(cwd, ["status", "--short"])
  });
}

export function repositoryDiffSummaryTool(cwd: string) {
  return defineTool({
    name: "repository_diff_summary",
    description: "Return compact git diff stat for the bound repository worktree.",
    parameters: v.object({}),
    execute: async () => await runGit(cwd, ["diff", "--stat"])
  });
}
