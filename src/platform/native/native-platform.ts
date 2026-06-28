import type { NativeWorkflowRunner } from "../../runtime/composition/target-executor.js";
import type { WorkflowRunResult } from "../../core/workflow/execution-contracts.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";
import {
  resumeNativeWorkflowTarget,
  runNativeWorkflowTarget,
  type NativeWorkflowResumeInput
} from "./native-workflow-runner.js";

export type LunaPlatform = NativeLunaPlatformRegistrations & {
  readonly runWorkflow: NativeWorkflowRunner;
  readonly resumeWorkflow: (input: NativeWorkflowResumeInput) => Promise<WorkflowRunResult>;
};

export const nativeLunaPlatform: LunaPlatform = {
  ...nativeLunaPlatformRegistrations,
  runWorkflow: runNativeWorkflowTarget,
  resumeWorkflow: resumeNativeWorkflowTarget
};
