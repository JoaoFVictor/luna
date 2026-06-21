import {
  appendOnlyJsonlWriter,
  type AppendOnlyJsonlWriterDependencies
} from "./append-only-jsonl-writer.js";

export type LocalTransactionJournalEntry = {
  runId: string;
  operation: "worktree_create" | "commit_stage";
  phase: "started" | "succeeded" | "failed" | "rolled_back";
  timestamp: string;
  resources: {
    worktreePath?: string;
    branchName?: string;
    repositoryPath?: string;
    indexPath?: string;
  };
  cleanup: {
    attempted: boolean;
    action?: "remove_worktree" | "restore_index" | "remove_branch";
    branchRemovalAllowed: boolean;
  };
  indexRestoreStrategy?: "none" | "reset_to_pre_operation_index";
  originalFailure?: {
    code: string;
    message: string;
  };
  cleanupFailure?: {
    code: string;
    message: string;
  };
};

export type AppendLocalTransactionJournalEntry = (
  entry: LocalTransactionJournalEntry
) => Promise<void>;

export async function appendLocalTransactionJournalEntry({
  filePath,
  entry,
  dependencies
}: {
  filePath: string;
  entry: LocalTransactionJournalEntry;
  dependencies?: AppendOnlyJsonlWriterDependencies;
}): Promise<void> {
  await appendOnlyJsonlWriter({
    filePath,
    value: entry,
    dependencies
  });
}
