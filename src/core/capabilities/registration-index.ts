import type {
  ArtifactPublisherRegistration,
  BuiltInRegistration,
  CapabilityManifest,
  GateRegistration,
  PolicyRegistration,
  PortRegistration,
  SchemaRegistration,
  ToolRegistration
} from "./manifest.js";
import type { PatternRegistration } from "./pattern-registration.js";

export type CapabilityRegistrationKind =
  | "built_ins"
  | "patterns"
  | "tools"
  | "gates"
  | "policies"
  | "ports"
  | "artifact_publishers"
  | "schemas";

export type CapabilityRegistration =
  | BuiltInRegistration
  | PatternRegistration
  | ToolRegistration
  | GateRegistration
  | PolicyRegistration
  | PortRegistration
  | ArtifactPublisherRegistration
  | SchemaRegistration;

export type CapabilityRegistrationIndex = {
  readonly built_ins: ReadonlyMap<string, BuiltInRegistration>;
  readonly patterns: ReadonlyMap<string, PatternRegistration>;
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  readonly gates: ReadonlyMap<string, GateRegistration>;
  readonly policies: ReadonlyMap<string, PolicyRegistration>;
  readonly ports: ReadonlyMap<string, PortRegistration>;
  readonly artifact_publishers: ReadonlyMap<string, ArtifactPublisherRegistration>;
  readonly schemas: ReadonlyMap<string, SchemaRegistration>;
  readonly all: ReadonlySet<string>;
};

export class CapabilityRegistrationIndexError extends Error {
  readonly code = "capability_duplicate_registration_id" as const;

  constructor(id: string) {
    super(`Registration id ${id} is declared more than once.`);
    this.name = "CapabilityRegistrationIndexError";
  }
}

export function createCapabilityRegistrationIndex(
  manifests: readonly CapabilityManifest[]
): CapabilityRegistrationIndex {
  const all = new Set<string>();
  const builtIns = new Map<string, BuiltInRegistration>();
  const patterns = new Map<string, PatternRegistration>();
  const tools = new Map<string, ToolRegistration>();
  const gates = new Map<string, GateRegistration>();
  const policies = new Map<string, PolicyRegistration>();
  const ports = new Map<string, PortRegistration>();
  const artifactPublishers = new Map<string, ArtifactPublisherRegistration>();
  const schemas = new Map<string, SchemaRegistration>();

  for (const manifest of manifests) {
    addRegistrations(all, builtIns, manifest.built_ins);
    addRegistrations(all, patterns, manifest.patterns);
    addRegistrations(all, tools, manifest.tools);
    addRegistrations(all, gates, manifest.gates);
    addRegistrations(all, policies, manifest.policies);
    addRegistrations(all, ports, manifest.ports);
    addRegistrations(all, artifactPublishers, manifest.artifact_publishers);
    addRegistrations(all, schemas, manifest.schemas);
  }

  return {
    built_ins: builtIns,
    patterns,
    tools,
    gates,
    policies,
    ports,
    artifact_publishers: artifactPublishers,
    schemas,
    all
  };
}

export function registrationMapForKind(
  index: CapabilityRegistrationIndex,
  kind: CapabilityRegistrationKind
): ReadonlyMap<string, CapabilityRegistration> {
  switch (kind) {
    case "built_ins":
      return index.built_ins;
    case "patterns":
      return index.patterns;
    case "tools":
      return index.tools;
    case "gates":
      return index.gates;
    case "policies":
      return index.policies;
    case "ports":
      return index.ports;
    case "artifact_publishers":
      return index.artifact_publishers;
    case "schemas":
      return index.schemas;
  }
}

function addRegistrations<T extends { readonly id: string }>(
  all: Set<string>,
  target: Map<string, T>,
  registrations: Record<string, T> | undefined
): void {
  for (const registration of Object.values(registrations ?? {})) {
    if (all.has(registration.id)) {
      throw new CapabilityRegistrationIndexError(registration.id);
    }
    target.set(registration.id, registration);
    all.add(registration.id);
  }
}
