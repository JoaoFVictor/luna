const URL_CANDIDATE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s'"`<>]+)/giu;
const MAX_QUERY_KEY_DECODE_PASSES = 4;
const SENSITIVE_QUERY_KEY_MARKERS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "auth",
  "apikey"
] as const;
const SENSITIVE_QUERY_KEYS = new Set(["sig"]);

function normalizedQueryKey(rawKey: string): string | undefined {
  let decoded = rawKey.replace(/\+/gu, " ");

  for (let pass = 0; pass < MAX_QUERY_KEY_DECODE_PASSES; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return undefined;
    }
    if (next === decoded) {
      return decoded
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "");
    }
    decoded = next;
  }

  // A key that remains encoded after the bounded decoding budget cannot be
  // proven safe. Treat it as sensitive rather than allowing an encoded bypass.
  return undefined;
}

function isSensitiveQueryKey(rawKey: string): boolean {
  const normalized = normalizedQueryKey(rawKey);
  if (normalized === undefined) {
    return true;
  }

  return normalized.startsWith("xamz") ||
    normalized.startsWith("xgoog") ||
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    SENSITIVE_QUERY_KEY_MARKERS.some((marker) =>
      normalized.includes(marker)
    );
}

function urlComponentContainsSensitiveKey(component: string): boolean {
  if (component === "") {
    return false;
  }

  return component.slice(1).split("&").some((parameter) => {
    const separator = parameter.indexOf("=");
    const rawKey = separator < 0 ? parameter : parameter.slice(0, separator);
    return rawKey !== "" && isSensitiveQueryKey(rawKey);
  });
}

function parsedUrl(value: string): URL | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function remoteUrlContainsCredentials(value: string): boolean {
  const parsed = parsedUrl(value);
  if (parsed === undefined) {
    return false;
  }
  if (parsed.password !== "") {
    return true;
  }
  if (
    parsed.username !== "" &&
    parsed.protocol !== "ssh:" &&
    parsed.protocol !== "git+ssh:"
  ) {
    return true;
  }
  return urlComponentContainsSensitiveKey(parsed.search) ||
    urlComponentContainsSensitiveKey(parsed.hash);
}

function redactSensitiveQueryValues(suffix: string): string {
  return suffix.replace(
    /([?#&])([^?&=#\s]+)(=)([^&#\s]*)/gu,
    (
      match,
      delimiter: string,
      rawKey: string,
      equals: string
    ) => isSensitiveQueryKey(rawKey)
      ? `${delimiter}${rawKey}${equals}[REDACTED]`
      : match
  );
}

function redactUrlCandidate(scheme: string, remainder: string): string {
  const authorityEnd = remainder.search(/[/?#]/u);
  const authority = authorityEnd < 0
    ? remainder
    : remainder.slice(0, authorityEnd);
  const suffix = authorityEnd < 0 ? "" : remainder.slice(authorityEnd);
  const userInfoEnd = authority.lastIndexOf("@");
  const safeAuthority = userInfoEnd < 0
    ? authority
    : `[REDACTED]@${authority.slice(userInfoEnd + 1)}`;
  const safeSuffix = redactSensitiveQueryValues(suffix);
  return `${scheme}${safeAuthority}${safeSuffix}`;
}

/** Removes URL userinfo and credential-bearing query values from arbitrary text. */
export function redactUrlCredentials(value: string): string {
  return value.replace(
    URL_CANDIDATE,
    (_match, scheme: string, remainder: string) =>
      redactUrlCandidate(scheme, remainder)
  );
}
