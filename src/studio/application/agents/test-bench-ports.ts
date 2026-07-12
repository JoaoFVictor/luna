import type { RunAgentOutput } from "../../../core/agent-runtime/contracts.js";
import type {
  StudioAgentTestLaunchContext,
  StudioAgentTestPlanRequest,
  StudioAgentTestResolution
} from "../../contracts/agent-test-bench.js";

export type StudioResolvedAgentTest<ExecutionPayload> = {
  readonly resolution: StudioAgentTestResolution;
  readonly executionPayload: ExecutionPayload;
};

export interface StudioAgentTestResolverPort<ExecutionPayload> {
  resolve(
    request: StudioAgentTestPlanRequest,
    signal?: AbortSignal
  ): Promise<StudioResolvedAgentTest<ExecutionPayload>>;
}

export type StudioAgentTestConfirmationBinding = {
  readonly planId: string;
  readonly actorBindingDigest: string;
  readonly requestDigest: string;
  readonly snapshotHash: string;
  readonly request: StudioAgentTestPlanRequest;
};

export type StudioAgentTestConfirmationRecord = {
  readonly binding: StudioAgentTestConfirmationBinding;
  readonly expiresAt: number;
};

export interface StudioAgentTestConfirmationPort {
  issue(
    binding: StudioAgentTestConfirmationBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }>;
  consume(
    token: string,
    expectation: {
      readonly planId: string;
      readonly actorBindingDigest: string;
    }
  ): Promise<StudioAgentTestConfirmationRecord | undefined>;
}

export type StudioAgentTestExecutionCommand<ExecutionPayload> = {
  readonly planId: string;
  readonly snapshotHash: string;
  readonly requestedAt: string;
  readonly requestId: StudioAgentTestLaunchContext["request_id"];
  readonly request: StudioAgentTestPlanRequest;
  readonly resolution: StudioAgentTestResolution;
  readonly executionPayload: ExecutionPayload;
  readonly signal?: AbortSignal;
};

export interface StudioAgentTestRunnerPort<ExecutionPayload> {
  run(
    command: StudioAgentTestExecutionCommand<ExecutionPayload>
  ): Promise<RunAgentOutput>;
}
