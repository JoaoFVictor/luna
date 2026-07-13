import { Buffer } from "node:buffer";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import {
  SocialPostPublishInputSchema,
  SocialPostWorkflowInputSchema,
  type SocialPostBuiltInPorts
} from "./contracts.js";

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
        image_asset: options.input?.image_asset
      });

      if (!parsed.success) {
        throw socialPostError(
          "Social post input did not match the publish schema.",
          "social_post_input_invalid"
        );
      }

      const bytes = await resolvedPorts.artifacts.read(parsed.data.image_asset);
      const input = SocialPostPublishInputSchema.parse({
        operation_id: parsed.data.operation_id,
        provider_id: parsed.data.provider_id,
        auth_instance: parsed.data.auth_instance,
        text: parsed.data.text,
        image_base64: Buffer.from(bytes).toString("base64"),
        image_media_type: parsed.data.image_asset.media_type,
        project_root: resolvedPorts.projectRoot
      });
      return await resolvedPorts.providers.get(input.provider_id).publishPost(input);
    }
  });
}
