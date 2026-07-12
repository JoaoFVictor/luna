import type { Invocation } from "../../../core/router/invocation.js";
import type { RouterDefinition } from "../../../core/router/router-definition.js";
import type { StudioRoutingSimulationPort } from "../routing/routing-simulator.js";
import {
  StudioRoutingSimulationSchema,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";
import type { StudioRunDefinitionSource } from "../../contracts/run-launch.js";
import { studioRunValueDigest } from "./launch-digests.js";
import { studioRunLaunchError } from "./launch-errors.js";
import type {
  StudioDraftRunDefinitionPort,
  StudioInstalledRunDefinition,
  StudioInstalledRunDefinitionPort
} from "./launch-definition-ports.js";

export type StudioRunRoutingLoader =
  () => Promise<RouterDefinition> | RouterDefinition;

type InstalledRoutingSnapshot = {
  readonly definition: RouterDefinition;
  readonly hash: string;
};

export type ResolvedRunDefinition = {
  readonly workflowId: string;
  readonly definition: StudioInstalledRunDefinition;
  readonly routingHash?: string;
};

export async function loadInstalledRouting(
  loadRouting: StudioRunRoutingLoader
): Promise<InstalledRoutingSnapshot> {
  let routing: RouterDefinition;
  try {
    routing = await loadRouting();
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_routing_failed",
      "Installed routing configuration could not be loaded",
      {},
      { cause }
    );
  }
  return { definition: routing, hash: studioRunValueDigest(routing) };
}

async function routedWorkflow(
  invocation: Invocation,
  routing: InstalledRoutingSnapshot,
  simulator: StudioRoutingSimulationPort,
  signal?: AbortSignal
): Promise<{ readonly workflowId: string; readonly routingHash: string }> {
  let simulation: StudioRoutingSimulation;
  try {
    simulation = StudioRoutingSimulationSchema.parse(
      await simulator.simulate(
        { invocation },
        routing.definition,
        signal === undefined ? {} : { signal }
      )
    );
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_routing_failed",
      "Installed routing configuration could not be evaluated",
      {},
      { cause }
    );
  }
  if (simulation.status !== "matched" || simulation.target === null) {
    throw studioRunLaunchError(
      simulation.status === "no_match"
        ? "studio_run_routing_no_match"
        : "studio_run_routing_failed",
      "Invocation did not resolve to an executable workflow"
    );
  }
  if (
    invocation.target !== undefined &&
    invocation.target.id !== simulation.target.id
  ) {
    throw studioRunLaunchError(
      "studio_run_target_mismatch",
      "Invocation target does not match deterministic routing"
    );
  }
  return { workflowId: simulation.target.id, routingHash: routing.hash };
}

async function installedDefinition(
  workflowId: string,
  source: StudioInstalledRunDefinitionPort
): Promise<StudioInstalledRunDefinition> {
  try {
    return await source.load(workflowId);
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_plan_resolution_invalid",
      "Installed workflow configuration could not be loaded",
      {},
      { cause }
    );
  }
}

export async function resolveRunDefinition(input: {
  readonly source: StudioRunDefinitionSource;
  readonly invocation: Invocation;
  readonly routing: StudioRunRoutingLoader;
  readonly routingSimulator: StudioRoutingSimulationPort;
  readonly installedDefinitions: StudioInstalledRunDefinitionPort;
  readonly draftDefinitions?: StudioDraftRunDefinitionPort;
  readonly signal?: AbortSignal;
}): Promise<ResolvedRunDefinition> {
  if (input.source.kind === "draft") {
    if (input.draftDefinitions === undefined) {
      throw studioRunLaunchError(
        "studio_run_plan_resolution_invalid",
        "Workflow draft execution is not configured"
      );
    }
    const draft = await input.draftDefinitions.loadDraft(input.source);
    if (
      input.invocation.target !== undefined &&
      input.invocation.target.id !== draft.workflowId
    ) {
      throw studioRunLaunchError(
        "studio_run_target_mismatch",
        "Invocation target does not match the selected workflow draft"
      );
    }
    return { workflowId: draft.workflowId, definition: draft };
  }

  const routing = await loadInstalledRouting(input.routing);
  const route = await routedWorkflow(
    input.invocation,
    routing,
    input.routingSimulator,
    input.signal
  );
  return {
    workflowId: route.workflowId,
    routingHash: route.routingHash,
    definition: await installedDefinition(
      route.workflowId,
      input.installedDefinitions
    )
  };
}

export async function reloadRunDefinition(input: {
  readonly source: StudioRunDefinitionSource;
  readonly workflowId: string;
  readonly installedDefinitions: StudioInstalledRunDefinitionPort;
  readonly draftDefinitions?: StudioDraftRunDefinitionPort;
}): Promise<StudioInstalledRunDefinition> {
  if (input.source.kind === "installed") {
    return await installedDefinition(input.workflowId, input.installedDefinitions);
  }
  if (input.draftDefinitions === undefined) {
    throw studioRunLaunchError(
      "studio_run_plan_resolution_invalid",
      "Workflow draft execution is not configured"
    );
  }
  return await input.draftDefinitions.loadDraft(input.source);
}
