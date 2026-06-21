import { openGitHubChangeRequest } from "./providers/github/change-request-actions.js";
import type { ChangeRequestArtifact, PushBranchArtifact } from "./types.js";

export type OpenChangeRequestInput = {
  enabled: boolean;
  provider: string;
  cwd: string;
  push: PushBranchArtifact;
  branch: string;
  baseRef?: string;
  draft: boolean;
  title: string;
  body?: string;
};

type ChangeRequestProviderError = Error & {
  code: "change_request_provider_unsupported";
};

function unsupportedProviderError(provider: string): ChangeRequestProviderError {
  const error = new Error(
    `Unsupported change request provider: ${provider}`
  ) as ChangeRequestProviderError;
  error.code = "change_request_provider_unsupported";

  return error;
}

export async function openChangeRequest({
  provider,
  ...input
}: OpenChangeRequestInput): Promise<ChangeRequestArtifact> {
  if (provider === "github") {
    return await openGitHubChangeRequest(input);
  }

  throw unsupportedProviderError(provider);
}
