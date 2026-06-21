const REDACTED = "[REDACTED]";

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function isSecretKey(key: string): boolean {
  const words = keyWords(key);

  if (words.includes("count")) {
    return false;
  }

  if (words.includes("secret") || words.includes("password")) {
    return true;
  }

  if (words.includes("authorization")) {
    return true;
  }

  if (words.includes("token")) {
    return true;
  }

  return words.includes("key") && words.some((word) => word !== "key");
}

function isExtraSensitiveKey(
  key: string,
  extraSensitiveKeys: readonly string[]
): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "");

  return extraSensitiveKeys.some((sensitiveKey) => {
    const normalizedSensitiveKey = sensitiveKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");

    return (
      normalizedKey === normalizedSensitiveKey ||
      normalizedKey.endsWith(normalizedSensitiveKey)
    );
  });
}

export function redactString(value: string): string {
  return value
    .replace(
      /(\bAuthorization:\s*Bearer\s+)([^\s'"`]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /(\bAuthorization:\s*Basic\s+)([^\s'"`]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
      REDACTED
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(
      /(^|\n)([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*=)([^\r\n]*)/gi,
      (_match, lineStart: string, key: string) => `${lineStart}${key}${REDACTED}`
    )
    .replace(
      /(^|\n)(\s*(?:[-*]\s*)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*:\s*)([^\r\n]*)/g,
      (
        match: string,
        lineStart: string,
        prefix: string,
        key: string,
        separator: string
      ) =>
        key.toLowerCase() !== "authorization" && isSecretKey(key)
          ? `${lineStart}${prefix}${key}${separator}${REDACTED}`
          : match
    );
}

export function redactValue(
  value: unknown,
  options: { extraSensitiveKeys?: readonly string[] } = {}
): unknown {
  const extraSensitiveKeys = options.extraSensitiveKeys ?? [];

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = isSecretKey(key) || isExtraSensitiveKey(key, extraSensitiveKeys)
        ? REDACTED
        : redactValue(nestedValue, options);
    }

    return redacted;
  }

  return value;
}
