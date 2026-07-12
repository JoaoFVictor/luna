import type { StudioConfigurationService } from "../application/configuration/service.js";
import type {
  StudioModelConfiguration,
  StudioProviderConfiguration,
  StudioRepositoryConfiguration,
  StudioRuntimeConfiguration
} from "../contracts/configuration.js";
import type { StudioConfigurationControl } from "./routes/configuration.js";
import type { StudioProviderHealthProbeService } from "../application/inputs/provider-health-probes.js";

export type StudioConfigurationPosture = {
  readonly models: () => Promise<StudioModelConfiguration>;
  readonly repositories: () => Promise<StudioRepositoryConfiguration>;
  readonly providers: () => Promise<StudioProviderConfiguration>;
  readonly runtime: () => Promise<StudioRuntimeConfiguration>;
};

/**
 * Authentication stays at the HTTP composition root. This adapter accepts only
 * an already-authenticated local principal and never projects private sources.
 */
export function createLocalStudioConfigurationControl(
  service: StudioConfigurationService,
  posture: StudioConfigurationPosture,
  providerProbes: Pick<StudioProviderHealthProbeService, "run">
): StudioConfigurationControl {
  return {
    getWorkflowConfiguration: async (_principal, workflowId) =>
      await service.get(workflowId),
    createWorkflowConfigurationDraft: async (_principal, workflowId) =>
      await service.createDraft(workflowId),
    getWorkflowConfigurationDraft: async (
      _principal,
      workflowId,
      draftId
    ) => await service.getDraft(workflowId, draftId),
    patchWorkflowConfigurationDraft: async (
      _principal,
      workflowId,
      draftId,
      input,
      ifMatch
    ) => await service.patchDraft(workflowId, draftId, input, ifMatch),
    validateWorkflowConfigurationDraft: async (
      _principal,
      workflowId,
      draftId,
      ifMatch
    ) => await service.validateDraft(workflowId, draftId, ifMatch),
    planWorkflowConfigurationApply: async (
      _principal,
      workflowId,
      draftId
    ) => await service.planApply(workflowId, draftId),
    applyWorkflowConfigurationDraft: async (
      _principal,
      workflowId,
      draftId,
      input
    ) => await service.apply(workflowId, draftId, input),
    models: async () => await posture.models(),
    repositories: async () => await posture.repositories(),
    providers: async () => await posture.providers(),
    testProviderConnection: async (_principal, providerId, signal) =>
      await providerProbes.run(providerId, signal),
    runtime: async () => await posture.runtime()
  };
}
