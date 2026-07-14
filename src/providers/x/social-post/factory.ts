import { Buffer } from "node:buffer";
import type {
  SocialPostProviderFactory,
  SocialPostPublishedResult,
  SocialPostPublishInput
} from "../../../capabilities/social-post/contracts.js";
import { validatePngStructure } from "../../../capabilities/social-post/png-validation.js";
import { loadXAuth, type XLunaAuthConfig } from "../auth.js";
import {
  createXOAuth2TokenManager,
  type XOAuth2TokenManager,
  type XOAuth2TokenManagerOptions
} from "../oauth2-token-manager.js";
import {
  validateXText,
  X_MAX_WEIGHTED_LENGTH,
  X_TEXT_POLICY_ID,
  X_TEXT_POLICY_REVISION
} from "./text-policy.js";

type XApiResponse = {
  readonly data?: {
    readonly id?: unknown;
    readonly text?: unknown;
  };
  readonly detail?: unknown;
  readonly title?: unknown;
};

type XMediaUploadResponse = {
  readonly data?: { readonly id?: unknown };
  readonly detail?: unknown;
  readonly title?: unknown;
};

type XSocialPostErrorCode =
  | "social_post_auth_failed"
  | "social_post_provider_unavailable"
  | "social_post_publish_failed"
  | "social_post_unknown_publish_outcome";

type XSocialPostError = Error & {
  code: XSocialPostErrorCode;
  details?: unknown;
};

type Fetch = typeof fetch;
export const X_IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const X_IMAGE_MAX_DIMENSION = 8192;
export const X_IMAGE_MAX_PIXELS = 64 * 1024 * 1024;

function xSocialPostError(
  code: XSocialPostErrorCode,
  message: string,
  details?: unknown
): XSocialPostError {
  const error = new Error(message) as XSocialPostError;
  error.code = code;
  error.details = details;
  return error;
}

function errorCodeForStatus(status: number): XSocialPostErrorCode {
  if (status === 401 || status === 403) {
    return "social_post_auth_failed";
  }
  if (status === 429 || status >= 500) {
    return "social_post_provider_unavailable";
  }
  return "social_post_publish_failed";
}

async function responseBody(response: Response): Promise<XApiResponse> {
  try {
    return await response.json() as XApiResponse;
  } catch (cause) {
    if (response.ok) {
      throw xSocialPostError(
        "social_post_unknown_publish_outcome",
        "X accepted the request but returned an unreadable response.",
        cause
      );
    }
    return {};
  }
}

async function publishPost(
  input: SocialPostPublishInput,
  tokenManager: XOAuth2TokenManager,
  fetchImpl: Fetch
): Promise<SocialPostPublishedResult> {
  if (!validateXText(input.text).valid) {
    throw xSocialPostError(
      "social_post_publish_failed",
      "The approved text no longer satisfies the declared X weighted-length policy."
    );
  }
  const mediaId = await uploadImage(input, tokenManager, fetchImpl);
  const response = await authenticatedRequest(
    tokenManager,
    fetchImpl,
    "https://api.x.com/2/tweets",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        media: { media_ids: [mediaId] }
      })
    },
    "The X publish request ended without a confirmed response."
  );

  const body = await responseBody(response);
  if (!response.ok) {
    const providerMessage =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.title === "string"
          ? body.title
          : `HTTP ${response.status}`;
    throw xSocialPostError(
      errorCodeForStatus(response.status),
      `X rejected the post: ${providerMessage}`,
      { status: response.status }
    );
  }

  if (typeof body.data?.id !== "string" || typeof body.data.text !== "string") {
    throw xSocialPostError(
      "social_post_unknown_publish_outcome",
      "X returned success without a valid post id and text."
    );
  }

  return {
    operation_id: "social-post.publish",
    provider: "x",
    provider_id: "x",
    external_id: body.data.id,
    url: `https://x.com/i/web/status/${body.data.id}`,
    text: body.data.text,
    media_id: mediaId
  };
}

async function uploadImage(
  input: SocialPostPublishInput,
  tokenManager: XOAuth2TokenManager,
  fetchImpl: Fetch
): Promise<string> {
  const bytes = Buffer.from(input.image_base64, "base64");
  const png = await validatePngStructure(bytes, {
    max_width: X_IMAGE_MAX_DIMENSION,
    max_height: X_IMAGE_MAX_DIMENSION,
    max_pixels: X_IMAGE_MAX_PIXELS
  });
  if (bytes.length > X_IMAGE_UPLOAD_MAX_BYTES || !png.valid) {
    throw xSocialPostError(
      "social_post_publish_failed",
      "The approved image must be a valid PNG no larger than 5 MB."
    );
  }

  const response = await authenticatedRequest(
    tokenManager,
    fetchImpl,
    "https://api.x.com/2/media/upload",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        media: input.image_base64,
        media_category: "tweet_image",
        media_type: input.image_media_type,
        shared: false
      })
    },
    "The X media upload ended without a confirmed response."
  );

  let body: XMediaUploadResponse;
  try {
    body = await response.json() as XMediaUploadResponse;
  } catch (cause) {
    throw xSocialPostError(
      response.ok ? "social_post_unknown_publish_outcome" : errorCodeForStatus(response.status),
      "X returned an unreadable media upload response.",
      cause
    );
  }
  if (!response.ok) {
    const providerMessage = typeof body.detail === "string"
      ? body.detail
      : typeof body.title === "string"
        ? body.title
        : `HTTP ${response.status}`;
    throw xSocialPostError(
      errorCodeForStatus(response.status),
      `X rejected the media upload: ${providerMessage}`,
      { status: response.status }
    );
  }
  if (typeof body.data?.id !== "string") {
    throw xSocialPostError(
      "social_post_unknown_publish_outcome",
      "X returned success without a valid media id."
    );
  }
  return body.data.id;
}

async function authenticatedRequest(
  tokenManager: XOAuth2TokenManager,
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  unknownOutcomeMessage: string
): Promise<Response> {
  let accessToken: string;
  try {
    accessToken = await tokenManager.accessToken();
  } catch (cause) {
    throw xSocialPostError(
      "social_post_auth_failed",
      "X credentials are unavailable or could not be refreshed.",
      cause
    );
  }

  const send = async (token: string): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`
        }
      });
    } catch (cause) {
      throw xSocialPostError(
        "social_post_unknown_publish_outcome",
        unknownOutcomeMessage,
        cause
      );
    }
  };

  const response = await send(accessToken);
  if (response.status !== 401) {
    return response;
  }

  let refreshed: string | undefined;
  try {
    refreshed = await tokenManager.refreshAfterUnauthorized(accessToken);
  } catch (cause) {
    await discardResponseBody(response);
    throw xSocialPostError(
      "social_post_auth_failed",
      "X rejected the access token and automatic refresh failed.",
      cause
    );
  }
  if (refreshed === undefined) {
    return response;
  }
  await discardResponseBody(response);
  return await send(refreshed);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The confirmed 401 remains authoritative even if its body cannot close.
  }
}

export type XSocialPostProviderFactoryOptions = {
  readonly fetch?: Fetch;
  readonly loadAuth?: (projectRoot: string) => Promise<XLunaAuthConfig>;
  readonly persistAuth?: XOAuth2TokenManagerOptions["persistAuth"];
  readonly acquireRefreshLock?: XOAuth2TokenManagerOptions["acquireRefreshLock"];
  readonly now?: XOAuth2TokenManagerOptions["now"];
};

export function createXSocialPostProviderFactory({
  fetch: fetchImpl = globalThis.fetch,
  loadAuth = loadXAuth,
  persistAuth,
  acquireRefreshLock,
  now
}: XSocialPostProviderFactoryOptions = {}): SocialPostProviderFactory {
  return {
    provider_id: "x",
    createProvider() {
      return {
        provider_id: "x",
        limits: {
          text: {
            policy_id: X_TEXT_POLICY_ID,
            policy_revision: X_TEXT_POLICY_REVISION,
            max_weighted_length: X_MAX_WEIGHTED_LENGTH
          },
          image: {
            max_bytes: X_IMAGE_UPLOAD_MAX_BYTES,
            media_types: ["image/png"],
            max_width: X_IMAGE_MAX_DIMENSION,
            max_height: X_IMAGE_MAX_DIMENSION,
            max_pixels: X_IMAGE_MAX_PIXELS
          }
        },
        validateText: validateXText,
        async publishPost(input) {
          const tokenManager = createXOAuth2TokenManager({
            projectRoot: input.project_root,
            instanceId: input.auth_instance,
            fetch: fetchImpl,
            loadAuth,
            ...(persistAuth === undefined ? {} : { persistAuth }),
            ...(acquireRefreshLock === undefined ? {} : { acquireRefreshLock }),
            ...(now === undefined ? {} : { now })
          });
          return await publishPost(input, tokenManager, fetchImpl);
        }
      };
    }
  };
}
