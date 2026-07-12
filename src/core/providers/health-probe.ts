export type ProviderHealthProbeEffect =
  | "credential_read"
  | "network_read"
  | "process_execution";

export type ProviderHealthProbeContext = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly signal: AbortSignal;
};

export type ProviderHealthProbe = {
  /** Provider id, for example github or jira. */
  readonly id: string;
  readonly timeout_ms: number;
  readonly effects: readonly ProviderHealthProbeEffect[];
  /** Returns only provider-safe, credential-free presentation text. */
  readonly run: (context: ProviderHealthProbeContext) => Promise<{
    readonly summary: string;
  }>;
};
