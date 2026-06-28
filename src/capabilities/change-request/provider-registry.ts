import type {
  ChangeRequestProviderFactory,
  ChangeRequestProviderPort,
  ChangeRequestProviderRegistry
} from "../change-request/contracts.js";

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

export function createChangeRequestProviderRegistry(
  factories: readonly ChangeRequestProviderFactory[]
): ChangeRequestProviderRegistry {
  const providerById = new Map<string, ChangeRequestProviderPort>();

  for (const factory of factories) {
    providerById.set(factory.provider_id, factory.createProvider());
  }

  return {
    get(providerId: string): ChangeRequestProviderPort {
      const provider = providerById.get(providerId);
      if (provider === undefined) {
        throw unsupportedProviderError(providerId);
      }

      return provider;
    }
  };
}
