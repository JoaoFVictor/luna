import type { RepositoryConfig } from "../config/schemas.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";

export type ContextReadFile = {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
};

export type ContextMissingFile = {
  readonly path: string;
};

export type ContextSkippedFile = {
  readonly path: string;
  readonly reason: "path_escape" | "not_file" | "too_large";
  readonly bytes?: number;
};

export type ContextFileCollection = {
  readonly root: string;
  readonly configured: readonly string[];
  readonly read: readonly ContextReadFile[];
  readonly missing: readonly ContextMissingFile[];
  readonly skipped: readonly ContextSkippedFile[];
};

export type AgentContextCollection = ContextFileCollection & {
  readonly id: string;
};

export type ContextIntake = {
  readonly kind: "luna.collect_context.v1";
  readonly repository: ContextFileCollection;
  readonly agents: readonly AgentContextCollection[];
};

export type CollectContextIntakeInput = {
  readonly repository: RepositoryConfig;
  readonly repositoryRoot: string;
  readonly agentsRoot: string;
  readonly agentIds: readonly string[];
  readonly maxFileBytes?: number;
  readonly capabilityRegistry?: Pick<CapabilityRegistry, "registrations">;
};

const skippedReasons = new Set(["path_escape", "not_file", "too_large"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isReadFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isNumber(value.bytes) &&
    typeof value.content === "string"
  );
}

function isMissingFile(value: unknown): boolean {
  return isRecord(value) && typeof value.path === "string";
}

function isSkippedFile(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.reason !== "string" ||
    !skippedReasons.has(value.reason)
  ) {
    return false;
  }

  return value.bytes === undefined || isNumber(value.bytes);
}

function isContextFileCollection(
  value: unknown
): value is ContextFileCollection {
  return (
    isRecord(value) &&
    typeof value.root === "string" &&
    isStringArray(value.configured) &&
    Array.isArray(value.read) &&
    value.read.every(isReadFile) &&
    Array.isArray(value.missing) &&
    value.missing.every(isMissingFile) &&
    Array.isArray(value.skipped) &&
    value.skipped.every(isSkippedFile)
  );
}

function isAgentContextCollection(
  value: unknown
): value is AgentContextCollection {
  return (
    isContextFileCollection(value) &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export function contextIntakeFrom(value: unknown): ContextIntake | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.kind !== "luna.collect_context.v1" ||
    !isContextFileCollection(value.repository) ||
    !Array.isArray(value.agents) ||
    !value.agents.every(isAgentContextCollection)
  ) {
    return undefined;
  }

  return {
    kind: "luna.collect_context.v1",
    repository: value.repository,
    agents: value.agents
  };
}
