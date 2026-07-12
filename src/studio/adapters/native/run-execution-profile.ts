import type { WorkflowPrecompletedSteps } from "../../../core/workflow/execution-contracts.js";
import type { StudioRunExecutionProfile } from "../../contracts/manual-test-data.js";

export function nativePrecompletedSteps(
  profile: StudioRunExecutionProfile
): WorkflowPrecompletedSteps | undefined {
  if (profile.kind === "standard") return undefined;
  return Object.fromEntries(
    profile.test_data.map((testData) => [testData.node_id, testData.output])
  );
}
