import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  studioDigestsEqual,
  studioSecretDigest
} from "../confirmations/digests.js";

export function studioAgentTestValueDigest(value: unknown): string {
  return sha256Digest(value);
}

export function studioAgentTestSecretDigest(value: string): string {
  return studioSecretDigest(value);
}

export function studioAgentTestDigestsEqual(
  left: string,
  right: string
): boolean {
  return studioDigestsEqual(left, right);
}
