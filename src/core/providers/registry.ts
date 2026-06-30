export type ProviderFactory<TProvider> = {
  readonly provider_id: string;
  createProvider(): TProvider;
};

export type ProviderRegistry<TProvider> = {
  get(providerId: string): TProvider;
};

export type ProviderUnsupportedError<TCode extends string> = Error & {
  code: TCode;
  details: {
    provider: string;
  };
};

function unsupportedProviderError<TCode extends string>({
  providerId,
  label,
  code
}: {
  readonly providerId: string;
  readonly label: string;
  readonly code: TCode;
}): ProviderUnsupportedError<TCode> {
  const error = new Error(
    `Unsupported ${label} provider: ${providerId}`
  ) as ProviderUnsupportedError<TCode>;
  error.code = code;
  error.details = { provider: providerId };

  return error;
}

export function createProviderRegistry<TProvider, TCode extends string>(
  factories: readonly ProviderFactory<TProvider>[],
  options: {
    readonly label: string;
    readonly unsupportedCode: TCode;
  }
): ProviderRegistry<TProvider> {
  const providerById = new Map<string, TProvider>();

  for (const factory of factories) {
    providerById.set(factory.provider_id, factory.createProvider());
  }

  return {
    get(providerId: string): TProvider {
      const provider = providerById.get(providerId);
      if (provider === undefined) {
        throw unsupportedProviderError({
          providerId,
          label: options.label,
          code: options.unsupportedCode
        });
      }

      return provider;
    }
  };
}
