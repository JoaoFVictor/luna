import type {
  CapabilityManifest,
  CapabilityReExports
} from "./manifest.js";
import type { PatternRegistration } from "./pattern-registration.js";

type CapabilityValidationCode =
  | "capability_id_invalid"
  | "capability_id_namespace"
  | "capability_registration_id_mismatch"
  | "capability_registration_forbidden"
  | "capability_composition_forbidden"
  | "capability_core_reserved"
  | "capability_manifest_forbidden"
  | "pattern_registration_forbidden";

export class CapabilityValidationError extends Error {
  readonly code: CapabilityValidationCode;

  constructor(code: CapabilityValidationCode, message: string) {
    super(message);
    this.name = "CapabilityValidationError";
    this.code = code;
  }
}

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
  "depends_on",
  "presets",
  "docs",
  "re_exports"
]);

const EXECUTION_ALLOWED_FIELDS = new Set([
  "id",
  "kind",
  "version",
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
    "declaring_node_type",
    "input_schema",
    "output_schema",
    "expand",
    "execution_policy",
    "local_context_roots"
  ]),
  built_ins: new Set([
    "id",
    "input_schema",
    "output_schema",
    "required_ports",
    "side_effect_policy"
  ]),
  tools: new Set([
    "id",
    "protocol",
    "input_schema",
    "output_schema",
    "runtime_requirements",
    "materialization",
    "allowlist_required"
  ]),
  gates: new Set([
    "id",
    "input_schema",
    "decision_schema",
    "output_schema",
    "local_context_roots",
    "interrupt",
    "repair_feedback_schema"
  ]),
  policies: new Set([
    "id",
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
    "capability",
    "option_schema",
    "lifecycle",
    "error_codes"
  ]),
  artifact_publishers: new Set([
    "id",
    "source_node_ownership",
    "path_policy",
    "overwrite_policy",
    "config_schema",
    "backend_requirements",
    "manifest_transaction"
  ]),
  schemas: new Set(["id", "schema"])
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

export function validatePatternRegistration<T extends PatternRegistration>(
  capabilityId: string,
  registration: T
): T {
  validateNamespacedId(capabilityId, registration.id);

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
