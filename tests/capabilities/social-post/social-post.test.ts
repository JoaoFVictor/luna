import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createSocialPostPublishBuiltIn
} from "../../../src/capabilities/social-post/built-ins.js";
import type { SocialPostProviderPort } from "../../../src/capabilities/social-post/contracts.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "social-post", mode: "read_only" },
  steps: {}
};

describe("social-post capability", () => {
  it("injects the trusted project root and delegates to the selected provider", async () => {
    const provider: SocialPostProviderPort = {
      provider_id: "example",
      publishPost: vi.fn<SocialPostProviderPort["publishPost"]>(async (input) => ({
        operation_id: "social-post.publish",
        provider: "example",
        provider_id: "example",
        external_id: "post-1",
        url: "https://example.test/post-1",
        text: input.text,
        media_id: "media-1"
      }))
    };
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const builtIn = createSocialPostPublishBuiltIn({
      projectRoot: "/trusted/repo",
      providers: { get: () => provider },
      artifacts: { read: vi.fn(async () => imageBytes) }
    });

    await expect(builtIn.run({
      state,
      input: {
        provider_id: "example",
        auth_instance: "default",
        text: "Post aprovado",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size_bytes: imageBytes.byteLength
        }
      }
    })).resolves.toMatchObject({ external_id: "post-1" });

    expect(provider.publishPost).toHaveBeenCalledWith({
      operation_id: "social-post.publish",
      provider_id: "example",
      auth_instance: "default",
      text: "Post aprovado",
      image_base64: Buffer.from(imageBytes).toString("base64"),
      image_media_type: "image/png",
      project_root: "/trusted/repo"
    });
  });

  it("rejects posts longer than the configured platform limit", async () => {
    const builtIn = createSocialPostPublishBuiltIn({
      projectRoot: "/repo",
      providers: { get: vi.fn() },
      artifacts: { read: vi.fn() }
    });

    await expect(builtIn.run({
      state,
      input: {
        provider_id: "x",
        auth_instance: "default",
        text: "a".repeat(281),
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size_bytes: 8
        }
      }
    })).rejects.toMatchObject({ code: "social_post_input_invalid" });
  });
});
