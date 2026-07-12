import { createHash } from "node:crypto";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import { studioSecretDigest } from "../confirmations/digests.js";

export function studioApplyBytesDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function studioApplyValueDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export function studioApplySecretDigest(value: string): string {
  return studioSecretDigest(value);
}
