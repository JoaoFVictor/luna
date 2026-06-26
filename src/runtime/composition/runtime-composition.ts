import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { AgentRuntimePort } from "../../core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { PortRegistration } from "../../core/capabilities/manifest.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import {
  type BackendKind,
  type BackendManifest,
  type BackendRegistration,
  type CheckpointStore,
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
import {
  createFlueAgentRuntimeAdapter,
  type FlueAgentRuntimeRunner
} from "../../agent-runtimes/flue/adapter.js";
import {
  createFilesystemArtifactManifestStore,
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
  createMemoryArtifactManifestStore,
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
import { LunaLangGraphCheckpointer } from "../backends/sqlite/langgraph-checkpointer.js";
import {
  parseRuntimeCompositionConfig,
  selectionOptions,
  type RuntimeBackendsConfig,
  type RuntimeCompositionConfig,
  type RuntimeSelection
} from "./app-config.js";
import { assertRuntimeDurabilityPolicy } from "./durability.js";

type BackendFactory<TOutput> = {
  readonly registration: BackendRegistration;
  readonly create: (options: JsonObject) => TOutput;
};

type BackendFactoryCatalog = {
  readonly artifacts: Record<string, BackendFactory<RuntimeBackends["artifacts"]>>;
  readonly events: Record<string, BackendFactory<RuntimeBackends["events"]>>;
  readonly interrupts: Record<string, BackendFactory<RuntimeBackends["interrupts"]>>;
  readonly checkpoints: Record<string, BackendFactory<RuntimeBackends["checkpoints"]>>;
  readonly runtime_logs: Record<string, BackendFactory<RuntimeBackends["runtimeLogs"]>>;
};

export type RuntimeComposition = {
  readonly backends: RuntimeBackends;
  readonly agentRuntime: AgentRuntimePort;
  readonly interruptAuthorization: InterruptResumeAuthorizationPort;
  readonly capabilityPorts: Record<string, RuntimeCapabilityPort>;
  readonly backendManifests: BackendManifest[];
  readonly checkpointDurability: {
    readonly backend_id: string;
    readonly durable: boolean;
  };
  readonly langGraphCheckpointer?: BaseCheckpointSaver;
};

export type RuntimeCompositionDependencies = {
  readonly flueRunner?: FlueAgentRuntimeRunner;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly workflowDefinition?: Pick<WorkflowDefinition, "id" | "mode" | "graph">;
  readonly requiresHumanInterrupts?: boolean;
  readonly hasExternalSideEffects?: boolean;
};

export type RuntimeCapabilityPort = {
  readonly name: string;
  readonly id: string;
  readonly capability: string;
  readonly options: JsonObject;
  readonly lifecycle: readonly ("validate" | "open" | "close")[];
};

const BACKEND_FACTORIES: BackendFactoryCatalog = {
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
  group: keyof BackendFactoryCatalog,
  expectedKind: BackendKind,
  selection: RuntimeSelection,
  factories: Record<string, BackendFactory<TOutput>>
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
  if (selection.id !== "flue") {
    throw runtimeError("Unsupported agent runtime id", "runtime_backend_invalid", {
      details: { agent_runtime_id: selection.id, supported_agent_runtime_ids: ["flue"] }
    });
  }
  validateEmptyOptions(selection, "agent_runtime");
  if (config.mode === "production" && dependencies.flueRunner === undefined) {
    throw runtimeError("Production Flue runtime requires an injected runner", "runtime_backend_invalid", {
      details: { agent_runtime_id: selection.id }
    });
  }

  return createFlueAgentRuntimeAdapter({ runner: dependencies.flueRunner });
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

function langGraphCheckpointerFor(
  selection: RuntimeSelection,
  checkpoints: CheckpointStore
): BaseCheckpointSaver | undefined {
  return selection.id === sqliteCheckpointBackendRegistration.id
    ? new LunaLangGraphCheckpointer(checkpoints)
    : undefined;
}

export function runtimeBackendManifests(
  backends: RuntimeBackendsConfig
): BackendManifest[] {
  return [
    backendManifest(
      backends.artifacts,
      requireBackendFactory("artifacts", backends.artifacts).registration
    ),
    backendManifest(
      backends.events,
      requireBackendFactory("events", backends.events).registration
    ),
    backendManifest(
      backends.interrupts,
      requireBackendFactory("interrupts", backends.interrupts).registration
    ),
    backendManifest(
      backends.checkpoints,
      requireBackendFactory("checkpoints", backends.checkpoints).registration
    ),
    backendManifest(
      backends.runtime_logs,
      requireBackendFactory("runtime_logs", backends.runtime_logs).registration
    )
  ];
}

function requireBackendFactory(
  group: keyof BackendFactoryCatalog,
  selection: RuntimeSelection
): BackendFactory<unknown> {
  const factories = BACKEND_FACTORIES[group] as Record<string, BackendFactory<unknown>>;
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
  rawConfig: RuntimeCompositionConfig,
  dependencies: RuntimeCompositionDependencies = {}
): RuntimeComposition {
  const config = parseRuntimeCompositionConfig(rawConfig);
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
    BACKEND_FACTORIES.artifacts
  );
  const events = selectedBackend(
    "events",
    "event",
    config.backends.events,
    BACKEND_FACTORIES.events
  );
  const interrupts = selectedBackend(
    "interrupts",
    "interrupt",
    config.backends.interrupts,
    BACKEND_FACTORIES.interrupts
  );
  const checkpoints = selectedBackend(
    "checkpoints",
    "checkpoint",
    config.backends.checkpoints,
    BACKEND_FACTORIES.checkpoints
  );
  const runtimeLogs = selectedBackend(
    "runtime_logs",
    "runtime_log",
    config.backends.runtime_logs,
    BACKEND_FACTORIES.runtime_logs
  );
  const langGraphCheckpointer = langGraphCheckpointerFor(
    config.backends.checkpoints,
    checkpoints.output
  );

  return {
    backends: {
      artifacts: artifacts.output,
      events: events.output,
      interrupts: interrupts.output,
      checkpoints: checkpoints.output,
      runtimeLogs: runtimeLogs.output
    },
    agentRuntime: createAgentRuntime(config, dependencies),
    interruptAuthorization: createInterruptAuthorization(
      config.interrupt_authorization
    ),
    capabilityPorts: resolveCapabilityPorts(
      config.capability_ports,
      dependencies.capabilityRegistry
    ),
    backendManifests: [
      artifacts.manifest,
      events.manifest,
      interrupts.manifest,
      checkpoints.manifest,
      runtimeLogs.manifest
    ],
    checkpointDurability: {
      backend_id: config.backends.checkpoints.id,
      durable: config.backends.checkpoints.id === sqliteCheckpointBackendRegistration.id
    },
    ...(langGraphCheckpointer === undefined
      ? {}
      : {
          langGraphCheckpointer
        })
  };
}

export function createRuntimeCompositionForWorkflow(
  rawConfig: RuntimeCompositionConfig,
  workflowDefinition: Pick<WorkflowDefinition, "id" | "mode" | "graph">,
  dependencies: Omit<RuntimeCompositionDependencies, "workflowDefinition">
): RuntimeComposition {
  return createRuntimeComposition(rawConfig, {
    ...dependencies,
    workflowDefinition
  });
}
