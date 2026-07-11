import type {
  CapabilityManifest,
  CapabilityReExports
} from "./manifest.js";
import type { PatternRegistration } from "./pattern-registration.js";
import type { JsonSchemaLike } from "./json-schema-types.js";
import type { StudioPresentable } from "./studio-presentation.js";
import { validateStudioPresentation } from "./studio-presentation-validation.js";
import { CapabilityValidationError } from "./validation-error.js";

export { validateStudioPresentation } from "./studio-presentation-validation.js";
export { CapabilityValidationError } from "./validation-error.js";

const REGISTRATION_FIELDS = [
  "patterns",
  "built_ins",
  "tools",
  "gates",
  "policies",
  "ports",
  "artifact_publishers"
] as const;

const COMPOSITION_FORBIDDEN_FIELDS = [
  ...REGISTRATION_FIELDS,
  "schemas"
] as const;

const COMPOSITION_ALLOWED_FIELDS = new Set([
  "id",
  "kind",
  "version",
  "presentation",
  "depends_on",
  "presets",
  "docs",
  "re_exports"
]);

const EXECUTION_ALLOWED_FIELDS = new Set([
  "id",
  "kind",
  "version",
  "presentation",
  "depends_on",
  "patterns",
  "built_ins",
  "tools",
  "gates",
  "policies",
  "schemas",
  "ports",
  "artifact_publishers",
  "docs"
]);

const MANIFEST_FORBIDDEN_FIELDS = [
  "executor",
  "executors",
  "generic_compiler_hooks",
  "compiler_hooks",
  "graph_commands",
  "commands",
  "compiler_wide_transforms",
  "compiler_transforms",
  "state_channels",
  "state_schema",
  "runtime_state"
] as const;

const REGISTRATION_ALLOWED_FIELDS = {
  patterns: new Set([
    "id",
    "presentation",
    "declaring_node_type",
    "input_schema",
    "output_schema",
    "expand",
    "execution_policy",
    "local_context_roots"
  ]),
  built_ins: new Set([
    "id",
    "presentation",
    "input_schema",
    "output_schema",
    "required_ports",
    "side_effect_policy"
  ]),
  tools: new Set([
    "id",
    "presentation",
    "protocol",
    "input_schema",
    "output_schema",
    "runtime_requirements",
    "materialization",
    "allowlist_required"
  ]),
  gates: new Set([
    "id",
    "presentation",
    "input_schema",
    "decision_schema",
    "output_schema",
    "local_context_roots",
    "interrupt",
    "repair_feedback_schema"
  ]),
  policies: new Set([
    "id",
    "presentation",
    "config_schema",
    "local_context_roots",
    "side_effect_semantics",
    "side_effect_operation_ids",
    "idempotency_scope",
    "retry_semantics",
    "error_codes"
  ]),
  ports: new Set([
    "id",
    "presentation",
    "capability",
    "option_schema",
    "lifecycle",
    "error_codes"
  ]),
  artifact_publishers: new Set([
    "id",
    "presentation",
    "source_node_ownership",
    "path_policy",
    "overwrite_policy",
    "config_schema",
    "backend_requirements",
    "manifest_transaction"
  ]),
  schemas: new Set(["id", "presentation", "schema"])
} as const;

const RE_EXPORT_FIELDS = [
  "built_ins",
  "patterns",
  "tools",
  "gates",
  "policies",
  "ports",
  "artifact_publishers"
] as const satisfies readonly (keyof CapabilityReExports)[];

const FORBIDDEN_PATTERN_FIELDS = [
  "compiler_hooks",
  "generic_compiler_hooks",
  "graph_commands",
  "commands",
  "compiler_transforms",
  "compiler_wide_transforms",
  "state_channels",
  "state_schema",
  "runtime_state"
] as const;

const RESERVED_CORE_DOMAIN_BUILT_INS = new Set([
  "core.collect_context",
  "core.final_report",
  "core.gated_agent_loop",
  "core.command_validation",
  "core.capture_workspace",
  "core.git_commit",
  "core.create_change_request"
]);

export function validateCapabilityManifest<T extends CapabilityManifest>(
  manifest: T
): T {
  validateCapabilityId(manifest.id, "Capability id");

  if (Object.hasOwn(manifest, "presentation")) {
    validateStudioPresentation(
      manifest.presentation,
      `Capability ${manifest.id} presentation`
    );
  }

  validateRegistrationPresentations(
    manifest.built_ins,
    (item) => item.input_schema
  );
  validateRegistrationPresentations(manifest.tools, (item) => item.input_schema);
  validateRegistrationPresentations(manifest.gates, (item) => item.input_schema);
  validateRegistrationPresentations(
    manifest.policies,
    (item) => item.config_schema
  );
  validateRegistrationPresentations(manifest.ports, (item) => item.option_schema);
  validateRegistrationPresentations(
    manifest.artifact_publishers,
    (item) => item.config_schema
  );
  validateRegistrationPresentations(manifest.schemas, (item) => item.schema);

  for (const dependency of manifest.depends_on ?? []) {
    validateCapabilityId(dependency, "Capability dependency id");
  }

  for (const field of MANIFEST_FORBIDDEN_FIELDS) {
    if (field in manifest) {
      throw new CapabilityValidationError(
        "capability_manifest_forbidden",
        `Capability ${manifest.id} cannot define manifest-level ${field}.`
      );
    }
  }

  if (manifest.kind === "composition") {
    for (const field of Object.keys(manifest)) {
      if (!COMPOSITION_ALLOWED_FIELDS.has(field)) {
        throw new CapabilityValidationError(
          "capability_composition_forbidden",
          `Composition capability ${manifest.id} cannot define ${field}.`
        );
      }
    }
    for (const field of COMPOSITION_FORBIDDEN_FIELDS) {
      if (field in manifest) {
        throw new CapabilityValidationError(
          "capability_composition_forbidden",
          `Composition capability ${manifest.id} cannot define ${field}.`
        );
      }
    }
  } else {
    for (const field of Object.keys(manifest)) {
      if (!EXECUTION_ALLOWED_FIELDS.has(field)) {
        throw new CapabilityValidationError(
          "capability_manifest_forbidden",
          `Execution capability ${manifest.id} cannot define ${field}.`
        );
      }
    }
  }

  for (const field of REGISTRATION_FIELDS) {
    const registrations = manifest[field];
    if (!registrations) {
      continue;
    }

    for (const [key, registration] of Object.entries(registrations)) {
      validateRegistrationShape(field, key, registration);
      validateNamespacedId(manifest.id, key);
      validateNamespacedId(manifest.id, registration.id);
      if (key !== registration.id) {
        throw new CapabilityValidationError(
          "capability_registration_id_mismatch",
          `Registration key ${key} must match registration id ${registration.id}.`
        );
      }
      if (field === "patterns") {
        validatePatternRegistration(manifest.id, registration);
      }
      if (field === "ports" && registration.capability !== manifest.id) {
        throw new CapabilityValidationError(
          "capability_id_namespace",
          `Port ${registration.id} must name owning capability ${manifest.id}.`
        );
      }
      if (field === "policies") {
        for (const operationId of registration.side_effect_operation_ids ?? []) {
          validateNamespacedId(manifest.id, operationId);
        }
      }
    }
  }

  if (manifest.schemas) {
    for (const [key, registration] of Object.entries(manifest.schemas)) {
      validateRegistrationShape("schemas", key, registration);
      validateNamespacedId(manifest.id, key);
      validateNamespacedId(manifest.id, registration.id);
      if (key !== registration.id) {
        throw new CapabilityValidationError(
          "capability_registration_id_mismatch",
          `Registration key ${key} must match registration id ${registration.id}.`
        );
      }
    }
  }

  if (manifest.re_exports) {
    for (const field of RE_EXPORT_FIELDS) {
      for (const id of manifest.re_exports[field] ?? []) {
        requireQualifiedId(id, `Re-exported ${field} id`);
      }
    }
  }

  for (const builtInId of Object.keys(manifest.built_ins ?? {})) {
    if (RESERVED_CORE_DOMAIN_BUILT_INS.has(builtInId)) {
      throw new CapabilityValidationError(
        "capability_core_reserved",
        `${builtInId} uses the reserved core namespace for a domain built-in.`
      );
    }
  }

  return manifest;
}

function validateRegistrationShape(
  kind: keyof typeof REGISTRATION_ALLOWED_FIELDS,
  key: string,
  registration: Record<string, unknown>
): void {
  const allowedFields = REGISTRATION_ALLOWED_FIELDS[kind];
  for (const field of Object.keys(registration)) {
    if (!allowedFields.has(field)) {
      throw new CapabilityValidationError(
        "capability_registration_forbidden",
        `Registration ${key} cannot define ${field}.`
      );
    }
  }
}

function validateRegistrationPresentations<T extends StudioPresentable>(
  registrations: Readonly<Record<string, T>> | undefined,
  ownerSchema: (registration: T) => JsonSchemaLike | undefined
): void {
  for (const [id, registration] of Object.entries(registrations ?? {})) {
    if (Object.hasOwn(registration, "presentation")) {
      validateStudioPresentation(
        registration.presentation,
        `Registration ${id} presentation`,
        ownerSchema(registration)
      );
    }
  }
}

export function validatePatternRegistration<T extends PatternRegistration>(
  capabilityId: string,
  registration: T
): T {
  validateNamespacedId(capabilityId, registration.id);

  if (Object.hasOwn(registration, "presentation")) {
    validateStudioPresentation(
      registration.presentation,
      `Pattern ${registration.id} presentation`,
      registration.input_schema
    );
  }

  const candidate = registration as T & Record<string, unknown>;
  for (const field of FORBIDDEN_PATTERN_FIELDS) {
    if (field in candidate) {
      throw new CapabilityValidationError(
        "pattern_registration_forbidden",
        `Pattern ${registration.id} cannot define ${field}.`
      );
    }
  }

  if (
    registration.declaring_node_type !== "pattern" ||
    registration.expand.type !== "declaring_node_subgraph"
  ) {
    throw new CapabilityValidationError(
      "pattern_registration_forbidden",
      `Pattern ${registration.id} may only expand its own declaring node.`
    );
  }

  validatePatternExecutionPolicy(registration);

  return registration;
}

function validatePatternExecutionPolicy(
  registration: PatternRegistration
): void {
  const executionPolicy = registration.execution_policy;
  if (executionPolicy === undefined) {
    return;
  }

  if (
    typeof executionPolicy !== "object" ||
    executionPolicy === null
  ) {
    throw new CapabilityValidationError(
      "pattern_registration_forbidden",
      `Pattern ${registration.id} has invalid execution_policy.`
    );
  }

  const candidate = executionPolicy as Record<string, unknown>;
  for (const field of Object.keys(candidate)) {
    if (field !== "batch_exclusion_keys") {
      throw new CapabilityValidationError(
        "pattern_registration_forbidden",
        `Pattern ${registration.id} cannot define execution_policy.${field}.`
      );
    }
  }

  if (
    candidate.batch_exclusion_keys !== undefined &&
    (
      !Array.isArray(candidate.batch_exclusion_keys) ||
      candidate.batch_exclusion_keys.some((key) => typeof key !== "string")
    )
  ) {
    throw new CapabilityValidationError(
      "pattern_registration_forbidden",
      `Pattern ${registration.id} has invalid execution_policy.batch_exclusion_keys.`
    );
  }
}

function validateNamespacedId(capabilityId: string, id: string): void {
  requireQualifiedId(id, "Capability-provided id");
  if (!id.startsWith(`${capabilityId}.`)) {
    throw new CapabilityValidationError(
      "capability_id_namespace",
      `${id} must be namespaced by capability ${capabilityId}.`
    );
  }
}

function validateCapabilityId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new CapabilityValidationError(
      "capability_id_invalid",
      `${label} ${id} must match ^[a-z][a-z0-9-]*$.`
    );
  }
}

function requireQualifiedId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/.test(id)) {
    throw new CapabilityValidationError(
      "capability_id_namespace",
      `${label} ${id} must be qualified as <capability>.<id>.`
    );
  }
}
