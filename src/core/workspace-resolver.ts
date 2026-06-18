import type { Invocation, RepositoryConfig } from "./types.js";

type RepositoryResolverError = Error & {
  code: "repository_not_configured";
};

function resolverError(message: string): RepositoryResolverError {
  const error = new Error(message) as RepositoryResolverError;
  error.code = "repository_not_configured";

  return error;
}

export function resolveRepository(
  invocation: Invocation,
  repositories: readonly RepositoryConfig[]
): RepositoryConfig {
  const repository = repositories.find(
    (candidate) =>
      candidate.provider === "github" &&
      candidate.owner.toLowerCase() === invocation.owner.toLowerCase() &&
      candidate.name.toLowerCase() === invocation.repo.toLowerCase()
  );

  if (repository === undefined) {
    throw resolverError(
      `Repository is not configured: github/${invocation.owner}/${invocation.repo}`
    );
  }

  return repository;
}
