import { createHash } from "node:crypto";

export type RetrySemantics =
  | "replay_safe"
  | "retry_requires_adoption"
  | "retry_forbidden";

export type IdempotencyScope = "run" | "node" | "attempt" | "external_resource";

export type SideEffectPolicy = {
  readonly capability_id: string;
  readonly operation_id: string;
  readonly idempotency_scope: IdempotencyScope;
  readonly retry_semantics: RetrySemantics;
  readonly adoption_required: boolean;
};

export type SideEffectRetryContext = {
  readonly attempt: number;
  readonly adopted?: boolean;
};

export type SideEffectOperationDeclaration = {
  readonly id: string;
  readonly side_effecting: boolean;
  readonly policy?: SideEffectPolicy;
};

export type IdempotencyKeyInput = {
  readonly run_id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly external_resource_id?: string;
};

type SideEffectErrorCode =
  | "side_effect_operation_id_invalid"
  | "side_effect_operation_duplicate"
  | "side_effect_policy_invalid"
  | "side_effect_policy_missing"
  | "side_effect_external_resource_missing"
  | "side_effect_retry_forbidden"
  | "side_effect_adoption_required";

export class SideEffectPolicyError extends Error {
  readonly code: SideEffectErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SideEffectErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SideEffectPolicyError";
    this.code = code;
    this.details = details;
  }
}

export type SideEffectRegistry = {
  get(operationId: string): SideEffectPolicy | undefined;
  policies(): SideEffectPolicy[];
};

export function createSideEffectPolicy(policy: SideEffectPolicy): SideEffectPolicy {
  assertCapabilityOwnedOperationId(policy.capability_id, policy.operation_id);
  if (
    policy.retry_semantics === "retry_requires_adoption" &&
    policy.adoption_required !== true
  ) {
    throw new SideEffectPolicyError(
      "side_effect_policy_invalid",
      `Side-effect operation ${policy.operation_id} requires adoption.`,
      { operation_id: policy.operation_id }
    );
  }
  return { ...policy };
}

export function createSideEffectRegistry(
  policies: readonly SideEffectPolicy[]
): SideEffectRegistry {
  const byOperationId = new Map<string, SideEffectPolicy>();

  for (const policy of policies) {
    const normalized = createSideEffectPolicy(policy);
    if (byOperationId.has(normalized.operation_id)) {
      throw new SideEffectPolicyError(
        "side_effect_operation_duplicate",
        `Side-effect operation id ${normalized.operation_id} is registered more than once.`,
        { operation_id: normalized.operation_id }
      );
    }
    byOperationId.set(normalized.operation_id, normalized);
  }

  return {
    get(operationId) {
      const policy = byOperationId.get(operationId);
      return policy === undefined ? undefined : { ...policy };
    },
    policies() {
      return [...byOperationId.values()].map((policy) => ({ ...policy }));
    }
  };
}

export function deriveIdempotencyKey(
  policy: SideEffectPolicy,
  input: IdempotencyKeyInput
): string {
  if (
    policy.idempotency_scope === "external_resource" &&
    input.external_resource_id === undefined
  ) {
    throw new SideEffectPolicyError(
      "side_effect_external_resource_missing",
      `Side-effect operation ${policy.operation_id} requires external_resource_id.`,
      { operation_id: policy.operation_id }
    );
  }

  const identity = {
    operation_id: policy.operation_id,
    idempotency_scope: policy.idempotency_scope,
    run_id: input.run_id,
    node_id: input.node_id,
    attempt: input.attempt,
    ...(policy.idempotency_scope === "external_resource"
      ? { external_resource_id: input.external_resource_id }
      : {})
  };

  return `side-effect:${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
}

export function validateRetrySemantics(
  policy: SideEffectPolicy,
  context: SideEffectRetryContext
): void {
  if (context.attempt <= 1) {
    return;
  }

  if (policy.retry_semantics === "replay_safe") {
    return;
  }

  if (policy.retry_semantics === "retry_forbidden") {
    throw new SideEffectPolicyError(
      "side_effect_retry_forbidden",
      `Retry is forbidden for side-effect operation ${policy.operation_id}.`,
      {
        operation_id: policy.operation_id,
        retry_semantics: policy.retry_semantics,
        attempt: context.attempt
      }
    );
  }

  if (policy.retry_semantics === "retry_requires_adoption") {
    if (policy.adoption_required && context.adopted !== true) {
      throw new SideEffectPolicyError(
        "side_effect_adoption_required",
        `Retry requires adoption for side-effect operation ${policy.operation_id}.`,
        {
          operation_id: policy.operation_id,
          retry_semantics: policy.retry_semantics,
          attempt: context.attempt
        }
      );
    }
    return;
  }

  const _exhaustive: never = policy.retry_semantics;
  return _exhaustive;
}

export function assertSideEffectingOperationsHavePolicies(
  operations: readonly SideEffectOperationDeclaration[]
): void {
  for (const operation of operations) {
    if (operation.side_effecting && operation.policy === undefined) {
      throw new SideEffectPolicyError(
        "side_effect_policy_missing",
        `Side-effecting operation ${operation.id} must declare a side-effect policy before workflow start.`,
        { operation_id: operation.id }
      );
    }
  }
}

function assertCapabilityOwnedOperationId(
  capabilityId: string,
  operationId: string
): void {
  if (
    !/^[a-z][a-z0-9-]*$/.test(capabilityId) ||
    !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/.test(operationId) ||
    !operationId.startsWith(`${capabilityId}.`)
  ) {
    throw new SideEffectPolicyError(
      "side_effect_operation_id_invalid",
      `Side-effect operation id ${operationId} must be namespaced by capability ${capabilityId}.`,
      { capability_id: capabilityId, operation_id: operationId }
    );
  }
}
