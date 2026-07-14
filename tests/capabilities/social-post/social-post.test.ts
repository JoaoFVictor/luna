import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createSocialPostPrepareBuiltIn,
  createSocialPostPublishBuiltIn,
  socialPostApplyRevisionScopeBuiltIn
} from "../../../src/capabilities/social-post/built-ins.js";
import {
  SOCIAL_POST_HARD_MAX_CLAIM_LENGTH,
  SOCIAL_POST_HARD_MAX_CLAIMS,
  SOCIAL_POST_HARD_MAX_IMAGE_BYTES,
  SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH,
  SocialPostDraftSchema,
  type SocialPostPreparedResult,
  type SocialPostProviderLimits,
  type SocialPostProviderPort,
  type SocialPostWorkflowInput
} from "../../../src/capabilities/social-post/contracts.js";
import { manifest as socialPostManifest } from "../../../src/capabilities/social-post/manifest.js";
import { artifactContentReadLimitError } from "../../../src/core/runtime/artifacts/content-read-error.js";

type DraftJsonSchema = {
  readonly properties: {
    readonly strategy: { readonly maxLength: number };
    readonly claims_to_verify: {
      readonly maxItems: number;
      readonly items: { readonly maxLength: number };
    };
  };
};

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "social-post", mode: "read_only" },
  steps: {}
};

const pngBytes = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));

const providerLimits = (maxBytes = 5 * 1024 * 1024): SocialPostProviderLimits => ({
  text: {
    policy_id: "test.weighted",
    policy_revision: "v1",
    max_weighted_length: 280
  },
  image: {
    max_bytes: maxBytes,
    media_types: ["image/png"],
    max_width: 8192,
    max_height: 8192,
    max_pixels: 64 * 1024 * 1024
  }
});

const validateText = (text: string) => ({
  valid: [...text].length <= 280,
  weighted_length: [...text].length,
  max_weighted_length: 280,
  policy_id: "test.weighted",
  policy_revision: "v1",
  message: "Test text policy"
});

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function createValidPublishFixture(text = "Post aprovado") {
  const limits = providerLimits();
  const textPolicy = validateText(text);
  if (!textPolicy.valid) {
    throw new Error("The valid publish fixture requires provider-valid text.");
  }
  const imageContentHash = sha256(pngBytes);
  const publishPost = vi.fn<SocialPostProviderPort["publishPost"]>(async (input) => ({
    operation_id: "social-post.publish",
    provider: "example",
    provider_id: "example",
    external_id: "post-1",
    url: "https://example.test/post-1",
    text: input.text,
    media_id: "media-1"
  }));
  const provider: SocialPostProviderPort = {
    provider_id: "example",
    limits,
    validateText,
    publishPost
  };
  const input = {
    operation_id: "social-post.publish",
    provider_id: "example",
    auth_instance: "default",
    text,
    image_asset: {
      id: "generated-images/image.png",
      uri: "artifact://run-1/generated-images/image.png",
      node_id: "image",
      media_type: "image/png",
      content_hash: imageContentHash,
      size_bytes: pngBytes.byteLength
    },
    preparation: {
      provider_id: "example",
      text_hash: sha256(text),
      image_content_hash: imageContentHash,
      validation: {
        valid: true,
        code: "ready",
        message: "Imagem validada e pronta para publicação.",
        image_size_bytes: pngBytes.byteLength,
        image_max_bytes: limits.image.max_bytes,
        image_media_type: "image/png",
        image_width: 1,
        image_height: 1,
        text_weighted_length: textPolicy.weighted_length,
        text_max_weighted_length: textPolicy.max_weighted_length,
        text_policy_id: textPolicy.policy_id,
        text_policy_revision: textPolicy.policy_revision
      }
    }
  } satisfies SocialPostWorkflowInput;
  const builtIn = createSocialPostPublishBuiltIn({
    projectRoot: "/trusted/repo",
    providers: { get: () => provider },
    artifacts: {
      read: vi.fn(async () => pngBytes),
      verify: vi.fn(async () => true)
    }
  });

  return { builtIn, input, publishPost };
}

type PreparationMutation = (
  preparation: SocialPostPreparedResult
) => SocialPostPreparedResult;

const attestationMismatchCases: ReadonlyArray<readonly [string, PreparationMutation]> = [
  ["text hash", (preparation) => ({
    ...preparation,
    text_hash: sha256("different text")
  })],
  ["image hash", (preparation) => ({
    ...preparation,
    image_content_hash: sha256(new Uint8Array([0]))
  })],
  ["text policy id", (preparation) => ({
    ...preparation,
    validation: { ...preparation.validation, text_policy_id: "different.policy" }
  })],
  ["text policy revision", (preparation) => ({
    ...preparation,
    validation: { ...preparation.validation, text_policy_revision: "v2" }
  })],
  ["text limit", (preparation) => ({
    ...preparation,
    validation: { ...preparation.validation, text_max_weighted_length: 281 }
  })],
  ["image limit", (preparation) => ({
    ...preparation,
    validation: { ...preparation.validation, image_max_bytes: 1024 }
  })],
  ["image dimensions", (preparation) => ({
    ...preparation,
    validation: { ...preparation.validation, image_width: 2 }
  })]
];

describe("social-post capability", () => {
  it("bounds model-authored strategy and verification claims", () => {
    const draft = {
      text: "Texto",
      image_prompt: "Prompt",
      strategy: "Estratégia",
      character_count: 5,
      claims_to_verify: ["Afirmação"]
    };
    expect(SocialPostDraftSchema.safeParse(draft).success).toBe(true);
    expect(SocialPostDraftSchema.safeParse({
      ...draft,
      strategy: "x".repeat(SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH + 1)
    }).success).toBe(false);
    expect(SocialPostDraftSchema.safeParse({
      ...draft,
      claims_to_verify: Array.from(
        { length: SOCIAL_POST_HARD_MAX_CLAIMS + 1 },
        () => "Afirmação"
      )
    }).success).toBe(false);
    expect(SocialPostDraftSchema.safeParse({
      ...draft,
      claims_to_verify: ["x".repeat(SOCIAL_POST_HARD_MAX_CLAIM_LENGTH + 1)]
    }).success).toBe(false);
  });

  it("keeps every public draft schema on the same metadata bounds", async () => {
    const agentSchema = JSON.parse(
      await readFile("agents/social-post-writer/output.schema.json", "utf8")
    ) as DraftJsonSchema;
    const workflowSchema = JSON.parse(
      await readFile("workflows/social-post/output.schema.json", "utf8")
    ) as { readonly definitions: { readonly draft: DraftJsonSchema } };
    const capabilitySchema = socialPostManifest.built_ins[
      "social-post.apply_revision_scope"
    ]?.output_schema as unknown as DraftJsonSchema;

    for (const schema of [agentSchema, workflowSchema.definitions.draft, capabilitySchema]) {
      expect(schema.properties.strategy.maxLength)
        .toBe(SOCIAL_POST_HARD_MAX_STRATEGY_LENGTH);
      expect(schema.properties.claims_to_verify.maxItems)
        .toBe(SOCIAL_POST_HARD_MAX_CLAIMS);
      expect(schema.properties.claims_to_verify.items.maxLength)
        .toBe(SOCIAL_POST_HARD_MAX_CLAIM_LENGTH);
    }
  });

  it("enforces revision targets even when the agent changes every field", async () => {
    const previous = {
      text: "Texto anterior byte-exato 🚀",
      image_prompt: "Prompt anterior byte-exato",
      strategy: "Estratégia anterior",
      character_count: 27,
      claims_to_verify: ["Afirmação anterior"]
    };
    const proposed = {
      text: "Texto adulterado pelo agente",
      image_prompt: "Prompt adulterado pelo agente",
      strategy: "Estratégia adulterada",
      character_count: 1,
      claims_to_verify: ["Afirmação adulterada"]
    };

    const apply = (targets: readonly ("text" | "image")[]) =>
      socialPostApplyRevisionScopeBuiltIn.run({
        state,
        input: { previous_draft: previous, proposed_draft: proposed, targets }
      });

    expect(apply(["image"])).toEqual({
      ...previous,
      image_prompt: proposed.image_prompt,
      character_count: [...previous.text].length
    });
    expect(apply(["text"])).toEqual({
      ...proposed,
      image_prompt: previous.image_prompt,
      character_count: [...proposed.text].length
    });
    expect(apply(["text", "image"])).toEqual({
      ...proposed,
      character_count: [...proposed.text].length
    });
  });

  it("rejects revision targets outside the public ownership contract", async () => {
    expect(() => socialPostApplyRevisionScopeBuiltIn.run({
      state,
      input: {
        previous_draft: null,
        proposed_draft: {
          text: "Texto",
          image_prompt: "Prompt",
          strategy: "Estratégia",
          character_count: 5,
          claims_to_verify: []
        },
        targets: ["everything"]
      }
    })).toThrow(expect.objectContaining({ code: "social_post_revision_scope_invalid" }));
  });

  it("injects the trusted project root and delegates to the selected provider", async () => {
    const fixture = createValidPublishFixture();

    await expect(fixture.builtIn.run({
      state,
      input: fixture.input
    })).resolves.toMatchObject({ external_id: "post-1" });

    expect(fixture.publishPost).toHaveBeenCalledWith({
      operation_id: "social-post.publish",
      provider_id: "example",
      auth_instance: "default",
      text: "Post aprovado",
      image_base64: Buffer.from(pngBytes).toString("base64"),
      image_media_type: "image/png",
      project_root: "/trusted/repo"
    });
  });

  it.each(attestationMismatchCases)(
    "rejects a changed %s attestation before publishing",
    async (_label, mutatePreparation) => {
      const fixture = createValidPublishFixture();

      await expect(fixture.builtIn.run({
        state,
        input: {
          ...fixture.input,
          preparation: mutatePreparation(fixture.input.preparation)
        }
      })).rejects.toMatchObject({ code: "social_post_preparation_mismatch" });
      expect(fixture.publishPost).not.toHaveBeenCalled();
    }
  );

  it("validates an immutable image against provider limits before human review", async () => {
    const imageBytes = pngBytes;
    const contentHash = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`;
    const provider: SocialPostProviderPort = {
      provider_id: "example",
      limits: providerLimits(1024),
      validateText,
      publishPost: vi.fn()
    };
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: { get: () => provider },
      artifacts: {
        read: vi.fn(async () => imageBytes),
        verify: vi.fn(async () => true)
      }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "Post validado",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: contentHash,
          size_bytes: imageBytes.byteLength
        }
      }
    })).resolves.toEqual({
      provider_id: "example",
      text_hash: `sha256:${createHash("sha256").update("Post validado", "utf8").digest("hex")}`,
      image_content_hash: contentHash,
      validation: {
        valid: true,
        code: "ready",
        message: "Texto (13/280) e imagem PNG 1×1 validados para example.",
        text_weighted_length: 13,
        text_max_weighted_length: 280,
        text_policy_id: "test.weighted",
        text_policy_revision: "v1",
        image_size_bytes: imageBytes.byteLength,
        image_max_bytes: 1024,
        image_media_type: "image/png",
        image_width: 1,
        image_height: 1
      }
    });
    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("returns an oversized-image diagnostic without reading or publishing it", async () => {
    const read = vi.fn();
    const publishPost = vi.fn();
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: {
        get: () => ({
          provider_id: "example",
          limits: providerLimits(8),
          validateText,
          publishPost
        })
      },
      artifacts: { read, verify: vi.fn(async () => true) }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "Post",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size_bytes: 9
        }
      }
    })).resolves.toMatchObject({
      validation: {
        valid: false,
        code: "image_too_large",
        image_size_bytes: 9,
        image_max_bytes: 8
      }
    });
    expect(read).not.toHaveBeenCalled();
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("requires an authoritative committed manifest before reading the asset", async () => {
    const read = vi.fn();
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: {
        get: () => ({
          provider_id: "example",
          limits: providerLimits(),
          validateText,
          publishPost: vi.fn()
        })
      },
      artifacts: { read, verify: vi.fn(async () => false) }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "Post",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "forged-owner",
          media_type: "image/png",
          content_hash: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
          size_bytes: pngBytes.byteLength
        }
      }
    })).resolves.toMatchObject({ validation: { valid: false, code: "image_invalid" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a lying small ref bounded when stored content is oversized", async () => {
    const read = vi.fn(async (_ref, options?: { readonly max_bytes?: number }) => {
      expect(options?.max_bytes).toBe(1024);
      throw artifactContentReadLimitError();
    });
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: {
        get: () => ({
          provider_id: "example",
          limits: providerLimits(1024),
          validateText,
          publishPost: vi.fn()
        })
      },
      artifacts: { read, verify: vi.fn(async () => true) }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "Post",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
          size_bytes: pngBytes.byteLength
        }
      }
    })).resolves.toMatchObject({
      validation: { valid: false, code: "image_too_large" }
    });
  });

  it("blocks provider-weighted text before review without reading the image", async () => {
    const read = vi.fn();
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: {
        get: () => ({
          provider_id: "example",
          limits: providerLimits(),
          validateText: (text) => ({
            ...validateText(text),
            valid: false,
            weighted_length: 281,
            message: "Solicite um texto menor."
          }),
          publishPost: vi.fn()
        })
      },
      artifacts: { read, verify: vi.fn(async () => true) }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "URL longa ou Unicode ponderado",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
          size_bytes: pngBytes.byteLength
        }
      }
    })).resolves.toMatchObject({
      validation: {
        valid: false,
        code: "text_invalid",
        text_weighted_length: 281
      }
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects provider limits above the 25 MiB capability safety ceiling", async () => {
    const prepare = createSocialPostPrepareBuiltIn({
      projectRoot: "/repo",
      providers: {
        get: () => ({
          provider_id: "example",
          limits: {
            text: providerLimits().text,
            image: {
              max_bytes: SOCIAL_POST_HARD_MAX_IMAGE_BYTES + 1,
              media_types: ["image/png"],
              max_width: 8192,
              max_height: 8192,
              max_pixels: 64 * 1024 * 1024
            }
          },
          validateText,
          publishPost: vi.fn()
        })
      },
      artifacts: { read: vi.fn(), verify: vi.fn() }
    });

    await expect(prepare.run({
      state,
      input: {
        provider_id: "example",
        text: "Post",
        image_asset: {
          id: "generated-images/image.png",
          uri: "artifact://run-1/generated-images/image.png",
          node_id: "image",
          media_type: "image/png",
          content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size_bytes: 8
        }
      }
    })).rejects.toMatchObject({ code: "social_post_provider_contract_invalid" });
  });

  it("rejects posts longer than the configured platform limit", async () => {
    const fixture = createValidPublishFixture("a".repeat(280));

    await expect(fixture.builtIn.run({
      state,
      input: {
        ...fixture.input,
        text: `${fixture.input.text}a`
      }
    })).rejects.toMatchObject({ code: "social_post_preparation_invalid" });
    expect(fixture.publishPost).not.toHaveBeenCalled();
  });
});
