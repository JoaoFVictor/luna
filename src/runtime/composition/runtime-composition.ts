import {
  AgentRuntimeError,
  type AgentRuntimePort
} from "../../core/agent-runtime/contracts.js";
import {
  transactionalArtifactPublisher,
  type ArtifactPublisherPort
} from "../../capabilities/artifacts/publisher.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { PortRegistration } from "../../core/capabilities/manifest.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import {
  type BackendKind,
  type BackendManifest,
  type BackendRegistration,
  type JsonObject,
  type RuntimeBackends
} from "../../core/runtime/backends/contracts.js";
import { validateBackendManifest } from "../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  allowInterruptResume,
  type InterruptResumeAuthorizationPort
} from "../../core/runtime/interrupts/authorization.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type {
  WorkflowRuntimeFactory,
  WorkflowRuntimeRunner
} from "../../core/workflow/runner-port.js";
import {
  createFilesystemArtifactContentStore,
  createFilesystemArtifactManifestStore,
  createFilesystemArtifactTransactionJournal,
  filesystemArtifactManifestBackendRegistration
} from "../backends/filesystem/artifacts.js";
import {
  createFilesystemEventStore,
  filesystemEventBackendRegistration
} from "../backends/filesystem/events.js";
import {
  createFilesystemRuntimeLogStore,
  filesystemRuntimeLogBackendRegistration
} from "../backends/filesystem/runtime-log.js";
import {
  createMemoryArtifactContentStore,
  createMemoryArtifactManifestStore,
  createMemoryArtifactTransactionJournal,
  memoryArtifactManifestBackendRegistration
} from "../backends/memory/artifacts.js";
import {
  createMemoryCheckpointStore,
  memoryCheckpointBackendRegistration
} from "../backends/memory/checkpoints.js";
import {
  createMemoryEventStore,
  memoryEventBackendRegistration
} from "../backends/memory/events.js";
import {
  createMemoryInterruptStore,
  memoryInterruptBackendRegistration
} from "../backends/memory/interrupts.js";
import {
  createMemoryRuntimeLogStore,
  memoryRuntimeLogBackendRegistration
} from "../backends/memory/runtime-log.js";
import {
  createSqliteCheckpointStore,
  sqliteCheckpointBackendRegistration
} from "../backends/sqlite/checkpoints.js";
import {
  parseRuntimeCompositionConfig,
  selectionOptions,
  type RuntimeBackendsConfig,
  type RuntimeCompositionConfig,
  type RuntimeCompositionConfigInput,
  type RuntimeSelection
} from "./app-config.js";
import { assertRuntimeDurabilityPolicy } from "./durability.js";

export type RuntimeBackendFactory<TOutput> = {
  readonly registration: BackendRegistration;
  readonly create: (options: JsonObject) => TOutput;
};

export type RuntimeBackendFactoryCatalog = {
  readonly artifacts: Record<string, RuntimeBackendFactory<RuntimeBackends["artifacts"]>>;
  readonly events: Record<string, RuntimeBackendFactory<RuntimeBackends["events"]>>;
  readonly interrupts: Record<string, RuntimeBackendFactory<RuntimeBackends["interrupts"]>>;
  readonly checkpoints: Record<string, RuntimeBackendFactory<RuntimeBackends["checkpoints"]>>;
  readonly runtime_logs: Record<string, RuntimeBackendFactory<RuntimeBackends["runtimeLogs"]>>;
};

export type RuntimeComposition = {
  readonly backends: RuntimeBackends;
  readonly artifactPublisherForRun: (run: RunHandle) => ArtifactPublisherPort;
  readonly workflowRuntime: WorkflowRuntimeRunner<
    RunWorkflowInput,
    ResumeWorkflowInput,
    WorkflowRunResult
  >;
  readonly agentRuntime: AgentRuntimePort;
  readonly interruptAuthorization: InterruptResumeAuthorizationPort;
  readonly capabilityPorts: Record<string, RuntimeCapabilityPort>;
  readonly backendManifests: BackendManifest[];
  readonly checkpointDurability: {
    readonly backend_id: string;
    readonly durable: boolean;
  };
};

export type RuntimeCompositionDependencies = {
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly workflowDefinition?: Pick<WorkflowDefinition, "id" | "mode" | "graph">;
  readonly requiresHumanInterrupts?: boolean;
  readonly hasExternalSideEffects?: boolean;
  readonly agentRuntimeFactories?: Readonly<Record<string, AgentRuntimeFactory>>;
  readonly workflowRuntimeFactories?: Readonly<Record<
    string,
    WorkflowRuntimeFactory<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult>
  >>;
  readonly backendFactories?: RuntimeBackendFactoryCatalog;
};

export type RuntimeCapabilityPort = {
  readonly name: string;
  readonly id: string;
  readonly capability: string;
  readonly options: JsonObject;
  readonly lifecycle: readonly ("validate" | "open" | "close")[];
};

export function defaultRuntimeBackendFactoryCatalog(): RuntimeBackendFactoryCatalog {
  return {
    artifacts: {
      [memoryArtifactManifestBackendRegistration.id]: {
        registration: memoryArtifactManifestBackendRegistration,
        create: () => createMemoryArtifactManifestStore()
      },
      [filesystemArtifactManifestBackendRegistration.id]: {
        registration: filesystemArtifactManifestBackendRegistration,
        create: (options) =>
          createFilesystemArtifactManifestStore(
            validateBackendOptions(options, filesystemArtifactManifestBackendRegistration)
          )
      }
    },
    events: {
      [memoryEventBackendRegistration.id]: {
        registration: memoryEventBackendRegistration,
        create: () => createMemoryEventStore()
      },
      [filesystemEventBackendRegistration.id]: {
        registration: filesystemEventBackendRegistration,
        create: (options) =>
          createFilesystemEventStore(
            validateBackendOptions(options, filesystemEventBackendRegistration)
          )
      }
    },
    interrupts: {
      [memoryInterruptBackendRegistration.id]: {
        registration: memoryInterruptBackendRegistration,
        create: () => createMemoryInterruptStore()
      }
    },
    checkpoints: {
      [memoryCheckpointBackendRegistration.id]: {
        registration: memoryCheckpointBackendRegistration,
        create: () => createMemoryCheckpointStore()
      },
      [sqliteCheckpointBackendRegistration.id]: {
        registration: sqliteCheckpointBackendRegistration,
        create: (options) =>
          createSqliteCheckpointStore(
            validateBackendOptions(options, sqliteCheckpointBackendRegistration)
          )
      }
    },
    runtime_logs: {
      [memoryRuntimeLogBackendRegistration.id]: {
        registration: memoryRuntimeLogBackendRegistration,
        create: () => createMemoryRuntimeLogStore()
      },
      [filesystemRuntimeLogBackendRegistration.id]: {
        registration: filesystemRuntimeLogBackendRegistration,
        create: (options) =>
          createFilesystemRuntimeLogStore(
            validateBackendOptions(options, filesystemRuntimeLogBackendRegistration)
          )
      }
    }
  };
}

export type AgentRuntimeFactory = {
  readonly id: string;
  readonly prepare?: (input: AgentRuntimePrepareInput) => Promise<void> | void;
  readonly create: (options: JsonObject) => AgentRuntimePort;
};

export type AgentRuntimePrepareInput = {
  readonly configRoot: string;
  readonly workflow: Pick<WorkflowDefinition, "id" | "mode" | "graph">;
  readonly options: JsonObject;
  readonly hasAgents: boolean;
};

function createWorkflowRuntime(
  config: RuntimeCompositionConfig,
  dependencies: RuntimeCompositionDependencies,
  context: {
    readonly checkpoints: {
      readonly backendId: string;
      readonly store: RuntimeBackends["checkpoints"];
    };
  }
): WorkflowRuntimeRunner<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult> {
  const selection = config.workflow_runtime;
  if (selection.id === "unconfigured") {
    validateEmptyOptions(selection, "workflow_runtime");
    return createUnconfiguredWorkflowRuntime();
  }
  const factories = dependencies.workflowRuntimeFactories ?? {};
  const factory = factories[selection.id];
  if (factory === undefined) {
    throw runtimeError("Unsupported workflow runtime id", "runtime_backend_invalid", {
      details: {
        workflow_runtime_id: selection.id,
        supported_workflow_runtime_ids: ["unconfigured", ...Object.keys(factories)]
      }
    });
  }

  return factory.create(selectionOptions(selection), context);
}

function createUnconfiguredWorkflowRuntime(): WorkflowRuntimeRunner<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
> {
  return {
    async run() {
      throw runtimeError(
        "No workflow runtime has been configured",
        "runtime_backend_invalid"
      );
    },
    async resume() {
      throw runtimeError(
        "No workflow runtime has been configured",
        "runtime_backend_invalid"
      );
    }
  };
}

function validateBackendOptions<TOptions extends JsonObject>(
  options: JsonObject,
  registration: BackendRegistration<TOptions>
): TOptions {
  return validateBackendManifest(
    { id: registration.id, kind: registration.kind, options },
    registration
  );
}

function backendManifest(
  selection: RuntimeSelection,
  registration: BackendRegistration
): BackendManifest {
  return {
    id: selection.id,
    kind: registration.kind,
    options: selectionOptions(selection)
  };
}

function selectedBackend<TOutput>(
  group: keyof RuntimeBackendFactoryCatalog,
  expectedKind: BackendKind,
  selection: RuntimeSelection,
  factories: Record<string, RuntimeBackendFactory<TOutput>>
): {
  readonly output: TOutput;
  readonly manifest: BackendManifest;
} {
  const factory = factories[selection.id];
  if (factory === undefined) {
    throw runtimeError("Unsupported runtime backend id", "runtime_backend_invalid", {
      details: {
        backend_id: selection.id,
        backend_group: group,
        supported_backend_ids: Object.keys(factories)
      }
    });
  }
  if (factory.registration.kind !== expectedKind) {
    throw runtimeError("Runtime backend kind does not match selection", "runtime_backend_invalid", {
      details: {
        backend_id: selection.id,
        expected_kind: expectedKind,
        actual_kind: factory.registration.kind
      }
    });
  }

  const manifest = backendManifest(selection, factory.registration);
  const options = validateBackendManifest(manifest, factory.registration);

  return {
    output: factory.create(options),
    manifest
  };
}

function createAgentRuntime(
  config: RuntimeCompositionConfig,
  dependencies: RuntimeCompositionDependencies
): AgentRuntimePort {
  const selection = config.agent_runtime;
  if (selection.id === "unconfigured") {
    validateEmptyOptions(selection, "agent_runtime");
    return createUnconfiguredAgentRuntime();
  }
  const factories = dependencies.agentRuntimeFactories ?? {};
  const factory = factories[selection.id];
  if (factory === undefined) {
    throw runtimeError("Unsupported agent runtime id", "runtime_backend_invalid", {
      details: {
        agent_runtime_id: selection.id,
        supported_agent_runtime_ids: ["unconfigured", ...Object.keys(factories)]
      }
    });
  }

  return factory.create(selectionOptions(selection));
}

function createUnconfiguredAgentRuntime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "unconfigured",
      display_name: "Unconfigured",
      supported_tool_protocols: [],
      supported_runtime_requirements: []
    }),
    async validate() {
      throw new AgentRuntimeError(
        "runtime_unknown_failure",
        "No agent runtime has been configured"
      );
    },
    async runAgent() {
      throw new AgentRuntimeError(
        "runtime_unknown_failure",
        "No agent runtime has been configured"
      );
    }
  };
}

function createInterruptAuthorization(
  selection: RuntimeSelection
): InterruptResumeAuthorizationPort {
  if (selection.id !== "allow_all") {
    throw runtimeError("Unsupported interrupt authorization id", "runtime_backend_invalid", {
      details: {
        interrupt_authorization_id: selection.id,
        supported_interrupt_authorization_ids: ["allow_all"]
      }
    });
  }
  validateEmptyOptions(selection, "interrupt_authorization");

  return allowInterruptResume();
}

function resolveCapabilityPorts(
  selections: Record<string, RuntimeSelection> | undefined,
  registry: CapabilityRegistry | undefined
): Record<string, RuntimeCapabilityPort> {
  if (selections === undefined) {
    return {};
  }
  if (registry === undefined) {
    throw runtimeError("Capability port config requires a capability registry", "runtime_backend_invalid");
  }

  return Object.fromEntries(
    Object.entries(selections).map(([name, selection]) => {
      const registration = requirePortRegistration(selection.id, registry);
      const options = selectionOptions(selection);
      if (!matchesJsonSchema(registration.option_schema, options)) {
        throw runtimeError("Capability port options failed schema validation", "runtime_backend_invalid", {
          details: { port_name: name, port_id: selection.id }
        });
      }

      return [
        name,
        {
          name,
          id: registration.id,
          capability: registration.capability,
          options,
          lifecycle: registration.lifecycle ?? []
        }
      ];
    })
  );
}

function requirePortRegistration(
  portId: string,
  registry: CapabilityRegistry
): PortRegistration {
  for (const manifest of registry.orderedManifests()) {
    const port = manifest.ports?.[portId];
    if (port !== undefined) {
      return port;
    }
  }

  throw runtimeError("Unsupported capability port id", "runtime_backend_invalid", {
    details: { port_id: portId }
  });
}

function validateEmptyOptions(selection: RuntimeSelection, label: string): void {
  if (Object.keys(selectionOptions(selection)).length > 0) {
    throw runtimeError(`${label} options are not supported`, "runtime_backend_invalid", {
      details: { id: selection.id }
    });
  }
}

export function runtimeBackendManifests(
  backends: RuntimeBackendsConfig,
  backendFactories: RuntimeBackendFactoryCatalog = defaultRuntimeBackendFactoryCatalog()
): BackendManifest[] {
  return [
    backendManifest(
      backends.artifacts,
      requireBackendFactory("artifacts", backends.artifacts, backendFactories).registration
    ),
    backendManifest(
      backends.events,
      requireBackendFactory("events", backends.events, backendFactories).registration
    ),
    backendManifest(
      backends.interrupts,
      requireBackendFactory("interrupts", backends.interrupts, backendFactories).registration
    ),
    backendManifest(
      backends.checkpoints,
      requireBackendFactory("checkpoints", backends.checkpoints, backendFactories).registration
    ),
    backendManifest(
      backends.runtime_logs,
      requireBackendFactory("runtime_logs", backends.runtime_logs, backendFactories).registration
    )
  ];
}

function requireBackendFactory(
  group: keyof RuntimeBackendFactoryCatalog,
  selection: RuntimeSelection,
  backendFactories: RuntimeBackendFactoryCatalog
): RuntimeBackendFactory<unknown> {
  const factories = backendFactories[group] as Record<string, RuntimeBackendFactory<unknown>>;
  const factory = factories[selection.id];
  if (factory === undefined) {
    throw runtimeError("Unsupported runtime backend id", "runtime_backend_invalid", {
      details: {
        backend_id: selection.id,
        backend_group: group,
        supported_backend_ids: Object.keys(factories)
      }
    });
  }

  validateBackendManifest(backendManifest(selection, factory.registration), factory.registration);
  return factory;
}

export function createRuntimeComposition(
  rawConfig: RuntimeCompositionConfigInput,
  dependencies: RuntimeCompositionDependencies = {}
): RuntimeComposition {
  const config = parseRuntimeCompositionConfig(rawConfig);
  const backendFactories =
    dependencies.backendFactories ?? defaultRuntimeBackendFactoryCatalog();
  assertRuntimeDurabilityPolicy({
    mode: config.mode,
    checkpointBackendId: config.backends.checkpoints.id,
    workflowDefinition: dependencies.workflowDefinition,
    capabilityRegistry: dependencies.capabilityRegistry,
    requiresHumanInterrupts: dependencies.requiresHumanInterrupts,
    hasExternalSideEffects: dependencies.hasExternalSideEffects
  });

  const artifacts = selectedBackend(
    "artifacts",
    "artifact_manifest",
    config.backends.artifacts,
    backendFactories.artifacts
  );
  const events = selectedBackend(
    "events",
    "event",
    config.backends.events,
    backendFactories.events
  );
  const interrupts = selectedBackend(
    "interrupts",
    "interrupt",
    config.backends.interrupts,
    backendFactories.interrupts
  );
  const checkpoints = selectedBackend(
    "checkpoints",
    "checkpoint",
    config.backends.checkpoints,
    backendFactories.checkpoints
  );
  const runtimeLogs = selectedBackend(
    "runtime_logs",
    "runtime_log",
    config.backends.runtime_logs,
    backendFactories.runtime_logs
  );
  const runtimeBackends = {
    artifacts: artifacts.output,
    events: events.output,
    interrupts: interrupts.output,
    checkpoints: checkpoints.output,
    runtimeLogs: runtimeLogs.output
  };
  const backendManifests = [
    artifacts.manifest,
    events.manifest,
    interrupts.manifest,
    checkpoints.manifest,
    runtimeLogs.manifest
  ];

  return {
    backends: runtimeBackends,
    artifactPublisherForRun: (run) =>
      createArtifactPublisher({
        selection: config.backends.artifacts,
        manifestStore: artifacts.output,
        manifest: artifacts.manifest,
        run
    }),
    workflowRuntime: createWorkflowRuntime(config, dependencies, {
      checkpoints: {
        backendId: checkpoints.manifest.id,
        store: checkpoints.output
      }
    }),
    agentRuntime: createAgentRuntime(config, dependencies),
    interruptAuthorization: createInterruptAuthorization(
      config.interrupt_authorization
    ),
    capabilityPorts: resolveCapabilityPorts(
      config.capability_ports,
      dependencies.capabilityRegistry
    ),
    backendManifests,
    checkpointDurability: {
      backend_id: config.backends.checkpoints.id,
      durable: config.backends.checkpoints.id === sqliteCheckpointBackendRegistration.id
    }
  };
}

function createArtifactPublisher({
  selection,
  manifestStore,
  manifest,
  run
}: {
  readonly selection: RuntimeSelection;
  readonly manifestStore: RuntimeBackends["artifacts"];
  readonly manifest: BackendManifest;
  readonly run: RunHandle;
}): ArtifactPublisherPort {
  const options = selectionOptions(selection);

  if (selection.id === memoryArtifactManifestBackendRegistration.id) {
    return transactionalArtifactPublisher({
      run_id: run.run_id,
      backend: { id: manifest.id, root: "memory.artifacts" },
      manifestStore,
      transactionJournal: createMemoryArtifactTransactionJournal(),
      contentStore: createMemoryArtifactContentStore(),
      stepsPublisher: { async publishArtifactRef() {} },
      checkpointMarker: { async markArtifactCheckpointed() {} }
    });
  }

  if (selection.id === filesystemArtifactManifestBackendRegistration.id) {
    const root = String(options.root);
    return transactionalArtifactPublisher({
      run_id: run.run_id,
      backend: { id: manifest.id, root },
      manifestStore,
      transactionJournal: createFilesystemArtifactTransactionJournal({ root }),
      contentStore: createFilesystemArtifactContentStore({ root }),
      stepsPublisher: { async publishArtifactRef() {} },
      checkpointMarker: { async markArtifactCheckpointed() {} }
    });
  }

  throw runtimeError("Unsupported artifact publisher backend", "runtime_backend_invalid", {
    details: { backend_id: selection.id }
  });
}

export function createRuntimeCompositionForWorkflow(
  rawConfig: RuntimeCompositionConfigInput,
  workflowDefinition: Pick<WorkflowDefinition, "id" | "mode" | "graph">,
  dependencies: Omit<RuntimeCompositionDependencies, "workflowDefinition">
): RuntimeComposition {
  return createRuntimeComposition(rawConfig, {
    ...dependencies,
    workflowDefinition
  });
}
