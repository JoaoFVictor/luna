import { describe, expect, it, vi } from "vitest";
import type { SocialPostPublishInput } from "../../../src/capabilities/social-post/contracts.js";
import { createXSocialPostProviderFactory } from "../../../src/providers/x/social-post/factory.js";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const input: SocialPostPublishInput = {
  operation_id: "social-post.publish",
  provider_id: "x",
  auth_instance: "default",
  text: "Olá, X!",
  image_base64: pngBase64,
  image_media_type: "image/png",
  project_root: "/repo"
};

function providerFor(fetchImpl: typeof fetch) {
  return createXSocialPostProviderFactory({
    fetch: fetchImpl,
    loadAuth: async () => ({
      providers: {
        x: {
          default: {
            auth_type: "oauth2_user_access_token",
            access_token: "user-token"
          }
        }
      }
    })
  }).createProvider();
}

describe("X social post provider", () => {
  it("publishes text with a user access token and returns the canonical result", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "media-123" }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "123456", text: "Olá, X!" }
      }), { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch;
    const provider = providerFor(fetchImpl);

    await expect(provider.publishPost(input)).resolves.toEqual({
      operation_id: "social-post.publish",
      provider: "x",
      provider_id: "x",
      external_id: "123456",
      url: "https://x.com/i/web/status/123456",
      text: "Olá, X!",
      media_id: "media-123"
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.x.com/2/media/upload", {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        media: pngBase64,
        media_category: "tweet_image",
        media_type: "image/png",
        shared: false
      })
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text: "Olá, X!",
        media: { media_ids: ["media-123"] }
      })
    });
  });

  it("classifies authorization rejections without exposing the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      title: "Unauthorized"
    }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;

    await expect(providerFor(fetchImpl).publishPost(input)).rejects.toMatchObject({
      code: "social_post_auth_failed",
      message: "X rejected the media upload: Unauthorized"
    });
  });

  it("marks transport failures as an unknown outcome so the post is not retried", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket closed");
    }) as unknown as typeof fetch;

    await expect(providerFor(fetchImpl).publishPost(input)).rejects.toMatchObject({
      code: "social_post_unknown_publish_outcome"
    });
  });

  it("maps missing configured credentials to an authentication failure", async () => {
    const provider = createXSocialPostProviderFactory({
      fetch: vi.fn() as unknown as typeof fetch,
      loadAuth: async () => ({ providers: {} })
    }).createProvider();

    await expect(provider.publishPost(input)).rejects.toMatchObject({
      code: "social_post_auth_failed"
    });
  });
});
