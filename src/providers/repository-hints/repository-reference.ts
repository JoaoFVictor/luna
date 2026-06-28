import { z } from "zod";
import type { InvocationRepository } from "../../core/router/invocation.js";

const NonEmptyStringSchema = z.string().min(1);
const RepositoryProviderSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/);

export const RepositoryHintFieldConfigSchema = z
  .object({
    source: z.literal("field"),
    field_id: NonEmptyStringSchema
  })
  .strict();

export const RepositoryHintLabelConfigSchema = z
  .object({
    source: z.literal("label")
  })
  .strict();

export type RepositoryHintResult = {
  repository: InvocationRepository;
  source: string;
};

function parseOwnerAndName(
  value: string
): Pick<InvocationRepository, "owner" | "name"> | undefined {
  const [owner, name, ...extra] = value.split("/");
  const safeSegment = /^[A-Za-z0-9_.-]+$/;

  if (
    owner === undefined ||
    name === undefined ||
    extra.length > 0 ||
    !safeSegment.test(owner) ||
    !safeSegment.test(name)
  ) {
    return undefined;
  }

  return { owner, name };
}

function parseProviderFullName(value: string): InvocationRepository | undefined {
  const trimmed = value.trim();
  const [provider, fullName] = trimmed.split(":", 2);

  if (
    provider === undefined ||
    fullName === undefined ||
    !RepositoryProviderSchema.safeParse(provider).success
  ) {
    return undefined;
  }

  const parsed = parseOwnerAndName(fullName);
  return parsed === undefined ? undefined : { provider, ...parsed };
}

function parseRepositoryHint(value: string): InvocationRepository | undefined {
  return parseProviderFullName(value);
}

function isRepositoryHintLabel(value: string): boolean {
  const trimmed = value.trim();

  return /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed);
}

export function repositoryHintFromField(
  value: string,
  source: string
): RepositoryHintResult | undefined {
  if (value.trim() === "") {
    return undefined;
  }

  const repository = parseRepositoryHint(value);
  if (repository === undefined) {
    throw new Error("Expected repository hint to be provider_full_name");
  }

  return { repository, source };
}

export function repositoryHintFromLabels(
  labels: readonly string[]
): RepositoryHintResult | undefined {
  for (const label of labels) {
    if (!isRepositoryHintLabel(label)) {
      continue;
    }

    const repository = parseRepositoryHint(label);
    if (repository === undefined) {
      throw new Error("Expected repository label hint to be provider_full_name");
    }

    return { repository, source: `label:${label}` };
  }

  return undefined;
}
