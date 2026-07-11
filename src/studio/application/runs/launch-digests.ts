import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  studioDigestsEqual,
  studioSecretDigest
} from "../confirmations/digests.js";

export function studioRunValueDigest(value: unknown): string {
  return sha256Digest(value);
}

export function studioRunSecretDigest(value: string): string {
  return studioSecretDigest(value);
}

export function studioRunDigestsEqual(left: string, right: string): boolean {
  return studioDigestsEqual(left, right);
}
