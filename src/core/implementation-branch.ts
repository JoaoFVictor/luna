import { createHash } from "node:crypto";

export type ImplementationBranchMetadata = {
  branchSeed: string;
  branchName: string;
  collisionAttempt: number;
  collisionSuffix: string;
};

export type ImplementationBranchSubject = {
  key: string;
  title?: string;
};

export type ImplementationBranchErrorCode =
  | "invalid_branch_length"
  | "invalid_branch_pattern";

export type ImplementationBranchError = Error & {
  code: ImplementationBranchErrorCode;
};

function implementationBranchError(
  message: string,
  code: ImplementationBranchErrorCode
): ImplementationBranchError {
  const error = new Error(message) as ImplementationBranchError;
  error.code = code;

  return error;
}

function sanitizeBranchSeedPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function branchSeedFrom(subject: ImplementationBranchSubject): string {
  const parts = [
    sanitizeBranchSeedPart(subject.key),
    sanitizeBranchSeedPart(subject.title ?? subject.key)
  ].filter((part) => part !== "");
  const seed = [...new Set(parts)].join("-");

  return seed === "" ? "subject" : seed;
}

function runHashFrom(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 12);
}

function truncateBranchSeed(branchSeed: string, maxLength: number): string {
  if (branchSeed.length <= maxLength) {
    return branchSeed;
  }

  return branchSeed.slice(0, maxLength).replace(/-+$/g, "");
}

export function implementationBranchMetadata({
  subject,
  branchPattern,
  runId,
  collisionAttempt = 1,
  maxBranchLength
}: {
  subject: ImplementationBranchSubject;
  branchPattern: string;
  runId: string;
  collisionAttempt?: number;
  maxBranchLength?: number;
}): ImplementationBranchMetadata {
  const placeholder = "{slug}";
  const placeholderCount = branchPattern.split(placeholder).length - 1;

  if (placeholderCount !== 1) {
    throw implementationBranchError(
      `Branch pattern must include exactly one ${placeholder}`,
      "invalid_branch_pattern"
    );
  }

  const rawBranchSeed = branchSeedFrom(subject);
  const collisionSuffix =
    collisionAttempt === 1 ? "" : `-r${collisionAttempt}`;
  const hashSuffix = `-${runHashFrom(runId)}`;
  const suffix = `${hashSuffix}${collisionSuffix}`;
  const staticLength = branchPattern.length - placeholder.length;
  const maxSeedLength =
    maxBranchLength === undefined
      ? rawBranchSeed.length
      : maxBranchLength - staticLength - suffix.length;

  if (maxSeedLength <= 0) {
    throw implementationBranchError(
      "Branch pattern and suffix exceed max branch length",
      "invalid_branch_length"
    );
  }

  const branchSeed = truncateBranchSeed(rawBranchSeed, maxSeedLength);

  if (branchSeed === "") {
    throw implementationBranchError(
      "Branch length limit cannot fit branch seed",
      "invalid_branch_length"
    );
  }

  return {
    branchSeed,
    branchName: branchPattern.replace(placeholder, `${branchSeed}${suffix}`),
    collisionAttempt,
    collisionSuffix
  };
}
