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
  if (invocation.target !== "github_pr") {
    throw resolverError(
      `Repository resolution is not implemented for target: ${invocation.target}`
    );
  }

  const owner = invocation.owner;
  const name = invocation.repo;
  const repository = repositories.find(
    (candidate) =>
      candidate.provider === "github" &&
      candidate.owner.toLowerCase() === owner.toLowerCase() &&
      candidate.name.toLowerCase() === name.toLowerCase()
  );

  if (repository === undefined) {
    throw resolverError(
      `Repository is not configured: github/${owner}/${name}`
    );
  }

  return repository;
}
