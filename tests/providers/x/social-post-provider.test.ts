import { describe, expect, it, vi } from "vitest";
import type { SocialPostPublishInput } from "../../../src/capabilities/social-post/contracts.js";
import type { XRefreshableAuth } from "../../../src/providers/x/auth.js";
import { createXSocialPostProviderFactory } from "../../../src/providers/x/social-post/factory.js";
import {
  X_MAX_WEIGHTED_LENGTH,
  X_TEXT_POLICY_ID,
  X_TEXT_POLICY_REVISION
} from "../../../src/providers/x/social-post/text-policy.js";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const crcCorrectInvalidIdatBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAACElEQVRub3QtemxpYq351UYAAAAASUVORK5CYII=";

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

    expect(provider.limits).toEqual({
      text: {
        policy_id: X_TEXT_POLICY_ID,
        policy_revision: X_TEXT_POLICY_REVISION,
        max_weighted_length: X_MAX_WEIGHTED_LENGTH
      },
      image: {
        max_bytes: 5 * 1024 * 1024,
        media_types: ["image/png"],
        max_width: 8192,
        max_height: 8192,
        max_pixels: 64 * 1024 * 1024
      }
    });

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

  it("refreshes after a confirmed 401 and retries only the rejected operation", async () => {
    let auth: XRefreshableAuth = {
      auth_type: "oauth2_user_access_token",
      access_token: "expired-access",
      refresh_token: "refresh-token",
      client_id: "public-client"
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Unauthorized"
      }), { status: 401, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "rotated-refresh",
        expires_in: 7200
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "media-123" }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "123456", text: "Olá, X!" }
      }), { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch;
    const provider = createXSocialPostProviderFactory({
      fetch: fetchImpl,
      loadAuth: async () => ({ providers: { x: { default: auth } } }),
      persistAuth: async (_root, _instance, next) => {
        auth = next as XRefreshableAuth;
      },
      acquireRefreshLock: async () => async () => undefined,
      now: () => Date.parse("2026-07-13T20:00:00.000Z")
    }).createProvider();

    await expect(provider.publishPost(input)).resolves.toMatchObject({
      external_id: "123456",
      media_id: "media-123"
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.x.com/2/media/upload",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer expired-access" })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://api.x.com/2/media/upload",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer fresh-access" })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "https://api.x.com/2/tweets",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer fresh-access" })
      })
    );
    expect(auth).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh"
    });
  });

  it("does not upload media again when only post creation rejects an expired token", async () => {
    let auth: XRefreshableAuth = {
      auth_type: "oauth2_user_access_token",
      access_token: "expired-access",
      refresh_token: "refresh-token",
      client_id: "public-client"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "media-123" }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Unauthorized"
      }), { status: 401, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "fresh-access",
        expires_in: 7200
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "123456", text: "Olá, X!" }
      }), { status: 201, headers: { "content-type": "application/json" } }));
    const provider = createXSocialPostProviderFactory({
      fetch: fetchMock as typeof fetch,
      loadAuth: async () => ({ providers: { x: { default: auth } } }),
      persistAuth: async (_root, _instance, next) => {
        auth = next as XRefreshableAuth;
      },
      acquireRefreshLock: async () => async () => undefined,
      now: () => Date.parse("2026-07-13T20:00:00.000Z")
    }).createProvider();

    await expect(provider.publishPost(input)).resolves.toMatchObject({
      external_id: "123456",
      media_id: "media-123"
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.x.com/2/media/upload",
      "https://api.x.com/2/tweets",
      "https://api.x.com/2/oauth2/token",
      "https://api.x.com/2/tweets"
    ]);
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

  it("revalidates weighted text and structural PNG before any X request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = providerFor(fetchImpl);

    await expect(provider.publishPost({
      ...input,
      text: "漢".repeat(141)
    })).rejects.toMatchObject({ code: "social_post_publish_failed" });
    await expect(provider.publishPost({
      ...input,
      image_base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")
    })).rejects.toMatchObject({ code: "social_post_publish_failed" });
    await expect(provider.publishPost({
      ...input,
      image_base64: crcCorrectInvalidIdatBase64
    })).rejects.toMatchObject({ code: "social_post_publish_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
