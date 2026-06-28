import type {
  WebhookProviderAdapter,
  WebhookProviderAdapterFactory,
  WebhookProviderRegistration
} from "./contracts.js";
import {
  duplicateWebhookProvider,
  webhookError,
  type WebhookError
} from "./errors.js";

export type WebhookProviderRegistry<
  Entry extends WebhookProviderRegistration = WebhookProviderAdapter
> = {
  get(id: string): Entry | undefined;
  require(id: string): Entry;
  ids(): string[];
};

export function unknownWebhookProviderError(
  provider: string,
  registry: Pick<WebhookProviderRegistry, "ids">
): WebhookError {
  const available = registry.ids();
  const availableList =
    available.length === 0 ? "none" : available.map((id) => `"${id}"`).join(", ");

  return webhookError(
    "unknown_webhook_provider",
    `Unknown webhook provider "${provider}". Available providers: ${availableList}.`,
    { statusCode: 404 }
  );
}

function defineWebhookProviderRegistry<
  const Entry extends WebhookProviderRegistration
>(entries: readonly Entry[]): WebhookProviderRegistry<Entry> {
  const entryById = new Map<string, Entry>();
  const ids: string[] = [];

  for (const entry of entries) {
    if (entryById.has(entry.id)) {
      throw duplicateWebhookProvider(entry.id);
    }

    entryById.set(entry.id, entry);
    ids.push(entry.id);
  }

  const registry: WebhookProviderRegistry<Entry> = {
    get(id) {
      return entryById.get(id);
    },
    require(id) {
      const entry = entryById.get(id);
      if (entry === undefined) {
        throw unknownWebhookProviderError(id, registry);
      }

      return entry;
    },
    ids() {
      return [...ids];
    }
  };

  return registry;
}

export function defineWebhookProviderAdapters<
  const Adapter extends WebhookProviderAdapter
>(adapters: readonly Adapter[]): WebhookProviderRegistry<Adapter> {
  return defineWebhookProviderRegistry(adapters);
}

export function defineWebhookProviderAdapterFactories<
  const Factory extends WebhookProviderAdapterFactory
>(factories: readonly Factory[]): WebhookProviderRegistry<Factory> {
  return defineWebhookProviderRegistry(factories);
}
