/**
 * Compatibility surface for checkpoint protocol consumers outside the
 * workflow runtime. Runtime modules import the focused implementations
 * directly so ownership and dependency direction remain visible.
 */
export {
  CheckpointWriteAcceptanceUnknownError,
  checkpointMatchesInput,
  isCheckpointWriteAcceptanceUnknown,
  listCheckpointWritesForRecovery,
  hasThreadCheckpointWritesForRecovery,
  loadCheckpointForRecovery,
  saveCheckpointExactly,
  saveCheckpointWriteExactly
} from "./checkpoint-io.js";
export {
  nodeOutputCheckpointId,
  persistedNodeDurability,
  saveNodeCompletionWrite,
  saveNodeOutputWrite,
  type PersistedNodeDurability
} from "./node-durability.js";
export {
  ensureWorkflowExecutionIdentity
} from "./workflow-execution-identity.js";
export {
  saveTerminalCheckpoint,
  terminalCheckpointSnapshot
} from "./terminal-checkpoints.js";
