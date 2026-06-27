import type { NativeWorkflowRunner } from "../runtime/composition/target-executor.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";
import { runNativeWorkflowTarget } from "./native-workflow-runner.js";

export type LunaPlatform = NativeLunaPlatformRegistrations & {
  readonly runWorkflow: NativeWorkflowRunner;
};

export const nativeLunaPlatform: LunaPlatform = {
  ...nativeLunaPlatformRegistrations,
  runWorkflow: runNativeWorkflowTarget
};
