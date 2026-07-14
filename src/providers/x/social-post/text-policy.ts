import type { SocialPostTextPolicyResult } from "../../../capabilities/social-post/contracts.js";
import twitterText from "twitter-text";

export const X_TEXT_POLICY_ID = "x.twitter-text.weighted-length";
export const X_TEXT_POLICY_REVISION = "twitter-text@3.1.0/config-v3";
export const X_MAX_WEIGHTED_LENGTH = 280;
export const X_TRANSFORMED_URL_LENGTH = 23;

export function xWeightedTextLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

export function validateXText(text: string): SocialPostTextPolicyResult {
  const parsed = twitterText.parseTweet(text);
  return {
    valid: parsed.valid,
    weighted_length: parsed.weightedLength,
    max_weighted_length: X_MAX_WEIGHTED_LENGTH,
    policy_id: X_TEXT_POLICY_ID,
    policy_revision: X_TEXT_POLICY_REVISION,
    message: parsed.valid
      ? `Texto válido para X (${parsed.weightedLength}/${X_MAX_WEIGHTED_LENGTH} ponderados).`
      : `O texto não satisfaz a política X: ${parsed.weightedLength}/${X_MAX_WEIGHTED_LENGTH} caracteres ponderados ou caractere inválido. Solicite uma versão compatível.`
  };
}
