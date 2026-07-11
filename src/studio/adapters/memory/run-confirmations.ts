import { studioPlanConfirmationExpectationMatches } from "../../application/confirmations/plan-confirmation-authority.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type {
  StudioRunConfirmationBinding,
  StudioRunConfirmationConsumeExpectation,
  StudioRunConfirmationPort,
  StudioRunConfirmationRecord
} from "../../application/runs/launch-ports.js";
import { StudioRunConfirmationTokenSchema } from "../../contracts/run-launch.js";
import { MemoryOneShotTokenStore } from "./one-shot-token-store.js";

export type MemoryStudioRunConfirmationsOptions = {
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly randomToken?: () => string;
};

export class MemoryStudioRunConfirmations
  implements StudioRunConfirmationPort
{
  readonly #store: MemoryOneShotTokenStore<StudioRunConfirmationBinding>;

  constructor(options: MemoryStudioRunConfirmationsOptions = {}) {
    this.#store = new MemoryOneShotTokenStore({
      subject: "Run confirmation",
      createError: (message, cause) => studioRunLaunchError(
        "studio_run_launch_config_invalid",
        message,
        {},
        cause === undefined ? undefined : { cause }
      ),
      parseToken: (token) => {
        const parsed = StudioRunConfirmationTokenSchema.safeParse(token);
        return parsed.success ? parsed.data : undefined;
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxEntries === undefined
        ? {}
        : { maxEntries: options.maxEntries }),
      ...(options.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: options.maxTotalBytes }),
      ...(options.randomToken === undefined
        ? {}
        : { createToken: options.randomToken })
    });
  }

  async issue(
    binding: StudioRunConfirmationBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    return await this.#store.issue(binding, options);
  }

  async consume(
    token: string,
    expected: StudioRunConfirmationConsumeExpectation
  ): Promise<StudioRunConfirmationRecord | undefined> {
    return await this.#store.consume(token, (binding) =>
      studioPlanConfirmationExpectationMatches(binding, expected)
    );
  }
}
