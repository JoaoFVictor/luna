import type { InputAdapterRegistry } from "../../../adapters/registry.js";
import type {
  AdapterInput,
  RegisteredInputAdapter
} from "../../../adapters/types.js";
import {
  InvocationSchema,
  type Invocation
} from "../../../core/router/invocation.js";
import {
  StudioAdapterPreviewRequestSchema,
  StudioAdapterPreviewSchema,
  StudioInputAdapterCatalogSchema,
  StudioInputAdapterSummarySchema,
  StudioPublicInvocationSchema,
  type StudioAdapterPreview,
  type StudioInputAdapterCatalog,
  type StudioInputAdapterSummary,
  type StudioPublicInvocation
} from "../../contracts/input-routing.js";
import {
  denyStudioAdapterPreviews,
  sameStudioAdapterEffects,
  type StudioAdapterPreviewPort,
  type StudioAdapterPreviewer
} from "./adapter-preview-port.js";

type StudioAdapterRegistry = Pick<
  InputAdapterRegistry<RegisteredInputAdapter>,
  "ids" | "require"
>;

export type StudioAdapterPreviewErrorCode =
  | "studio_adapter_preview_aborted"
  | "studio_adapter_preview_disabled"
  | "studio_adapter_preview_effects_unacknowledged"
  | "studio_adapter_preview_failed"
  | "studio_adapter_preview_invalid_request"
  | "studio_adapter_preview_invalid_result"
  | "studio_adapter_preview_source_mismatch"
  | "studio_adapter_preview_timeout"
  | "studio_adapter_preview_unknown_adapter";

export class StudioAdapterPreviewError extends Error {
  readonly code: StudioAdapterPreviewErrorCode;

  constructor(
    code: StudioAdapterPreviewErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StudioAdapterPreviewError";
    this.code = code;
  }
}

function summarizeAdapter(
  adapter: RegisteredInputAdapter,
  previews: StudioAdapterPreviewPort
): StudioInputAdapterSummary {
  const preview = previews.get(adapter.id);

  return StudioInputAdapterSummarySchema.parse({
    id: adapter.id,
    description: adapter.description,
    source: adapter.source,
    input_contract: {
      kind: "cli",
      value_type: "string"
    },
    preview:
      preview === undefined
        ? { enabled: false }
        : {
            enabled: true,
            effects: preview.effects,
            timeout_ms: preview.timeoutMs
          }
  });
}

function publicInvocationProjection(invocation: Invocation): {
  readonly invocation: StudioPublicInvocation;
  readonly redactedFields: readonly ("references" | "payload")[];
} {
  const parsed = InvocationSchema.parse(invocation);
  const redactedFields: ("references" | "payload")[] = [];
  if (parsed.references !== undefined) {
    redactedFields.push("references");
  }
  if (parsed.payload !== undefined) {
    redactedFields.push("payload");
  }

  return {
    invocation: StudioPublicInvocationSchema.parse({
      version: parsed.version,
      source: parsed.source,
      event: parsed.event,
      ...(parsed.action === undefined ? {} : { action: parsed.action }),
      ...(parsed.target === undefined ? {} : { target: parsed.target }),
      ...(parsed.repository === undefined
        ? {}
        : { repository: parsed.repository }),
      ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
      ...(parsed.actor === undefined ? {} : { actor: parsed.actor })
    }),
    redactedFields
  };
}

function boundaryError(
  code: "studio_adapter_preview_aborted" | "studio_adapter_preview_timeout"
): StudioAdapterPreviewError {
  return code === "studio_adapter_preview_aborted"
    ? new StudioAdapterPreviewError(
        code,
        "Studio adapter preview was cancelled"
      )
    : new StudioAdapterPreviewError(
        code,
        "Studio adapter preview timed out"
      );
}

async function executePreview(
  previewer: StudioAdapterPreviewer,
  input: AdapterInput,
  inputSignal: AbortSignal | undefined
): Promise<Invocation> {
  if (inputSignal?.aborted === true) {
    throw boundaryError("studio_adapter_preview_aborted");
  }

  const operationController = new AbortController();
  let terminated = false;
  let rejectBoundary!: (error: StudioAdapterPreviewError) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const terminate = (
    code: "studio_adapter_preview_aborted" | "studio_adapter_preview_timeout"
  ) => {
    if (terminated) {
      return;
    }
    terminated = true;
    rejectBoundary(boundaryError(code));
    operationController.abort();
  };
  const abortFromInput = () => terminate("studio_adapter_preview_aborted");

  inputSignal?.addEventListener("abort", abortFromInput, { once: true });
  const timeout = setTimeout(
    () => terminate("studio_adapter_preview_timeout"),
    previewer.timeoutMs
  );
  let implementation: Promise<Invocation>;
  try {
    implementation = Promise.resolve(previewer.preview(input, {
      signal: operationController.signal
    }));
  } catch (cause) {
    implementation = Promise.reject(cause);
  }
  const operation = implementation
    .catch(() => {
      throw new StudioAdapterPreviewError(
        "studio_adapter_preview_failed",
        "Studio adapter preview failed"
      );
    });

  try {
    return await Promise.race([operation, boundary]);
  } finally {
    clearTimeout(timeout);
    inputSignal?.removeEventListener("abort", abortFromInput);
  }
}

export function listStudioInputAdapters(
  registry: StudioAdapterRegistry,
  previews: StudioAdapterPreviewPort = denyStudioAdapterPreviews
): StudioInputAdapterCatalog {
  const adapters = registry
    .ids()
    .sort((left, right) => left.localeCompare(right))
    .map((id) => summarizeAdapter(registry.require(id), previews));

  return StudioInputAdapterCatalogSchema.parse({ adapters });
}

export async function previewStudioInputAdapter(
  request: unknown,
  dependencies: {
    readonly registry: StudioAdapterRegistry;
    readonly previews?: StudioAdapterPreviewPort;
    readonly signal?: AbortSignal;
  }
): Promise<StudioAdapterPreview> {
  return (await resolveStudioInputAdapterPreview(request, dependencies)).preview;
}

export type StudioResolvedAdapterPreview = {
  readonly preview: StudioAdapterPreview;
  /** Private full invocation. Never serialize this application result. */
  readonly invocation: Invocation;
};

export async function resolveStudioInputAdapterPreview(
  request: unknown,
  dependencies: {
    readonly registry: StudioAdapterRegistry;
    readonly previews?: StudioAdapterPreviewPort;
    readonly signal?: AbortSignal;
  }
): Promise<StudioResolvedAdapterPreview> {
  const requestResult = StudioAdapterPreviewRequestSchema.safeParse(request);
  if (!requestResult.success) {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_invalid_request",
      "Studio adapter preview request is invalid"
    );
  }
  const parsed = requestResult.data;
  let adapter: RegisteredInputAdapter;
  try {
    adapter = dependencies.registry.require(parsed.adapter_id);
  } catch {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_unknown_adapter",
      "Studio adapter preview requested an unknown adapter"
    );
  }
  const preview = (dependencies.previews ?? denyStudioAdapterPreviews).get(
    parsed.adapter_id
  );
  if (preview === undefined) {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_disabled",
      "Studio preview is not enabled for the requested adapter"
    );
  }
  if (
    !sameStudioAdapterEffects(parsed.acknowledged_effects, preview.effects)
  ) {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_effects_unacknowledged",
      "Studio preview effects were not acknowledged"
    );
  }

  const invocation = await executePreview(
    preview,
    parsed.input,
    dependencies.signal
  );
  let projected: ReturnType<typeof publicInvocationProjection>;
  try {
    projected = publicInvocationProjection(invocation);
  } catch {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_invalid_result",
      "Studio adapter preview returned an invalid invocation"
    );
  }
  if (projected.invocation.source !== adapter.source) {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_source_mismatch",
      "Studio preview returned an unexpected registered source"
    );
  }
  const result = StudioAdapterPreviewSchema.safeParse({
    adapter_id: parsed.adapter_id,
    effects: preview.effects,
    invocation: projected.invocation,
    redacted_fields: projected.redactedFields
  });
  if (!result.success) {
    throw new StudioAdapterPreviewError(
      "studio_adapter_preview_invalid_result",
      "Studio adapter preview returned an invalid invocation"
    );
  }
  return Object.freeze({ preview: result.data, invocation });
}
