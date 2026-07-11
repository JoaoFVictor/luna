import { StudioApplyError } from "../../application/apply/errors.js";
import type {
  StudioApplyPlanRecord,
  StudioApplyPlanTokenPort,
  StudioStoredApplyPlan
} from "../../application/apply/ports.js";
import { StudioApplyPlanTokenSchema } from "../../contracts/apply.js";
import { MemoryOneShotTokenStore } from "./one-shot-token-store.js";

export type MemoryStudioApplyPlanTokensOptions = {
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly randomToken?: () => string;
};

export class MemoryStudioApplyPlanTokens
  implements StudioApplyPlanTokenPort
{
  readonly #store: MemoryOneShotTokenStore<StudioStoredApplyPlan>;

  constructor(options: MemoryStudioApplyPlanTokensOptions = {}) {
    this.#store = new MemoryOneShotTokenStore({
      subject: "Apply plan token",
      createError: (message, cause) => new StudioApplyError(
        "studio_apply_config_invalid",
        message,
        cause === undefined ? {} : { cause }
      ),
      parseToken: (token) => {
        const parsed = StudioApplyPlanTokenSchema.safeParse(token);
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
    plan: StudioStoredApplyPlan,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    return await this.#store.issue(plan, options);
  }

  async get(token: string): Promise<StudioApplyPlanRecord | undefined> {
    const record = await this.#store.read(token);
    return record === undefined
      ? undefined
      : {
          tokenDigest: record.tokenDigest,
          expiresAt: record.expiresAt,
          plan: record.binding
        };
  }
}
