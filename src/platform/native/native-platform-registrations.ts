import {
  officialCapabilityManifests,
  officialCapabilityRegistry
} from "../../capabilities/registry.js";
import type { InputAdapterRegistry } from "../../adapters/registry.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import type { CapabilityManifest } from "../../core/capabilities/manifest.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeFactory } from "../../core/workflow/runner-port.js";
import type {
  AgentRuntimeFactory
} from "../../runtime/composition/runtime-composition.js";
import { nativeInputAdapterRegistry } from "./native-input-adapters.js";
import {
  nativeAgentRuntimeFactories,
  nativeWorkflowRuntimeFactories
} from "./native-runtime-factories.js";
import type { NativeWorkflowBuiltIns } from "./native-platform-extensions.js";

export type NativeLunaPlatformRegistrations = {
  readonly inputAdapterRegistry: InputAdapterRegistry;
  readonly agentRuntimeFactories: Readonly<Record<string, AgentRuntimeFactory>>;
  readonly workflowRuntimeFactories: Readonly<Record<
    string,
    WorkflowRuntimeFactory<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult>
  >>;
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly capabilityManifests: readonly CapabilityManifest[];
};

export const nativeLunaPlatformRegistrations: NativeLunaPlatformRegistrations = {
  inputAdapterRegistry: nativeInputAdapterRegistry,
  agentRuntimeFactories: nativeAgentRuntimeFactories,
  workflowRuntimeFactories: nativeWorkflowRuntimeFactories,
  capabilityRegistry: officialCapabilityRegistry,
  capabilityManifests: officialCapabilityManifests
};
