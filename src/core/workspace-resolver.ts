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
  const targetRepository =
    invocation.target === "github_pr"
      ? {
          provider: "github" as const,
          owner: invocation.owner,
          name: invocation.repo
        }
      : invocation.repository;

  const repository = repositories.find(
    (candidate) =>
      candidate.provider === targetRepository.provider &&
      candidate.owner.toLowerCase() === targetRepository.owner.toLowerCase() &&
      candidate.name.toLowerCase() === targetRepository.name.toLowerCase()
  );

  if (repository === undefined) {
    throw resolverError(
      `Repository is not configured: ${targetRepository.provider}/${targetRepository.owner}/${targetRepository.name}`
    );
  }

  return repository;
}
