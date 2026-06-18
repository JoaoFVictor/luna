import type { Invocation, RepositoryConfig } from "../../src/core/types.js";

export const gitRepository: RepositoryConfig = {
  id: "octo-hello",
  provider: "github",
  owner: "octo-org",
  name: "hello-world",
  path: "/repos/octo/hello-world",
  remote: "origin"
};

export const gitInvocation: Invocation & { base_ref: string } = {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "1111111111111111111111111111111111111111",
    head_sha: "2222222222222222222222222222222222222222"
  }
};
