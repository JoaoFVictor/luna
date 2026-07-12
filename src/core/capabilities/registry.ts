import type {
  CapabilityManifest,
  CapabilityWorkflowNodeType
} from "./manifest.js";
import {
  CapabilityRegistrationIndexError,
  createCapabilityRegistrationIndex,
  type CapabilityRegistrationIndex
} from "./registration-index.js";
import { validateCapabilityManifest } from "./validation.js";

export type CapabilityRegistry = {
  get(id: string): CapabilityManifest;
  has(id: string): boolean;
  workflowNodeCapability(
    nodeType: CapabilityWorkflowNodeType
  ): CapabilityManifest | undefined;
  orderedManifests(): CapabilityManifest[];
  registrations(): CapabilityRegistrationIndex;
};

type RegistryErrorCode =
  | "capability_duplicate_id"
  | "capability_duplicate_registration_id"
  | "capability_duplicate_workflow_node_type"
  | "capability_unknown_dependency"
  | "capability_dependency_cycle"
  | "capability_unresolved_reference"
  | "capability_reference_not_declared"
  | "capability_duplicate_side_effect_operation_id"
  | "capability_side_effect_policy_invalid";

export class CapabilityRegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "CapabilityRegistryError";
    this.code = code;
  }
}

export function createCapabilityRegistry(
  manifests: readonly CapabilityManifest[]
): CapabilityRegistry {
  const byId = new Map<string, CapabilityManifest>();
  const workflowNodeCapabilities = new Map<
    CapabilityWorkflowNodeType,
    CapabilityManifest
  >();
  for (const manifest of manifests) {
    validateCapabilityManifest(manifest);
    if (byId.has(manifest.id)) {
      throw new CapabilityRegistryError(
        "capability_duplicate_id",
        `Capability ${manifest.id} is registered more than once.`
      );
    }
    byId.set(manifest.id, manifest);
    for (const nodeType of manifest.workflow_node_types ?? []) {
      const existing = workflowNodeCapabilities.get(nodeType);
      if (existing !== undefined) {
        throw new CapabilityRegistryError(
          "capability_duplicate_workflow_node_type",
          `Workflow node type ${nodeType} is supplied by both ${existing.id} and ${manifest.id}.`
        );
      }
      workflowNodeCapabilities.set(nodeType, manifest);
    }
  }

  for (const manifest of manifests) {
    for (const dependency of manifest.depends_on ?? []) {
      if (!byId.has(dependency)) {
        throw new CapabilityRegistryError(
          "capability_unknown_dependency",
          `Capability ${manifest.id} depends on unknown capability ${dependency}.`
        );
      }
    }
  }

  const ordered = topologicalOrder(manifests, byId);
  const indexes = registrationIndexForRegistry(ordered);
  validateReferences(ordered, indexes);
  validateSideEffectOperationIds(ordered);

  return {
    get(id: string): CapabilityManifest {
      const manifest = byId.get(id);
      if (!manifest) {
        throw new CapabilityRegistryError(
          "capability_unknown_dependency",
          `Unknown capability ${id}.`
        );
      }
      return manifest;
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    workflowNodeCapability(
      nodeType: CapabilityWorkflowNodeType
    ): CapabilityManifest | undefined {
      return workflowNodeCapabilities.get(nodeType);
    },
    orderedManifests(): CapabilityManifest[] {
      return [...ordered];
    },
    registrations(): CapabilityRegistrationIndex {
      return indexes;
    }
  };
}

function registrationIndexForRegistry(
  manifests: readonly CapabilityManifest[]
): CapabilityRegistrationIndex {
  try {
    return createCapabilityRegistrationIndex(manifests);
  } catch (cause) {
    if (cause instanceof CapabilityRegistrationIndexError) {
      throw new CapabilityRegistryError(cause.code, cause.message);
    }
    throw cause;
  }
}

function validateSideEffectOperationIds(
  manifests: readonly CapabilityManifest[]
): void {
  const operationOwners = new Map<string, string>();

  for (const manifest of manifests) {
    for (const policy of Object.values(manifest.policies ?? {})) {
      const operationIds = policy.side_effect_operation_ids ?? [];
      if (
        policy.side_effect_category !== undefined &&
        (policy.side_effect_semantics === undefined ||
          policy.side_effect_semantics === "none")
      ) {
        throw new CapabilityRegistryError(
          "capability_side_effect_policy_invalid",
          `Side-effect policy ${policy.id} cannot declare a category without read/write semantics.`
        );
      }
      if (
        (operationIds.length > 0 &&
          (policy.side_effect_semantics === undefined ||
            policy.side_effect_semantics === "none")) ||
        ((policy.side_effect_semantics === "read" ||
          policy.side_effect_semantics === "write") &&
          operationIds.length === 0)
      ) {
        throw new CapabilityRegistryError(
          "capability_side_effect_policy_invalid",
          `Side-effect policy ${policy.id} must bind read/write semantics to at least one operation id.`
        );
      }
      if (policy.side_effect_semantics === "write") {
        if (
          !policy.retry_semantics ||
          !policy.idempotency_scope ||
          operationIds.length === 0
        ) {
          throw new CapabilityRegistryError(
            "capability_side_effect_policy_invalid",
            `Write side-effect policy ${policy.id} must declare operation ids, idempotency scope, and retry semantics.`
          );
        }
      }

      for (const operationId of operationIds) {
        const existingPolicy = operationOwners.get(operationId);
        if (existingPolicy !== undefined) {
          throw new CapabilityRegistryError(
            "capability_duplicate_side_effect_operation_id",
            `Side-effect operation id ${operationId} is registered by both ${existingPolicy} and ${policy.id}.`
          );
        }
        operationOwners.set(operationId, policy.id);
      }
    }
  }
}

function validateReferences(
  manifests: readonly CapabilityManifest[],
  indexes: CapabilityRegistrationIndex
): void {
  for (const manifest of manifests) {
    for (const builtIn of Object.values(manifest.built_ins ?? {})) {
      for (const portId of builtIn.required_ports ?? []) {
        validateReference(manifest, portId, indexes.ports, "required port");
      }
      if (builtIn.side_effect_policy) {
        validateReference(
          manifest,
          builtIn.side_effect_policy,
          indexes.policies,
          "side-effect policy"
        );
      }
    }

    for (const ids of Object.values(manifest.presets ?? {})) {
      for (const id of ids) {
        validateReference(manifest, id, indexes.all, "preset reference");
      }
    }

    for (const id of manifest.re_exports?.built_ins ?? []) {
      validateReference(manifest, id, indexes.built_ins, "built-in re-export");
    }
    for (const id of manifest.re_exports?.patterns ?? []) {
      validateReference(manifest, id, indexes.patterns, "pattern re-export");
    }
    for (const id of manifest.re_exports?.tools ?? []) {
      validateReference(manifest, id, indexes.tools, "tool re-export");
    }
    for (const id of manifest.re_exports?.gates ?? []) {
      validateReference(manifest, id, indexes.gates, "gate re-export");
    }
    for (const id of manifest.re_exports?.policies ?? []) {
      validateReference(manifest, id, indexes.policies, "policy re-export");
    }
    for (const id of manifest.re_exports?.ports ?? []) {
      validateReference(manifest, id, indexes.ports, "port re-export");
    }
    for (const id of manifest.re_exports?.artifact_publishers ?? []) {
      validateReference(
        manifest,
        id,
        indexes.artifact_publishers,
        "artifact publisher re-export"
      );
    }
  }
}

function validateReference(
  manifest: CapabilityManifest,
  referencedId: string,
  index: { has(id: string): boolean },
  label: string
): void {
  if (!index.has(referencedId)) {
    throw new CapabilityRegistryError(
      "capability_unresolved_reference",
      `Capability ${manifest.id} references unknown ${label} ${referencedId}.`
    );
  }

  const owner = referencedId.split(".", 1)[0];
  if (owner !== manifest.id && !(manifest.depends_on ?? []).includes(owner)) {
    throw new CapabilityRegistryError(
      "capability_reference_not_declared",
      `Capability ${manifest.id} references ${referencedId} without depending on ${owner}.`
    );
  }
}

function topologicalOrder(
  manifests: readonly CapabilityManifest[],
  byId: Map<string, CapabilityManifest>
): CapabilityManifest[] {
  const ordered: CapabilityManifest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(manifest: CapabilityManifest, path: readonly string[]): void {
    if (visited.has(manifest.id)) {
      return;
    }
    if (visiting.has(manifest.id)) {
      throw new CapabilityRegistryError(
        "capability_dependency_cycle",
        `Capability dependency cycle: ${[...path, manifest.id].join(" -> ")}.`
      );
    }

    visiting.add(manifest.id);
    for (const dependency of manifest.depends_on ?? []) {
      const dependencyManifest = byId.get(dependency);
      if (dependencyManifest) {
        visit(dependencyManifest, [...path, manifest.id]);
      }
    }
    visiting.delete(manifest.id);
    visited.add(manifest.id);
    ordered.push(manifest);
  }

  for (const manifest of manifests) {
    visit(manifest, []);
  }

  return ordered;
}
