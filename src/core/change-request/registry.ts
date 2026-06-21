import type {
  ChangeRequestProvider,
  ChangeRequestRegistry
} from "./contracts.js";

export type ChangeRequestProviderUnsupportedError = Error & {
  code: "change_request_provider_unsupported";
  details: {
    provider: string;
  };
};

function unsupportedProviderError(
  provider: string
): ChangeRequestProviderUnsupportedError {
  const error = new Error(
    `Unsupported change request provider: ${provider}`
  ) as ChangeRequestProviderUnsupportedError;
  error.code = "change_request_provider_unsupported";
  error.details = { provider };

  return error;
}

export function createChangeRequestRegistry(
  providers: readonly ChangeRequestProvider[]
): ChangeRequestRegistry {
  const providerByName = new Map(
    providers.map((provider) => [provider.provider, provider])
  );

  return {
    get(provider: string): ChangeRequestProvider {
      const match = providerByName.get(provider);
      if (match === undefined) {
        throw unsupportedProviderError(provider);
      }

      return match;
    }
  };
}
