import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Canonical digest for opaque Studio secrets retained or persisted by hash.
 * The prefix is part of the Studio digest contract.
 */
export function studioSecretDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function studioDigestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}
