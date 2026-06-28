import { z, type ZodType } from "zod";
import type {
  InvocationRepository,
  InvocationSubject,
  NormalizedInvocation,
  RouteTarget
} from "../router/invocation.js";

export function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

export function requireRepository(
  invocation: NormalizedInvocation
): InvocationRepository {
  if (invocation.repository === undefined) {
    throw codedError(
      "Invocation repository is required",
      "invocation_repository_missing"
    );
  }

  return invocation.repository;
}

export function requireSubject(
  invocation: NormalizedInvocation,
  expectedType?: string
): InvocationSubject {
  if (invocation.subject === undefined) {
    throw codedError("Invocation subject is required", "invocation_subject_missing");
  }

  if (expectedType !== undefined && invocation.subject.type !== expectedType) {
    throw codedError(
      `Invocation subject must be ${expectedType}`,
      "invocation_subject_invalid"
    );
  }

  return invocation.subject;
}

export function requireTarget(invocation: NormalizedInvocation): RouteTarget {
  if (invocation.target === undefined) {
    throw codedError("Invocation target is required", "invocation_target_missing");
  }

  return invocation.target;
}

export function requireReferences<const TKey extends string>(
  invocation: NormalizedInvocation,
  keys: readonly TKey[]
): Record<TKey, string> {
  const references = invocation.references;
  const required = {} as Record<TKey, string>;

  for (const key of keys) {
    const value = references?.[key];
    if (value === undefined || value.length === 0) {
      throw codedError(
        `Invocation reference is required: ${key}`,
        "invocation_reference_missing"
      );
    }

    required[key] = value;
  }

  return required;
}

export function payloadObject(
  invocation: NormalizedInvocation,
  key: string
): Record<string, unknown> {
  const value = invocation.payload?.[key];

  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw codedError(
      `Invocation payload object is required: ${key}`,
      "invocation_payload_missing"
    );
  }

  return value as Record<string, unknown>;
}

export function parsePayload<T>(
  invocation: NormalizedInvocation,
  key: string,
  schema: ZodType<T>,
  errorCode: string
): T {
  try {
    return schema.parse(payloadObject(invocation, key));
  } catch (cause) {
    if (cause instanceof z.ZodError) {
      throw codedError(cause.message, errorCode);
    }

    throw cause;
  }
}
