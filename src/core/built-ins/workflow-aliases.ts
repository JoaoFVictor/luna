const workflowCapabilityBuiltInAliases = Object.freeze({
  "runtime.preflight": "preflight",
  "runtime.prepare_worktree": "prepare_worktree",
  "runtime.collect_repo_context": "collect_repo_context",
  "runtime.validate_code_review_findings": "validate_code_review_findings",
  "runtime.final_code_review_report": "final_code_review_report",
  "runtime.prepare_implementation_worktree": "prepare_implementation_worktree",
  "runtime.collect_task_context": "collect_task_context",
  "runtime.record_implementation_validation": "record_implementation_validation",
  "runtime.collect_worktree_diff": "collect_worktree_diff",
  "runtime.prepare_commit": "prepare_commit",
  "runtime.record_commit_lifecycle": "record_commit_lifecycle",
  "runtime.prepare_push": "prepare_push",
  "runtime.record_push_lifecycle": "record_push_lifecycle",
  "runtime.final_implementation_report": "final_implementation_report",
  "context.collect_context": "collect_context",
  "reports.final_report": "final_report"
});

export function builtInStepNameForWorkflowCapability(uses: string): string {
  return workflowCapabilityBuiltInAliases[
    uses as keyof typeof workflowCapabilityBuiltInAliases
  ] ?? uses;
}

export function workflowCapabilityBuiltInAliasEntries(): Array<readonly [
  string,
  string
]> {
  return Object.entries(workflowCapabilityBuiltInAliases);
}
