import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type { ArtifactManifest } from "../../../core/runtime/artifacts/contracts.js";
import {
  artifactManifestKeyFromManifest
} from "../../../core/runtime/artifacts/contracts.js";
import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import type { ArtifactManifestHandle } from "../../contracts/artifacts.js";

const HANDLE_DOMAIN = "luna-studio:artifact-manifest-handle:v1\0";

export type ArtifactHandleCodec = {
  readonly encode: (manifest: ArtifactManifest) => ArtifactManifestHandle;
  readonly matches: (
    handle: ArtifactManifestHandle,
    manifest: ArtifactManifest
  ) => boolean;
};

export function createArtifactHandleKey(): Buffer {
  return randomBytes(32);
}
export function createArtifactHandleCodec(
  key: Uint8Array = createArtifactHandleKey()
): ArtifactHandleCodec {
  if (key.byteLength < 32) {
    throw new Error("Artifact handle key must contain at least 32 bytes");
  }
  const secret = Buffer.from(key);

  function encode(manifest: ArtifactManifest): ArtifactManifestHandle {
    const identity = artifactManifestKeyFromManifest(manifest);
    const digest = createHmac("sha256", secret)
      .update(HANDLE_DOMAIN, "utf8")
      .update(canonicalJson(identity), "utf8")
      .digest("base64url");
    return `ah_${digest}`;
  }

  return {
    encode,
    matches(handle, manifest) {
      const candidate = encode(manifest);
      const suppliedBytes = Buffer.from(handle, "ascii");
      const candidateBytes = Buffer.from(candidate, "ascii");
      return suppliedBytes.length === candidateBytes.length &&
        timingSafeEqual(suppliedBytes, candidateBytes);
    }
  };
}
