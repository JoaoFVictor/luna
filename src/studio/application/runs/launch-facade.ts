import type { AdapterInput } from "../../../adapters/types.js";
import type { JsonValue } from "../../../core/runtime/json.js";
import type { Invocation } from "../../../core/router/invocation.js";
import type { RouterDefinition } from "../../../core/router/router-definition.js";
import { sameStudioAdapterEffects } from "../inputs/adapter-preview-port.js";
import type { StudioRoutingSimulationPort } from "../routing/routing-simulator.js";
import {
  StudioRoutingSimulationSchema,
  type StudioAdapterPreviewEffect,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";
import {
  StudioRunPlanInputSchema,
  type StudioRunPlanInput
} from "../../contracts/run-plan-input.js";
import {
  StudioRunInvocationSchema,
  StudioRunPlanSchema,
  type StudioRunLaunchContext,
  type StudioRunInputProvenance,
  type StudioRunPlan
} from "../../contracts/run-launch.js";
import {
  studioRunDigestsEqual,
  studioRunValueDigest
} from "./launch-digests.js";
import { studioRunLaunchError } from "./launch-errors.js";
import type { StudioRunLaunchService } from "./launch-service.js";

export type StudioInstalledRunDefinition = {
  readonly workflowRevision: string;
  readonly definitionBundleHash: string;
  readonly config: JsonValue;
};

export interface StudioRunAdapterInputResolverPort {
  loadPolicy(adapterId: string):
    | { readonly effects: readonly StudioAdapterPreviewEffect[] }
    | undefined;
  resolve(
    adapterId: string,
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<Invocation | undefined>;
}

export interface StudioInstalledRunDefinitionPort {
  load(workflowId: string): Promise<StudioInstalledRunDefinition>;
}

type CanonicalRunPlanner = Pick<StudioRunLaunchService<unknown>, "plan">;

export type StudioRunLaunchFacadeOptions = {
  readonly planner: CanonicalRunPlanner;
  readonly adapters: StudioRunAdapterInputResolverPort;
  readonly routing: () => Promise<RouterDefinition> | RouterDefinition;
  readonly routingSimulator: StudioRoutingSimulationPort;
  readonly installedDefinitions: StudioInstalledRunDefinitionPort;
};

async function resolveAdapterInput(
  input: Extract<StudioRunPlanInput, { readonly kind: "adapter" }>,
  adapters: StudioRunAdapterInputResolverPort,
  signal?: AbortSignal
): Promise<Invocation> {
  const policy = adapters.loadPolicy(input.adapter_id);
  if (policy === undefined) {
    throw studioRunLaunchError(
      "studio_run_adapter_unknown",
      "Run plan requested an unknown or unclassified input adapter"
    );
  }
  if (
    !sameStudioAdapterEffects(
      input.acknowledged_effects,
      policy.effects
    )
  ) {
    throw studioRunLaunchError(
      "studio_run_adapter_effects_unacknowledged",
      "Run input adapter effects were not acknowledged"
    );
  }
  let invocation: Invocation | undefined;
  try {
    invocation = await adapters.resolve(input.adapter_id, input.input, signal);
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_adapter_failed",
      "Registered run input adapter failed",
      {},
      { cause }
    );
  }
  if (invocation === undefined) {
    throw studioRunLaunchError(
      "studio_run_adapter_unknown",
      "Run plan requested an unknown input adapter"
    );
  }
  const parsed = StudioRunInvocationSchema.safeParse(invocation);
  if (!parsed.success) {
    throw studioRunLaunchError(
      "studio_run_adapter_failed",
      "Registered run input adapter returned an invalid invocation"
    );
  }
  return parsed.data;
}

async function resolveInvocation(
  input: StudioRunPlanInput,
  adapters: StudioRunAdapterInputResolverPort,
  signal?: AbortSignal
): Promise<{
  readonly invocation: Invocation;
  readonly provenance: StudioRunInputProvenance;
}> {
  if (input.kind === "invocation") {
    return { invocation: input.invocation, provenance: { kind: "invocation" } };
  }
  return {
    invocation: await resolveAdapterInput(input, adapters, signal),
    provenance: {
      kind: "adapter",
      adapter_id: input.adapter_id,
      adapter_input_hash: studioRunValueDigest(input.input)
    }
  };
}

type InstalledRoutingSnapshot = {
  readonly definition: RouterDefinition;
  readonly hash: string;
};

async function installedRouting(
  loadRouting: StudioRunLaunchFacadeOptions["routing"]
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
    // Preserve the launch boundary even when tests or alternate compositions
    // inject a routing port other than the native isolated implementation.
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
  return {
    workflowId: simulation.target.id,
    routingHash: routing.hash
  };
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

export class StudioRunLaunchFacade {
  readonly #planner: CanonicalRunPlanner;
  readonly #adapters: StudioRunAdapterInputResolverPort;
  readonly #routing: StudioRunLaunchFacadeOptions["routing"];
  readonly #routingSimulator: StudioRoutingSimulationPort;
  readonly #installedDefinitions: StudioInstalledRunDefinitionPort;

  constructor(options: StudioRunLaunchFacadeOptions) {
    this.#planner = options.planner;
    this.#adapters = options.adapters;
    this.#routing = options.routing;
    this.#routingSimulator = options.routingSimulator;
    this.#installedDefinitions = options.installedDefinitions;
  }

  async plan(
    rawInput: unknown,
    context: StudioRunLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioRunPlan> {
    const parsed = StudioRunPlanInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw studioRunLaunchError(
        "studio_run_plan_invalid",
        "Public run plan input is invalid"
      );
    }
    const resolved = await resolveInvocation(parsed.data, this.#adapters, signal);
    const initialRouting = await installedRouting(this.#routing);
    const initialRoute = await routedWorkflow(
      resolved.invocation,
      initialRouting,
      this.#routingSimulator,
      signal
    );
    const installed = await installedDefinition(
      initialRoute.workflowId,
      this.#installedDefinitions
    );
    const plan = StudioRunPlanSchema.parse(await this.#planner.plan({
      workflow_id: initialRoute.workflowId,
      invocation: resolved.invocation,
      config: installed.config,
      input_provenance: resolved.provenance
    }, context, signal));

    const currentRouting = await installedRouting(this.#routing);
    if (
      !studioRunDigestsEqual(currentRouting.hash, initialRoute.routingHash) ||
      !studioRunDigestsEqual(
        plan.workflow_revision,
        installed.workflowRevision
      ) ||
      !studioRunDigestsEqual(
        plan.definition_bundle_hash,
        installed.definitionBundleHash
      ) ||
      !studioRunDigestsEqual(
        plan.config_hash,
        studioRunValueDigest(installed.config)
      )
    ) {
      throw studioRunLaunchError(
        "studio_run_plan_stale",
        "Installed run inputs changed while the plan was created"
      );
    }
    return plan;
  }
}
