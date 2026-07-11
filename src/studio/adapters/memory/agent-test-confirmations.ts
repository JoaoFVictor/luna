import { studioPlanConfirmationExpectationMatches } from "../../application/confirmations/plan-confirmation-authority.js";
import { studioAgentTestError } from "../../application/agents/test-bench-errors.js";
import type {
  StudioAgentTestConfirmationBinding,
  StudioAgentTestConfirmationPort,
  StudioAgentTestConfirmationRecord
} from "../../application/agents/test-bench-ports.js";
import { StudioAgentTestConfirmationTokenSchema } from "../../contracts/agent-test-bench.js";
import { MemoryOneShotTokenStore } from "./one-shot-token-store.js";

export type MemoryStudioAgentTestConfirmationsOptions = {
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
};

export class MemoryStudioAgentTestConfirmations
  implements StudioAgentTestConfirmationPort
{
  readonly #store: MemoryOneShotTokenStore<StudioAgentTestConfirmationBinding>;

  constructor(options: MemoryStudioAgentTestConfirmationsOptions = {}) {
    this.#store = new MemoryOneShotTokenStore({
      subject: "Agent test confirmation",
      createError: (message, cause) => studioAgentTestError(
        "studio_agent_test_config_invalid",
        message,
        {},
        cause === undefined ? {} : { cause }
      ),
      parseToken: (token) => {
        const parsed = StudioAgentTestConfirmationTokenSchema.safeParse(token);
        return parsed.success ? parsed.data : undefined;
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createToken === undefined
        ? {}
        : { createToken: options.createToken }),
      ...(options.maxEntries === undefined
        ? {}
        : { maxEntries: options.maxEntries }),
      ...(options.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: options.maxTotalBytes })
    });
  }

  async issue(
    binding: StudioAgentTestConfirmationBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    return await this.#store.issue(binding, options);
  }

  async consume(
    token: string,
    expectation: {
      readonly planId: string;
      readonly actorBindingDigest: string;
    }
  ): Promise<StudioAgentTestConfirmationRecord | undefined> {
    const record = await this.#store.consume(token, (binding) =>
      studioPlanConfirmationExpectationMatches(
        binding,
        expectation
      )
    );
    return record === undefined
      ? undefined
      : { binding: record.binding, expiresAt: record.expiresAt };
  }
}
