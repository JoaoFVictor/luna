import type { InputAdapterRegistry } from "../../../adapters/registry.js";
import type {
  AdapterInput,
  RegisteredInputAdapter
} from "../../../adapters/types.js";
import type { Invocation } from "../../../core/router/invocation.js";
import {
  StudioAdapterPreviewEffectsSchema,
  StudioAdapterPreviewTimeoutMsSchema,
  type StudioAdapterPreviewEffect
} from "../../contracts/input-routing.js";

type RegisteredAdapterRegistry = Pick<
  InputAdapterRegistry<RegisteredInputAdapter>,
  "require"
>;

export type StudioAdapterPreviewRegistration = {
  readonly adapterId: string;
  readonly effects: readonly StudioAdapterPreviewEffect[];
  readonly timeoutMs: number;
  readonly preview: (
    input: AdapterInput,
    context: { readonly signal: AbortSignal }
  ) => Promise<Invocation>;
};

export type StudioAdapterPreviewer = {
  readonly effects: readonly StudioAdapterPreviewEffect[];
  readonly timeoutMs: number;
  readonly preview: StudioAdapterPreviewRegistration["preview"];
};

export type StudioAdapterPreviewPort = {
  get(adapterId: string): StudioAdapterPreviewer | undefined;
};

export type StudioAdapterPreviewRegistrationErrorCode =
  | "studio_adapter_preview_duplicate"
  | "studio_adapter_preview_effect_mismatch"
  | "studio_adapter_preview_invalid_effects"
  | "studio_adapter_preview_invalid_timeout";

export class StudioAdapterPreviewRegistrationError extends Error {
  readonly code: StudioAdapterPreviewRegistrationErrorCode;

  constructor(
    code: StudioAdapterPreviewRegistrationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StudioAdapterPreviewRegistrationError";
    this.code = code;
  }
}

export const denyStudioAdapterPreviews: StudioAdapterPreviewPort = Object.freeze({
  get() {
    return undefined;
  }
});

function validatedEffects(
  adapterId: string,
  effects: readonly StudioAdapterPreviewEffect[]
): readonly StudioAdapterPreviewEffect[] {
  const parsed = StudioAdapterPreviewEffectsSchema.safeParse(effects);
  if (!parsed.success) {
    throw new StudioAdapterPreviewRegistrationError(
      "studio_adapter_preview_invalid_effects",
      `Studio adapter preview ${adapterId} has an invalid effect classification`
    );
  }

  return Object.freeze([...parsed.data].sort());
}

function validatedTimeout(timeoutMs: number): number {
  const parsed = StudioAdapterPreviewTimeoutMsSchema.safeParse(timeoutMs);
  if (!parsed.success) {
    throw new StudioAdapterPreviewRegistrationError(
      "studio_adapter_preview_invalid_timeout",
      "Studio adapter preview timeout must be a positive supported safe integer"
    );
  }
  return parsed.data;
}

export function sameStudioAdapterEffects(
  acknowledged: readonly StudioAdapterPreviewEffect[],
  classified: readonly StudioAdapterPreviewEffect[]
): boolean {
  const acknowledgedSorted = [...acknowledged].sort();
  const classifiedSorted = [...classified].sort();
  return (
    acknowledgedSorted.length === classifiedSorted.length &&
    acknowledgedSorted.every(
      (effect, index) => effect === classifiedSorted[index]
    )
  );
}

export function defineStudioAdapterPreviewPort(
  registry: RegisteredAdapterRegistry,
  registrations: readonly StudioAdapterPreviewRegistration[]
): StudioAdapterPreviewPort {
  const previews = new Map<string, StudioAdapterPreviewer>();

  for (const registration of registrations) {
    const adapter = registry.require(registration.adapterId);
    if (previews.has(registration.adapterId)) {
      throw new StudioAdapterPreviewRegistrationError(
        "studio_adapter_preview_duplicate",
        `Duplicate Studio adapter preview registration: ${registration.adapterId}`
      );
    }

    const effects = validatedEffects(
      registration.adapterId,
      registration.effects
    );
    if (
      adapter.loadEffects === undefined ||
      !sameStudioAdapterEffects(effects, adapter.loadEffects)
    ) {
      throw new StudioAdapterPreviewRegistrationError(
        "studio_adapter_preview_effect_mismatch",
        `Studio adapter preview ${registration.adapterId} must classify the registered adapter load exactly`
      );
    }

    previews.set(
      registration.adapterId,
      Object.freeze({
        effects,
        timeoutMs: validatedTimeout(registration.timeoutMs),
        preview: registration.preview
      })
    );
  }

  return Object.freeze({
    get(adapterId: string) {
      return previews.get(adapterId);
    }
  });
}
