import type {
  ImplementationLifecycleEvidence
} from "../write-mode/lifecycle.js";
import type { Invocation } from "../router/invocation.js";
import type { RunIdentity } from "../invocation/types.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import {
  RepositoryConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../config/schemas.js";

export type WorkflowState = {
  invocation: unknown;
  config?: unknown;
  repository?: unknown;
  run?: unknown;
  workflow?: unknown;
  workspace?: unknown;
  workspaceRoot?: string;
  agentsRoot?: string;
  steps: Record<string, unknown>;
};

export type WorkflowRuntimeState = WorkflowState & {
  invocation: Invocation;
  config: {
    implementation?: import("../write-mode/types.js").ImplementationConfig["implementation"];
  };
  repository?: RepositoryConfig;
  run: RunIdentity;
  workflow: {
    id: string;
    mode: "read_only" | "trusted_local_write";
  };
  workspaceRoot: AppConfig["workspace"]["root"];
  agentsRoot: string;
  workspace?: WorkspaceRecord;
  lifecycleEvidence?: ImplementationLifecycleEvidence;
};

export function repositoryConfigFromState(
  state: Pick<WorkflowState, "repository">
): RepositoryConfig | undefined {
  if (state.repository === undefined) {
    return undefined;
  }

  return RepositoryConfigSchema.parse(state.repository);
}
