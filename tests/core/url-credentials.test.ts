import { describe, expect, it } from "vitest";
import {
  redactUrlCredentials,
  remoteUrlContainsCredentials
} from "../../src/core/security/url-credentials.js";

describe("URL credential security", () => {
  it("detects and redacts every AWS signed-URL parameter", () => {
    const url = "https://bucket.s3.amazonaws.com/object" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAEXAMPLE%2F20260711%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260711T120000Z" +
      "&X-Amz-Expires=300" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=abcdef0123456789" +
      "&response-content-type=text%2Fplain";

    expect(remoteUrlContainsCredentials(url)).toBe(true);
    expect(redactUrlCredentials(url)).toBe(
      "https://bucket.s3.amazonaws.com/object" +
      "?X-Amz-Algorithm=[REDACTED]" +
      "&X-Amz-Credential=[REDACTED]" +
      "&X-Amz-Date=[REDACTED]" +
      "&X-Amz-Expires=[REDACTED]" +
      "&X-Amz-SignedHeaders=[REDACTED]" +
      "&X-Amz-Signature=[REDACTED]" +
      "&response-content-type=text%2Fplain"
    );
  });

  it("detects and redacts every GCS signed-URL parameter", () => {
    const url = "https://storage.googleapis.com/bucket/object" +
      "?X-Goog-Algorithm=GOOG4-RSA-SHA256" +
      "&X-Goog-Credential=service%40example.test%2F20260711%2Fauto%2Fstorage%2Fgoog4_request" +
      "&X-Goog-Date=20260711T120000Z" +
      "&X-Goog-Expires=900" +
      "&X-Goog-SignedHeaders=host" +
      "&X-Goog-Signature=abcdef0123456789" +
      "&generation=123";

    expect(remoteUrlContainsCredentials(url)).toBe(true);
    expect(redactUrlCredentials(url)).toBe(
      "https://storage.googleapis.com/bucket/object" +
      "?X-Goog-Algorithm=[REDACTED]" +
      "&X-Goog-Credential=[REDACTED]" +
      "&X-Goog-Date=[REDACTED]" +
      "&X-Goog-Expires=[REDACTED]" +
      "&X-Goog-SignedHeaders=[REDACTED]" +
      "&X-Goog-Signature=[REDACTED]" +
      "&generation=123"
    );
  });

  it.each([
    "api%2Dkey",
    "api%252Dkey",
    "%58%2D%41%6D%7A%2D%53%69%67%6E%61%74%75%72%65",
    "safe%ZZ"
  ])("fails closed for encoded query key %s", (rawKey) => {
    const url = `https://example.test/object?${rawKey}=sensitive&view=summary`;

    expect(remoteUrlContainsCredentials(url)).toBe(true);
    expect(redactUrlCredentials(url)).toBe(
      `https://example.test/object?${rawKey}=[REDACTED]&view=summary`
    );
  });

  it("preserves non-sensitive query parameters byte for byte", () => {
    const url = "https://example.test/object?view=summary&ref=main&page=2";

    expect(remoteUrlContainsCredentials(url)).toBe(false);
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it("detects and redacts the exact Azure SAS sig parameter", () => {
    const url = "https://account.blob.core.windows.net/container/object" +
      "?sv=2025-11-05&se=2026-07-11T12%3A00Z&sp=r&sig=supersecret";

    expect(remoteUrlContainsCredentials(url)).toBe(true);
    expect(redactUrlCredentials(url)).toBe(
      "https://account.blob.core.windows.net/container/object" +
      "?sv=2025-11-05&se=2026-07-11T12%3A00Z&sp=r&sig=[REDACTED]"
    );
    expect(remoteUrlContainsCredentials(
      "https://example.test/object?signal=green"
    )).toBe(false);
  });

  it("detects and redacts credentials carried in a URL fragment", () => {
    const url = "https://example.test/callback#access_token=secret&state=safe";

    expect(remoteUrlContainsCredentials(url)).toBe(true);
    expect(redactUrlCredentials(url)).toBe(
      "https://example.test/callback#access_token=[REDACTED]&state=safe"
    );
  });
});
