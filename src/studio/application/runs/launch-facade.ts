import type { AdapterInput } from "../../../adapters/types.js";
import type { Invocation } from "../../../core/router/invocation.js";
import type { RouterDefinition } from "../../../core/router/router-definition.js";
import { sameStudioAdapterEffects } from "../inputs/adapter-preview-port.js";
import type { StudioRoutingSimulationPort } from "../routing/routing-simulator.js";
import {
  type StudioAdapterPreviewEffect
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
import {
  studioRunLaunchError,
  type StudioRunLaunchError
} from "./launch-errors.js";
import type { StudioRunLaunchService } from "./launch-service.js";
import {
  loadInstalledRouting,
  reloadRunDefinition,
  resolveRunDefinition
} from "./launch-definition-selection.js";
import type {
  StudioDraftRunDefinitionPort,
  StudioInstalledRunDefinitionPort
} from "./launch-definition-ports.js";
import {
  StudioDraftTestRunPlanInputSchema,
  type StudioDraftTestRunPlanInput
} from "../../contracts/draft-test-run.js";
import type { StudioRunExecutionProfile } from "../../contracts/manual-test-data.js";
import {
  StudioDraftTestDataAuthorizationError,
  type StudioDraftTestDataAuthorizationPort
} from "../drafts/manual-test-data-authorization.js";

export type {
  StudioDraftRunDefinitionPort,
  StudioInstalledRunDefinition,
  StudioInstalledRunDefinitionPort
} from "./launch-definition-ports.js";

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

type CanonicalRunPlanner = Pick<StudioRunLaunchService<unknown>, "plan">;

export type StudioRunLaunchFacadeOptions = {
  readonly planner: CanonicalRunPlanner;
  readonly adapters: StudioRunAdapterInputResolverPort;
  readonly routing: () => Promise<RouterDefinition> | RouterDefinition;
  readonly routingSimulator: StudioRoutingSimulationPort;
  readonly installedDefinitions: StudioInstalledRunDefinitionPort;
  readonly draftDefinitions?: StudioDraftRunDefinitionPort;
  readonly draftTestData?: StudioDraftTestDataAuthorizationPort;
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

export class StudioRunLaunchFacade {
  readonly #planner: CanonicalRunPlanner;
  readonly #adapters: StudioRunAdapterInputResolverPort;
  readonly #routing: StudioRunLaunchFacadeOptions["routing"];
  readonly #routingSimulator: StudioRoutingSimulationPort;
  readonly #installedDefinitions: StudioInstalledRunDefinitionPort;
  readonly #draftDefinitions: StudioDraftRunDefinitionPort | undefined;
  readonly #draftTestData: StudioDraftTestDataAuthorizationPort | undefined;

  constructor(options: StudioRunLaunchFacadeOptions) {
    this.#planner = options.planner;
    this.#adapters = options.adapters;
    this.#routing = options.routing;
    this.#routingSimulator = options.routingSimulator;
    this.#installedDefinitions = options.installedDefinitions;
    this.#draftDefinitions = options.draftDefinitions;
    this.#draftTestData = options.draftTestData;
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
    return await this.#plan(
      parsed.data,
      { kind: "standard" },
      context,
      signal
    );
  }

  async planDraftTest(
    draftId: string,
    rawInput: StudioDraftTestRunPlanInput,
    context: StudioRunLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioRunPlan> {
    const parsed = StudioDraftTestRunPlanInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw studioRunLaunchError(
        "studio_run_plan_invalid",
        "Draft test plan input is invalid"
      );
    }
    const definitionSource = parsed.data.input.definition_source;
    if (
      definitionSource.kind !== "draft" ||
      definitionSource.draft_id !== draftId
    ) {
      throw studioRunLaunchError(
        "studio_run_plan_invalid",
        "Draft test route does not match its exact definition source"
      );
    }
    let executionProfile: StudioRunExecutionProfile = { kind: "standard" };
    if (parsed.data.test_data !== undefined) {
      if (this.#draftTestData === undefined) {
        throw studioRunLaunchError(
          "studio_run_launch_config_invalid",
          "Draft test data authorization is not configured"
        );
      }
      try {
        executionProfile = {
          kind: "manual_test",
          test_data: await this.#draftTestData.authorize(
            draftId,
            parsed.data.test_data,
            definitionSource.etag
          )
        };
      } catch (cause) {
        throw this.#testDataError(cause);
      }
    }
    return await this.#plan(
      parsed.data.input,
      executionProfile,
      context,
      signal
    );
  }

  async #plan(
    input: StudioRunPlanInput,
    executionProfile: StudioRunExecutionProfile,
    context: StudioRunLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioRunPlan> {
    const resolved = await resolveInvocation(input, this.#adapters, signal);
    const definitionSource = input.definition_source;
    const selected = await resolveRunDefinition({
      source: definitionSource,
      invocation: resolved.invocation,
      routing: this.#routing,
      routingSimulator: this.#routingSimulator,
      installedDefinitions: this.#installedDefinitions,
      ...(this.#draftDefinitions === undefined
        ? {}
        : { draftDefinitions: this.#draftDefinitions }),
      ...(signal === undefined ? {} : { signal })
    });
    const plan = StudioRunPlanSchema.parse(await this.#planner.plan({
      workflow_id: selected.workflowId,
      definition_source: definitionSource,
      invocation: resolved.invocation,
      config: selected.definition.config,
      input_provenance: resolved.provenance,
      execution_profile: executionProfile,
      execution_scope: input.execution_scope
    }, context, signal));

    const current = await reloadRunDefinition({
      source: definitionSource,
      workflowId: selected.workflowId,
      installedDefinitions: this.#installedDefinitions,
      ...(this.#draftDefinitions === undefined
        ? {}
        : { draftDefinitions: this.#draftDefinitions })
    });
    const currentRouting = definitionSource.kind === "installed"
      ? await loadInstalledRouting(this.#routing)
      : undefined;
    if (
      (selected.routingHash !== undefined &&
        (currentRouting === undefined ||
          !studioRunDigestsEqual(currentRouting.hash, selected.routingHash))) ||
      !studioRunDigestsEqual(
        plan.workflow_revision,
        current.workflowRevision
      ) ||
      !studioRunDigestsEqual(
        plan.definition_bundle_hash,
        current.definitionBundleHash
      ) ||
      !studioRunDigestsEqual(
        plan.config_hash,
        studioRunValueDigest(current.config)
      )
    ) {
      throw studioRunLaunchError(
        "studio_run_plan_stale",
        "Installed run inputs changed while the plan was created"
      );
    }
    return plan;
  }

  #testDataError(cause: unknown): StudioRunLaunchError {
    if (!(cause instanceof StudioDraftTestDataAuthorizationError)) {
      return studioRunLaunchError(
        "studio_run_test_data_invalid",
        "Draft test data authorization failed",
        {},
        { cause }
      );
    }
    const code = cause.code === "studio_draft_test_data_unavailable"
      ? "studio_run_test_data_unavailable"
      : cause.code === "studio_draft_test_data_precondition_failed" ||
          cause.code === "studio_draft_test_data_stale" ||
          cause.code === "studio_draft_test_data_definition_mismatch"
        ? "studio_run_test_data_stale"
        : "studio_run_test_data_invalid";
    return studioRunLaunchError(code, cause.message, {}, { cause });
  }
}
