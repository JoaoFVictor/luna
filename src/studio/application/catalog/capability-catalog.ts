import type {
  ArtifactPublisherRegistration,
  BuiltInRegistration,
  CapabilityManifest,
  GateRegistration,
  PolicyRegistration,
  PortRegistration,
  SchemaRegistration,
  ToolRegistration
} from "../../../core/capabilities/manifest.js";
import type { PatternRegistration } from "../../../core/capabilities/pattern-registration.js";
import type { CapabilityRegistry } from "../../../core/capabilities/registry.js";
import type { StudioPresentation } from "../../../core/capabilities/studio-presentation.js";
import type { BuiltInStepMetadata } from "../../../core/built-ins/types.js";
import { assertJsonValue, type JsonValue } from "../../../core/json/value.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  StudioCapabilityCatalogSchema,
  StudioCapabilityRegistrationSchema,
  StudioCapabilitySummarySchema,
  StudioRegistrationPresentationSchema,
  type StudioCapabilityCatalog,
  type StudioCapabilityRegistration,
  type StudioCapabilitySummary,
  type StudioRegistrationPresentation
} from "../../contracts/capability-catalog.js";

type RegistrationOwner = StudioCapabilityRegistration["owner"];

function jsonValue(value: unknown, path: string): JsonValue {
  assertJsonValue(value, path);
  return value;
}

function presentation(
  id: string,
  value: StudioPresentation | undefined
): StudioRegistrationPresentation {
  return StudioRegistrationPresentationSchema.parse(value ?? { title: id });
}

function owner(manifest: CapabilityManifest): RegistrationOwner {
  return {
    capability_id: manifest.id,
    capability_version: manifest.version,
    capability_kind: manifest.kind
  };
}

function builtInItem(
  manifest: CapabilityManifest,
  registration: BuiltInRegistration,
  metadata: BuiltInStepMetadata
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "built_in",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    input_schema: jsonValue(
      registration.input_schema,
      `${registration.id}.input_schema`
    ),
    output_schema: jsonValue(
      registration.output_schema,
      `${registration.id}.output_schema`
    ),
    required_ports: registration.required_ports ?? [],
    requires_repository: metadata.requiresRepository === true,
    ...(metadata.deferredLifecycle === undefined
      ? {}
      : { deferred_lifecycle: metadata.deferredLifecycle }),
    ...(registration.side_effect_policy === undefined
      ? {}
      : { side_effect_policy: registration.side_effect_policy })
  });
}

function patternItem(
  manifest: CapabilityManifest,
  registration: PatternRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "pattern",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    declaring_node_type: registration.declaring_node_type,
    input_schema: jsonValue(
      registration.input_schema,
      `${registration.id}.input_schema`
    ),
    output_schema: jsonValue(
      registration.output_schema,
      `${registration.id}.output_schema`
    ),
    expand: registration.expand,
    batch_exclusion_keys:
      registration.execution_policy?.batch_exclusion_keys ?? [],
    local_context_roots: registration.local_context_roots ?? []
  });
}

function toolItem(
  manifest: CapabilityManifest,
  registration: ToolRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "tool",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    protocol: registration.protocol,
    input_schema: jsonValue(
      registration.input_schema,
      `${registration.id}.input_schema`
    ),
    output_schema: jsonValue(
      registration.output_schema,
      `${registration.id}.output_schema`
    ),
    runtime_requirements: registration.runtime_requirements ?? [],
    ...(registration.materialization === undefined
      ? {}
      : { materialization: registration.materialization }),
    allowlist_required: registration.allowlist_required ?? false,
    ...(registration.allowed_agent_modes === undefined
      ? {}
      : { allowed_agent_modes: registration.allowed_agent_modes }),
    ...(registration.safety === undefined
      ? {}
      : {
          safety: {
            local_writes: registration.safety.localWrites,
            network: registration.safety.network,
            external_side_effects: registration.safety.externalSideEffects
          }
        })
  });
}

function gateItem(
  manifest: CapabilityManifest,
  registration: GateRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "gate",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    input_schema: jsonValue(
      registration.input_schema,
      `${registration.id}.input_schema`
    ),
    decision_schema: jsonValue(
      registration.decision_schema,
      `${registration.id}.decision_schema`
    ),
    output_schema: jsonValue(
      registration.output_schema,
      `${registration.id}.output_schema`
    ),
    ...(registration.repair_feedback_schema === undefined
      ? {}
      : {
          repair_feedback_schema: jsonValue(
            registration.repair_feedback_schema,
            `${registration.id}.repair_feedback_schema`
          )
        }),
    local_context_roots: registration.local_context_roots ?? [],
    interrupt: registration.interrupt
  });
}

function policyItem(
  manifest: CapabilityManifest,
  registration: PolicyRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "policy",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    config_schema: jsonValue(
      registration.config_schema,
      `${registration.id}.config_schema`
    ),
    local_context_roots: registration.local_context_roots ?? [],
    ...(registration.side_effect_semantics === undefined
      ? {}
      : { side_effect_semantics: registration.side_effect_semantics }),
    ...(registration.side_effect_category === undefined
      ? {}
      : { side_effect_category: registration.side_effect_category }),
    side_effect_operation_ids: registration.side_effect_operation_ids ?? [],
    ...(registration.idempotency_scope === undefined
      ? {}
      : { idempotency_scope: registration.idempotency_scope }),
    ...(registration.retry_semantics === undefined
      ? {}
      : { retry_semantics: registration.retry_semantics }),
    error_codes: registration.error_codes ?? []
  });
}

function portItem(
  manifest: CapabilityManifest,
  registration: PortRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "port",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    capability: registration.capability,
    option_schema: jsonValue(
      registration.option_schema,
      `${registration.id}.option_schema`
    ),
    lifecycle: registration.lifecycle ?? [],
    error_codes: registration.error_codes ?? []
  });
}

function publisherItem(
  manifest: CapabilityManifest,
  registration: ArtifactPublisherRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "artifact_publisher",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    source_node_ownership: registration.source_node_ownership,
    path_policy: registration.path_policy,
    overwrite_policy: registration.overwrite_policy,
    ...(registration.config_schema === undefined
      ? {}
      : {
          config_schema: jsonValue(
            registration.config_schema,
            `${registration.id}.config_schema`
          )
        }),
    backend_requirements: registration.backend_requirements ?? [],
    manifest_transaction: registration.manifest_transaction
  });
}

function schemaItem(
  manifest: CapabilityManifest,
  registration: SchemaRegistration
): StudioCapabilityRegistration {
  return StudioCapabilityRegistrationSchema.parse({
    registration_kind: "schema",
    id: registration.id,
    owner: owner(manifest),
    presentation: presentation(registration.id, registration.presentation),
    schema: jsonValue(registration.schema, `${registration.id}.schema`)
  });
}

function registrationsFor(
  manifest: CapabilityManifest,
  builtInMetadata: (id: string) => BuiltInStepMetadata
): StudioCapabilityRegistration[] {
  return [
    ...Object.values(manifest.built_ins ?? {}).map((registration) =>
      builtInItem(manifest, registration, builtInMetadata(registration.id))
    ),
    ...Object.values(manifest.patterns ?? {}).map((registration) =>
      patternItem(manifest, registration)
    ),
    ...Object.values(manifest.tools ?? {}).map((registration) =>
      toolItem(manifest, registration)
    ),
    ...Object.values(manifest.gates ?? {}).map((registration) =>
      gateItem(manifest, registration)
    ),
    ...Object.values(manifest.policies ?? {}).map((registration) =>
      policyItem(manifest, registration)
    ),
    ...Object.values(manifest.ports ?? {}).map((registration) =>
      portItem(manifest, registration)
    ),
    ...Object.values(manifest.artifact_publishers ?? {}).map((registration) =>
      publisherItem(manifest, registration)
    ),
    ...Object.values(manifest.schemas ?? {}).map((registration) =>
      schemaItem(manifest, registration)
    )
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function capabilitySummary(
  manifest: CapabilityManifest
): StudioCapabilitySummary {
  const reExports = manifest.re_exports;
  return StudioCapabilitySummarySchema.parse({
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    workflow_node_types: manifest.workflow_node_types ?? [],
    depends_on: manifest.depends_on ?? [],
    presets: manifest.presets ?? {},
    re_exports: {
      built_ins: reExports?.built_ins ?? [],
      patterns: reExports?.patterns ?? [],
      tools: reExports?.tools ?? [],
      gates: reExports?.gates ?? [],
      policies: reExports?.policies ?? [],
      ports: reExports?.ports ?? [],
      artifact_publishers: reExports?.artifact_publishers ?? []
    },
    presentation: presentation(manifest.id, manifest.presentation),
    docs: manifest.docs ?? []
  });
}

function technicalRegistration(
  registration: StudioCapabilityRegistration
): Omit<StudioCapabilityRegistration, "presentation"> {
  const { presentation: _presentation, ...technical } = registration;
  return technical;
}

export function createStudioCapabilityCatalog(
  registry: Pick<CapabilityRegistry, "orderedManifests">,
  options: {
    readonly builtInMetadata?: (id: string) => BuiltInStepMetadata;
  } = {}
): StudioCapabilityCatalog {
  const builtInMetadata = options.builtInMetadata ?? (() => ({}));
  const manifests = registry
    .orderedManifests()
    .sort((left, right) => left.id.localeCompare(right.id));
  const capabilities = manifests.map(capabilitySummary);
  const registrations = manifests.flatMap((manifest) =>
    registrationsFor(manifest, builtInMetadata)
  );
  const technicalCapabilities = manifests.map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    workflow_node_types: manifest.workflow_node_types ?? [],
    depends_on: [...(manifest.depends_on ?? [])].sort(),
    presets: manifest.presets ?? {},
    re_exports: manifest.re_exports ?? {}
  }));
  const presentedCapabilities = capabilities.map((capability) => ({
    id: capability.id,
    presentation: capability.presentation,
    docs: capability.docs
  }));

  return StudioCapabilityCatalogSchema.parse({
    technical_fingerprint: sha256Digest({
      capabilities: technicalCapabilities,
      registrations: registrations.map(technicalRegistration)
    }),
    presentation_fingerprint: sha256Digest({
      capabilities: presentedCapabilities,
      registrations: registrations.map((registration) => ({
        id: registration.id,
        presentation: registration.presentation
      }))
    }),
    capabilities,
    registrations
  });
}
