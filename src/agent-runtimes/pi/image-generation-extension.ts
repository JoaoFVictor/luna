import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type {
  GeneratedImagePayload,
  ImageGenerationExecutionOptions,
  ImageGenerationProviderFactory
} from "../../capabilities/image-generation/contracts.js";
import { validateGeneratedPngBase64 } from "../../capabilities/image-generation/png-payload.js";
import { piAuthPath } from "./auth.js";

const PI_IMAGEGEN_ID = "pi-imagegen";
const IMAGE_MODEL = "gpt-image-2";

type ImagegenDetails = {
  readonly imageModel: string;
  readonly revisedPrompt?: string;
  readonly savedPath: string;
};

type ImagegenToolResult = {
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly details?: unknown;
};

export type PiImagegenExtensionDependencies = {
  readonly createSession?: (projectRoot: string) => Promise<PiImagegenSession>;
};

type PiImagegenSession = {
  readonly extensionRunner: {
    createContext(): Parameters<ToolDefinition["execute"]>[4];
  };
  getToolDefinition(name: string): ToolDefinition | undefined;
  dispose(): void;
};

function imageGenerationError(
  code: string,
  message: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: string;
  };
  error.code = code;
  return error;
}

function isImagegenDetails(value: unknown): value is ImagegenDetails {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const details = value as Record<string, unknown>;
  return (
    typeof details.imageModel === "string" &&
    typeof details.savedPath === "string" &&
    (details.revisedPrompt === undefined || typeof details.revisedPrompt === "string")
  );
}

function assertExecutionOptions(options: ImageGenerationExecutionOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw imageGenerationError(
      "image_generation_config_invalid",
      "pi-imagegen timeoutMs must be a positive safe integer"
    );
  }
  if (!Number.isSafeInteger(options.maxImageBytes) || options.maxImageBytes < 8) {
    throw imageGenerationError(
      "image_generation_config_invalid",
      "pi-imagegen maxImageBytes must be a safe integer of at least 8"
    );
  }
}

async function executeWithControls<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ImageGenerationExecutionOptions
): Promise<T> {
  assertExecutionOptions(options);
  if (options.signal?.aborted === true) {
    throw imageGenerationError(
      "image_generation_aborted",
      "pi-imagegen was cancelled before execution"
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(imageGenerationError(
      timedOut ? "image_generation_timeout" : "image_generation_aborted",
      timedOut
        ? `pi-imagegen exceeded its ${options.timeoutMs}ms timeout`
        : "pi-imagegen was cancelled"
    )), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function createPiImagegenSession(
  projectRoot: string
): Promise<PiImagegenSession> {
  const extensionPath = createRequire(import.meta.url).resolve("pi-imagegen/imagegen.ts");
  const isolatedRoot = path.dirname(extensionPath);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: isolatedRoot,
    agentDir: isolatedRoot,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length > 0) {
    throw imageGenerationError(
      "image_generation_extension_unavailable",
      `Could not load ${PI_IMAGEGEN_ID}: ${extensions.errors.map(({ error }) => error).join("; ")}`
    );
  }

  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: isolatedRoot,
    authStorage: AuthStorage.create(piAuthPath(projectRoot)),
    resourceLoader,
    sessionManager: SessionManager.inMemory(projectRoot),
    settingsManager,
    tools: ["imagegen"]
  });
  return session;
}

export function createPiImagegenProviderFactory(
  dependencies: PiImagegenExtensionDependencies = {}
): ImageGenerationProviderFactory {
  const createSession = dependencies.createSession ?? createPiImagegenSession;

  return {
    provider_id: PI_IMAGEGEN_ID,
    createProvider() {
      return {
        provider_id: PI_IMAGEGEN_ID,
        async generateImage(
          input,
          options
        ): Promise<GeneratedImagePayload> {
          assertExecutionOptions(options);
          if (options.signal?.aborted === true) {
            throw imageGenerationError(
              "image_generation_aborted",
              `${PI_IMAGEGEN_ID} was cancelled before session creation`
            );
          }
          const session = await createSession(input.project_root);
          const tool = session.getToolDefinition("imagegen");
          if (tool === undefined) {
            session.dispose();
            throw imageGenerationError(
              "image_generation_extension_unavailable",
              `${PI_IMAGEGEN_ID} did not register the imagegen tool`
            );
          }
          let stagingDirectory: string | undefined;
          let result: ImagegenToolResult;
          try {
            stagingDirectory = await mkdtemp(
              path.join(tmpdir(), "luna-pi-imagegen-")
            );
            const outputPath = path.join(stagingDirectory, "image.png");
            result = await executeWithControls(async (signal) =>
              await tool.execute(
                `luna-${randomUUID()}`,
                {
                  prompt: input.prompt,
                  size: input.size,
                  quality: input.quality,
                  outputFormat: "png",
                  outputPath
                },
                signal,
                undefined,
                session.extensionRunner.createContext()
              ) as ImagegenToolResult,
            options);
          } catch (cause) {
            if (
              cause instanceof Error &&
              "code" in cause &&
              (cause.code === "image_generation_timeout" ||
                cause.code === "image_generation_aborted" ||
                cause.code === "image_generation_config_invalid")
            ) {
              throw cause;
            }
            const message = cause instanceof Error ? cause.message : String(cause);
            throw imageGenerationError(
              message.includes("OAuth credentials")
                ? "image_generation_auth_failed"
                : "image_generation_failed",
              `${PI_IMAGEGEN_ID} failed: ${message}`,
              cause
            );
          } finally {
            session.dispose();
            if (stagingDirectory !== undefined) {
              await rm(stagingDirectory, { recursive: true, force: true });
            }
          }

          const image = result.content.find((item) => item.type === "image");
          if (
            image?.type !== "image" ||
            image.mimeType !== "image/png" ||
            !validateGeneratedPngBase64(image.data, options.maxImageBytes).valid
          ) {
            const validation = image?.type === "image"
              ? validateGeneratedPngBase64(image.data, options.maxImageBytes)
              : undefined;
            throw imageGenerationError(
              validation?.valid === false && validation.reason === "oversized"
                ? "image_generation_payload_too_large"
                : "image_generation_failed",
              validation?.valid === false && validation.reason === "oversized"
                ? `${PI_IMAGEGEN_ID} returned an oversized image payload`
                : `${PI_IMAGEGEN_ID} returned no PNG image`
            );
          }
          if (!isImagegenDetails(result.details)) {
            throw imageGenerationError(
              "image_generation_failed",
              `${PI_IMAGEGEN_ID} returned invalid image metadata`
            );
          }

          const revisedPrompt = result.details.revisedPrompt;
          return {
            operation_id: "image-generation.generate",
            provider: PI_IMAGEGEN_ID,
            provider_id: PI_IMAGEGEN_ID,
            model: result.details.imageModel || IMAGE_MODEL,
            prompt: input.prompt,
            ...(revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt }),
            size: input.size,
            quality: input.quality,
            media_type: "image/png",
            image_base64: image.data,
            metadata: {
              provider: PI_IMAGEGEN_ID,
              model: result.details.imageModel || IMAGE_MODEL,
              prompt: input.prompt,
              ...(revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt }),
              size: input.size,
              quality: input.quality,
              media_type: "image/png"
            }
          };
        }
      };
    }
  };
}
