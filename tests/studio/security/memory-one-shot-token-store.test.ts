import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/workflow/definition-digests.js";
import { MemoryOneShotTokenStore } from "../../../src/studio/adapters/memory/one-shot-token-store.js";
import { studioSecretDigest } from "../../../src/studio/application/confirmations/digests.js";

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

class TestTokenError extends Error {}

function store(options: {
  readonly now: () => number;
  readonly tokens: string[];
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
}) {
  return new MemoryOneShotTokenStore<{ nested: { value: string } }>({
    subject: "Test token",
    createError: (message, cause) => new TestTokenError(message, { cause }),
    parseToken: (token) => token.length === 43 ? token : undefined,
    now: options.now,
    createToken: () => options.tokens.shift() ?? TOKEN_B,
    ...(options.maxEntries === undefined
      ? {}
      : { maxEntries: options.maxEntries }),
    ...(options.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxTotalBytes })
  });
}

function measuredBytes(
  token: string,
  expiresAt: number,
  binding: { nested: { value: string } }
): number {
  return Buffer.byteLength(canonicalJson({
    tokenDigest: studioSecretDigest(token),
    expiresAt,
    binding
  }), "utf8");
}

describe("MemoryOneShotTokenStore", () => {
  it("defensively reads and consumes a matching authority exactly once", async () => {
    const binding = { nested: { value: "original" } };
    const tokens = store({ now: () => 1_000, tokens: [TOKEN_A] });
    const issued = await tokens.issue(binding, { ttlMs: 500 });
    binding.nested.value = "changed-before-read";

    const read = await tokens.read(issued.token);
    expect(read).toEqual({
      tokenDigest: studioSecretDigest(TOKEN_A),
      expiresAt: 1_500,
      binding: { nested: { value: "original" } }
    });
    if (read !== undefined) read.binding.nested.value = "changed-after-read";
    await expect(tokens.read(issued.token)).resolves.toMatchObject({
      binding: { nested: { value: "original" } }
    });

    await expect(tokens.consume(issued.token, () => false))
      .resolves.toBeUndefined();
    await expect(tokens.consume(issued.token, () => true))
      .resolves.toMatchObject({ binding: { nested: { value: "original" } } });
    await expect(tokens.consume(issued.token)).resolves.toBeUndefined();
  });

  it("expires at the exact boundary and releases entry capacity", async () => {
    let now = 1_000;
    const binding = { nested: { value: "bounded" } };
    const tokens = store({
      now: () => now,
      tokens: [TOKEN_A, TOKEN_B],
      maxEntries: 1
    });
    await tokens.issue(binding, { ttlMs: 500 });
    await expect(tokens.issue(binding, { ttlMs: 500 }))
      .rejects.toBeInstanceOf(TestTokenError);

    now = 1_500;
    await expect(tokens.read(TOKEN_A)).resolves.toBeUndefined();
    await expect(tokens.issue(binding, { ttlMs: 500 }))
      .resolves.toEqual({ token: TOKEN_B, expiresAt: 2_000 });
  });

  it("accounts canonical bytes and releases aggregate quota on consume", async () => {
    const first = { nested: { value: "first" } };
    const second = { nested: { value: "second" } };
    const tokens = store({
      now: () => 1_000,
      tokens: [TOKEN_A, TOKEN_B],
      maxEntries: 2,
      maxTotalBytes: Math.max(
        measuredBytes(TOKEN_A, 1_500, first),
        measuredBytes(TOKEN_B, 1_500, second)
      )
    });
    const issued = await tokens.issue(first, { ttlMs: 500 });

    await expect(tokens.issue(second, { ttlMs: 500 }))
      .rejects.toBeInstanceOf(TestTokenError);
    await expect(tokens.consume(issued.token)).resolves.toBeDefined();
    await expect(tokens.issue(second, { ttlMs: 500 }))
      .resolves.toEqual({ token: TOKEN_B, expiresAt: 1_500 });
  });

  it("rejects a record larger than the configured byte quota", async () => {
    const binding = { nested: { value: "oversized" } };
    const tokens = store({
      now: () => 1_000,
      tokens: [TOKEN_A],
      maxTotalBytes: measuredBytes(TOKEN_A, 1_500, binding) - 1
    });

    await expect(tokens.issue(binding, { ttlMs: 500 }))
      .rejects.toBeInstanceOf(TestTokenError);
  });

  it("serializes concurrent issues against aggregate capacity", async () => {
    const binding = { nested: { value: "bounded" } };
    const tokens = store({
      now: () => 1_000,
      tokens: [TOKEN_A, TOKEN_B],
      maxEntries: 2,
      maxTotalBytes: measuredBytes(TOKEN_A, 1_500, binding)
    });

    const attempts = await Promise.allSettled([
      tokens.issue(binding, { ttlMs: 500 }),
      tokens.issue(binding, { ttlMs: 500 })
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled"))
      .toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected"))
      .toHaveLength(1);
  });

  it("prunes expired records before applying the byte quota", async () => {
    let now = 1_000;
    const binding = { nested: { value: "bounded" } };
    const tokens = store({
      now: () => now,
      tokens: [TOKEN_A, TOKEN_B],
      maxEntries: 2,
      maxTotalBytes: measuredBytes(TOKEN_A, 1_500, binding)
    });
    await tokens.issue(binding, { ttlMs: 500 });
    await expect(tokens.issue(binding, { ttlMs: 500 }))
      .rejects.toBeInstanceOf(TestTokenError);

    now = 1_500;
    await expect(tokens.issue(binding, { ttlMs: 500 }))
      .resolves.toEqual({ token: TOKEN_B, expiresAt: 2_000 });
  });

  it("rejects invalid capacities, generation, TTL, clocks, and expiry", async () => {
    expect(() => store({
      now: () => 1_000,
      tokens: [TOKEN_A],
      maxEntries: 0
    })).toThrow(TestTokenError);
    expect(() => store({
      now: () => 1_000,
      tokens: [TOKEN_A],
      maxTotalBytes: 0
    })).toThrow(TestTokenError);

    await expect(store({ now: () => 1_000, tokens: ["short"] })
      .issue({ nested: { value: "x" } }, { ttlMs: 500 }))
      .rejects.toBeInstanceOf(TestTokenError);
    await expect(store({ now: () => 1_000, tokens: [TOKEN_A] })
      .issue({ nested: { value: "x" } }, { ttlMs: 0 }))
      .rejects.toBeInstanceOf(TestTokenError);
    await expect(store({ now: () => -1, tokens: [TOKEN_A] })
      .read(TOKEN_A))
      .rejects.toBeInstanceOf(TestTokenError);
    await expect(store({
      now: () => Number.MAX_SAFE_INTEGER,
      tokens: [TOKEN_A]
    }).issue({ nested: { value: "x" } }, { ttlMs: 1 }))
      .rejects.toBeInstanceOf(TestTokenError);
  });

  it("rejects repeated token collisions after the bounded retry budget", async () => {
    const tokens = store({
      now: () => 1_000,
      tokens: Array.from({ length: 9 }, () => TOKEN_A),
      maxEntries: 2
    });
    await tokens.issue({ nested: { value: "first" } }, { ttlMs: 500 });

    await expect(tokens.issue(
      { nested: { value: "second" } },
      { ttlMs: 500 }
    )).rejects.toBeInstanceOf(TestTokenError);
  });
});
