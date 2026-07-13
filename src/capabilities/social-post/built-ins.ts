import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isArtifactContentReadLimitError } from "../../core/runtime/artifacts/content-read-error.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import {
  SOCIAL_POST_HARD_MAX_IMAGE_BYTES,
  SocialPostApplyRevisionScopeInputSchema,
  SocialPostDraftSchema,
  SocialPostPrepareInputSchema,
  SocialPostPreparedResultSchema,
  SocialPostProviderLimitsSchema,
  SocialPostPublishInputSchema,
  SocialPostTextPolicyResultSchema,
  SocialPostWorkflowInputSchema,
  type SocialPostBuiltInPorts,
  type SocialPostPrepareInput,
  type SocialPostPreparedResult,
  type SocialPostProviderPort
} from "./contracts.js";
import { validatePngStructure } from "./png-validation.js";

function unicodeCharacterCount(value: string): number {
  return [...value].length;
}

/**
 * Enforces the human-selected revision boundary independently of the model.
 * The text target owns text plus its supporting metadata; the image target
 * owns only the generation prompt. Generated assets remain owned by the
 * conditional image node in the workflow.
 */
export const socialPostApplyRevisionScopeBuiltIn = defineBuiltInStep({
  name: "social-post.apply_revision_scope",
  run(options) {
    const parsed = SocialPostApplyRevisionScopeInputSchema.safeParse({
      proposed_draft: options.input?.proposed_draft,
      previous_draft: options.input?.previous_draft,
      targets: options.input?.targets
    });
    if (!parsed.success) {
      throw socialPostError(
        "Social post revision did not match the deterministic scope schema.",
        "social_post_revision_scope_invalid"
      );
    }

    const { proposed_draft: proposed, previous_draft: previous } = parsed.data;
    const targets = new Set(parsed.data.targets);
    const textOwner = previous !== null && previous !== undefined && !targets.has("text")
      ? previous
      : proposed;
    const imageOwner = previous !== null && previous !== undefined && !targets.has("image")
      ? previous
      : proposed;

    return SocialPostDraftSchema.parse({
      text: textOwner.text,
      image_prompt: imageOwner.image_prompt,
      strategy: textOwner.strategy,
      character_count: unicodeCharacterCount(textOwner.text),
      claims_to_verify: textOwner.claims_to_verify
    });
  }
});

export type SocialPostBuiltInPortResolver =
  | SocialPostBuiltInPorts
  | ((options: BuiltInStepRunOptions) => SocialPostBuiltInPorts);

type SocialPostBuiltInDependencies = BuiltInStepDependencies & {
  readonly socialPost?: SocialPostBuiltInPorts;
};

function socialPostError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}


export function socialPostPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions<SocialPostBuiltInDependencies>): SocialPostBuiltInPorts {
  if (dependencies.socialPost === undefined) {
    throw socialPostError(
      "Social post ports are not configured for this runtime.",
      "social_post_port_unavailable"
    );
  }

  return dependencies.socialPost;
}

async function validatePreparedContent(
  input: SocialPostPrepareInput,
  provider: SocialPostProviderPort,
  artifacts: SocialPostBuiltInPorts["artifacts"]
): Promise<{
  readonly prepared: SocialPostPreparedResult;
  readonly bytes?: Uint8Array;
}> {
  const limits = SocialPostProviderLimitsSchema.safeParse(provider.limits);
  if (!limits.success) {
    throw socialPostError(
      `Social post provider ${provider.provider_id} declared invalid media limits.`,
      "social_post_provider_contract_invalid"
    );
  }
  if (provider.provider_id !== input.provider_id) {
    throw socialPostError(
      "Social post registry returned a provider with a mismatched identity.",
      "social_post_provider_contract_invalid"
    );
  }

  const imageLimits = limits.data.image;
  const textPolicy = SocialPostTextPolicyResultSchema.safeParse(
    provider.validateText(input.text)
  );
  if (
    !textPolicy.success ||
    textPolicy.data.policy_id !== limits.data.text.policy_id ||
    textPolicy.data.policy_revision !== limits.data.text.policy_revision ||
    textPolicy.data.max_weighted_length !== limits.data.text.max_weighted_length
  ) {
    throw socialPostError(
      `Social post provider ${provider.provider_id} returned an invalid text policy attestation.`,
      "social_post_provider_contract_invalid"
    );
  }
  const validationBase = {
    text_weighted_length: textPolicy.data.weighted_length,
    text_max_weighted_length: textPolicy.data.max_weighted_length,
    text_policy_id: textPolicy.data.policy_id,
    text_policy_revision: textPolicy.data.policy_revision,
    image_size_bytes: input.image_asset.size_bytes,
    image_max_bytes: imageLimits.max_bytes,
    image_media_type: input.image_asset.media_type,
    image_width: 0,
    image_height: 0
  } as const;
  if (!textPolicy.data.valid) {
    return invalidPreparation({
      input,
      code: "text_invalid",
      message: textPolicy.data.message,
      validationBase
    });
  }
  if (!imageLimits.media_types.includes(input.image_asset.media_type)) {
    return invalidPreparation({
      input,
      code: "image_invalid",
      message: `Provider ${provider.provider_id} does not accept ${input.image_asset.media_type} images.`,
      validationBase
    });
  }
  if (
    input.image_asset.size_bytes > SOCIAL_POST_HARD_MAX_IMAGE_BYTES ||
    input.image_asset.size_bytes > imageLimits.max_bytes
  ) {
    return invalidPreparation({
      input,
      code: "image_too_large",
      message: `A imagem tem ${input.image_asset.size_bytes} bytes e excede o limite de ${imageLimits.max_bytes} bytes do provider ${provider.provider_id}. Solicite uma nova imagem menor.`,
      validationBase
    });
  }

  if (
    artifacts.verify === undefined ||
    !(await artifacts.verify(input.image_asset))
  ) {
    return invalidPreparation({
      input,
      code: "image_invalid",
      message: "A referência da imagem não corresponde a um artifact committed deste run. Solicite a regeneração da imagem.",
      validationBase
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await artifacts.read(input.image_asset, {
      max_bytes: Math.min(SOCIAL_POST_HARD_MAX_IMAGE_BYTES, imageLimits.max_bytes)
    });
  } catch (cause) {
    if (isArtifactContentReadLimitError(cause)) {
      return invalidPreparation({
        input,
        code: "image_too_large",
        message: `O conteúdo da imagem excede o limite bounded de ${imageLimits.max_bytes} bytes do provider ${provider.provider_id}. Solicite uma nova imagem menor.`,
        validationBase
      });
    }
    throw cause;
  }
  if (
    bytes.byteLength > SOCIAL_POST_HARD_MAX_IMAGE_BYTES ||
    bytes.byteLength > imageLimits.max_bytes
  ) {
    return invalidPreparation({
      input,
      code: "image_too_large",
      message: `A imagem tem ${bytes.byteLength} bytes e excede o limite de ${imageLimits.max_bytes} bytes do provider ${provider.provider_id}. Solicite uma nova imagem menor.`,
      validationBase: { ...validationBase, image_size_bytes: bytes.byteLength },
      bytes
    });
  }
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (
    bytes.byteLength !== input.image_asset.size_bytes ||
    contentHash !== input.image_asset.content_hash
  ) {
    return invalidPreparation({
      input,
      code: "image_invalid",
      message: "A imagem não é um asset PNG íntegro. Solicite a regeneração da imagem.",
      validationBase: { ...validationBase, image_size_bytes: bytes.byteLength },
      bytes
    });
  }
  const png = await validatePngStructure(bytes, imageLimits);
  if (!png.valid) {
    return invalidPreparation({
      input,
      code: "image_invalid",
      message: "A imagem PNG está truncada, corrompida ou fora dos limites de dimensão do provider. Solicite a regeneração da imagem.",
      validationBase: {
        ...validationBase,
        image_size_bytes: bytes.byteLength,
        image_width: png.width,
        image_height: png.height
      },
      bytes
    });
  }

  return {
    prepared: SocialPostPreparedResultSchema.parse({
      provider_id: input.provider_id,
      text_hash: `sha256:${createHash("sha256").update(input.text, "utf8").digest("hex")}`,
      image_content_hash: contentHash,
      validation: {
        valid: true,
        code: "ready",
        ...validationBase,
        image_size_bytes: bytes.byteLength,
        image_width: png.width,
        image_height: png.height,
        message: `Texto (${textPolicy.data.weighted_length}/${textPolicy.data.max_weighted_length}) e imagem PNG ${png.width}×${png.height} validados para ${provider.provider_id}.`
      }
    }),
    bytes
  };
}

function invalidPreparation({
  input,
  code,
  message,
  validationBase,
  bytes
}: {
  readonly input: SocialPostPrepareInput;
  readonly code: "text_invalid" | "image_too_large" | "image_invalid";
  readonly message: string;
  readonly validationBase: Omit<
    import("./contracts.js").SocialPostPreparedResult["validation"],
    "valid" | "code" | "message"
  >;
  readonly bytes?: Uint8Array;
}): {
  readonly prepared: SocialPostPreparedResult;
  readonly bytes?: Uint8Array;
} {
  const contentHash = bytes === undefined
    ? input.image_asset.content_hash
    : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    prepared: SocialPostPreparedResultSchema.parse({
      provider_id: input.provider_id,
      text_hash: `sha256:${createHash("sha256").update(input.text, "utf8").digest("hex")}`,
      image_content_hash: contentHash,
      validation: {
        valid: false,
        code,
        message,
        ...validationBase
      }
    }),
    ...(bytes === undefined ? {} : { bytes })
  };
}

export function createSocialPostPrepareBuiltIn(
  ports: SocialPostBuiltInPortResolver
): BuiltInStep<"social-post.prepare"> {
  return defineBuiltInStep({
    name: "social-post.prepare",
    async run(options) {
      const resolvedPorts = typeof ports === "function" ? ports(options) : ports;
      const parsed = SocialPostPrepareInputSchema.safeParse({
        provider_id: options.input?.provider_id,
        text: options.input?.text,
        image_asset: options.input?.image_asset
      });
      if (!parsed.success) {
        throw socialPostError(
          "Social post input did not match the preparation schema.",
          "social_post_input_invalid"
        );
      }
      const provider = resolvedPorts.providers.get(parsed.data.provider_id);
      return (await validatePreparedContent(
        parsed.data,
        provider,
        resolvedPorts.artifacts
      )).prepared;
    }
  });
}

export function createSocialPostPublishBuiltIn(
  ports: SocialPostBuiltInPortResolver
): BuiltInStep<"social-post.publish"> {
  return defineBuiltInStep({
    name: "social-post.publish",
    async run(options) {
      const resolvedPorts = typeof ports === "function" ? ports(options) : ports;
      const parsed = SocialPostWorkflowInputSchema.safeParse({
        operation_id: options.input?.operation_id ?? "social-post.publish",
        provider_id: options.input?.provider_id,
        auth_instance: options.input?.auth_instance,
        text: options.input?.text,
        image_asset: options.input?.image_asset,
        preparation: options.input?.preparation
      });

      if (!parsed.success) {
        throw socialPostError(
          "Social post input did not match the publish schema.",
          "social_post_input_invalid"
        );
      }

      if (!parsed.data.preparation.validation.valid) {
        throw socialPostError(
          "Social post cannot be published from an invalid preparation.",
          "social_post_preparation_invalid"
        );
      }

      const provider = resolvedPorts.providers.get(parsed.data.provider_id);
      const { prepared, bytes } = await validatePreparedContent(
        {
          provider_id: parsed.data.provider_id,
          text: parsed.data.text,
          image_asset: parsed.data.image_asset
        },
        provider,
        resolvedPorts.artifacts
      );
      if (!prepared.validation.valid || bytes === undefined) {
        throw socialPostError(
          "Social post content is no longer valid for the selected provider.",
          "social_post_preparation_invalid"
        );
      }
      if (
        parsed.data.preparation.provider_id !== prepared.provider_id ||
        parsed.data.preparation.text_hash !== prepared.text_hash ||
        parsed.data.preparation.image_content_hash !== prepared.image_content_hash ||
        parsed.data.preparation.validation.image_size_bytes !==
          prepared.validation.image_size_bytes ||
        parsed.data.preparation.validation.image_max_bytes !==
          prepared.validation.image_max_bytes ||
        parsed.data.preparation.validation.image_media_type !==
          prepared.validation.image_media_type ||
        parsed.data.preparation.validation.image_width !==
          prepared.validation.image_width ||
        parsed.data.preparation.validation.image_height !==
          prepared.validation.image_height ||
        parsed.data.preparation.validation.text_weighted_length !==
          prepared.validation.text_weighted_length ||
        parsed.data.preparation.validation.text_max_weighted_length !==
          prepared.validation.text_max_weighted_length ||
        parsed.data.preparation.validation.text_policy_id !==
          prepared.validation.text_policy_id ||
        parsed.data.preparation.validation.text_policy_revision !==
          prepared.validation.text_policy_revision ||
        parsed.data.preparation.validation.valid !== prepared.validation.valid ||
        parsed.data.preparation.validation.code !== prepared.validation.code
      ) {
        throw socialPostError(
          "Social post content no longer matches its pre-review preparation.",
          "social_post_preparation_mismatch"
        );
      }
      const input = SocialPostPublishInputSchema.parse({
        operation_id: parsed.data.operation_id,
        provider_id: prepared.provider_id,
        auth_instance: parsed.data.auth_instance,
        text: parsed.data.text,
        image_base64: Buffer.from(bytes).toString("base64"),
        image_media_type: parsed.data.image_asset.media_type,
        project_root: resolvedPorts.projectRoot
      });
      return await provider.publishPost(input);
    }
  });
}
