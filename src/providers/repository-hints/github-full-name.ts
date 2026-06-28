import { z } from "zod";
import type { InvocationRepository } from "../../core/router/invocation.js";

const NonEmptyStringSchema = z.string().min(1);

export const RepositoryHintFormatSchema = z.literal("github_full_name");
export type RepositoryHintFormat = z.infer<typeof RepositoryHintFormatSchema>;

export const RepositoryHintFieldConfigSchema = z
  .object({
    source: z.literal("field"),
    field_id: NonEmptyStringSchema,
    format: RepositoryHintFormatSchema
  })
  .strict();

export const RepositoryHintLabelConfigSchema = z
  .object({
    source: z.literal("label"),
    format: RepositoryHintFormatSchema
  })
  .strict();

export type RepositoryHintResult = {
  repository: InvocationRepository;
  source: string;
};

function parseGithubFullName(value: string): InvocationRepository | undefined {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.replace(/^github:/i, "");
  const [owner, name, ...extra] = withoutPrefix.split("/");
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

  return { provider: "github", owner, name };
}

function isRepositoryHintLabel(value: string): boolean {
  return /^(github|repo):/i.test(value.trim());
}

export function repositoryHintFromField(
  value: string,
  source: string
): RepositoryHintResult | undefined {
  if (value.trim() === "") {
    return undefined;
  }

  const repository = parseGithubFullName(value);
  if (repository === undefined) {
    throw new Error("Expected repository hint to be github_full_name");
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

    const repository = parseGithubFullName(label);
    if (repository === undefined) {
      throw new Error("Expected repository label hint to be github_full_name");
    }

    return { repository, source: `label:${label}` };
  }

  return undefined;
}
