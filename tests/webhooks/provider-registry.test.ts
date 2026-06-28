import { describe, expect, it } from "vitest";
import type {
  WebhookProviderAdapter,
  WebhookProviderAdapterFactory
} from "../../src/webhooks/contracts.js";
import {
  defineWebhookProviderAdapterFactories,
  defineWebhookProviderAdapters,
  unknownWebhookProviderError
} from "../../src/webhooks/provider-registry.js";

function adapter(id: string): WebhookProviderAdapter {
  return {
    id,
    description: `${id} adapter`,
    verify() {},
    normalize() {
      return {
        kind: "ignored",
        deliveryId: `${id}-delivery`,
        reason: "test"
      };
    }
  };
}

function factory(id: string): WebhookProviderAdapterFactory {
  return {
    id,
    description: `${id} factory`,
    create() {
      return adapter(id);
    }
  };
}

describe("webhook provider registry", () => {
  it("rejects duplicate runtime provider ids", () => {
    expect(() =>
      defineWebhookProviderAdapters([adapter("github"), adapter("github")])
    ).toThrowErrorMatchingInlineSnapshot(
      `[WebhookError: Duplicate webhook provider id: github]`
    );
  });

  it("rejects duplicate provider factory ids", () => {
    expect(() =>
      defineWebhookProviderAdapterFactories([factory("plane"), factory("plane")])
    ).toThrowErrorMatchingInlineSnapshot(
      `[WebhookError: Duplicate webhook provider id: plane]`
    );
  });

  it("require missing throws with available provider ids", () => {
    const registry = defineWebhookProviderAdapterFactories([
      factory("github"),
      factory("plane")
    ]);

    expect(() => registry.require("missing")).toThrow(
      'Unknown webhook provider "missing". Available providers: "github", "plane".'
    );
  });

  it("unknown provider errors include code and available provider ids", () => {
    const registry = defineWebhookProviderAdapterFactories([factory("github")]);

    expect(unknownWebhookProviderError("missing", registry)).toMatchObject({
      code: "unknown_webhook_provider",
      statusCode: 404,
      message: 'Unknown webhook provider "missing". Available providers: "github".'
    });
  });

  it("ids returns a copy", () => {
    const registry = defineWebhookProviderAdapterFactories([
      factory("github"),
      factory("plane")
    ]);
    const ids = registry.ids();

    ids.push("extra");

    expect(registry.ids()).toEqual(["github", "plane"]);
  });
});
