import { randomBytes } from "node:crypto";
import { StudioApplyError } from "../../application/apply/errors.js";
import { studioApplySecretDigest } from "../../application/apply/digests.js";
import type {
  StudioApplyPlanRecord,
  StudioApplyPlanTokenPort,
  StudioStoredApplyPlan
} from "../../application/apply/ports.js";

export type MemoryStudioApplyPlanTokensOptions = {
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly randomToken?: () => string;
};

export class MemoryStudioApplyPlanTokens
  implements StudioApplyPlanTokenPort
{
  private readonly records = new Map<string, StudioApplyPlanRecord>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly randomToken: () => string;

  constructor(options: MemoryStudioApplyPlanTokensOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 1_024;
    this.randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Apply plan token capacity must be a positive safe integer"
      );
    }
  }

  async issue(
    plan: StudioStoredApplyPlan,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Apply plan token TTL must be a positive safe integer"
      );
    }
    const now = this.currentTime();
    this.prune(now);
    if (this.records.size >= this.maxEntries) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Apply plan token capacity is exhausted"
      );
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.randomToken();
      if (token.length < 32 || token.length > 256) {
        throw new StudioApplyError(
          "studio_apply_config_invalid",
          "Apply plan token generator returned an invalid token"
        );
      }
      const tokenDigest = studioApplySecretDigest(token);
      if (this.records.has(tokenDigest)) {
        continue;
      }
      const expiresAt = now + options.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new StudioApplyError(
          "studio_apply_config_invalid",
          "Apply plan token expiry exceeds the safe clock range"
        );
      }
      this.records.set(tokenDigest, { tokenDigest, expiresAt, plan });
      return { token, expiresAt };
    }

    throw new StudioApplyError(
      "studio_apply_config_invalid",
      "Apply plan token generator produced repeated collisions"
    );
  }

  async get(token: string): Promise<StudioApplyPlanRecord | undefined> {
    const now = this.currentTime();
    this.prune(now);
    return this.records.get(studioApplySecretDigest(token));
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudioApplyError(
        "studio_apply_config_invalid",
        "Apply plan clock must return a non-negative safe integer"
      );
    }
    return value;
  }

  private prune(now: number): void {
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(digest);
      }
    }
  }
}
