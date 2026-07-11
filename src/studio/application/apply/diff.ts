import YAML from "yaml";
import {
  redactString,
  redactValue
} from "../../../core/security/redactor.js";
import type { StudioApplyFileDiff } from "../../contracts/apply.js";
import type { StudioPath } from "../../contracts/paths.js";
import { StudioApplyError } from "./errors.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const STRUCTURED_SOURCE_PATTERN = /\.(?:json|jsonc|ya?ml)$/iu;
const INVALID_STRUCTURED_SOURCE = "[REDACTED INVALID STRUCTURED SOURCE]\n";

function decodeUtf8(content: Uint8Array, file: StudioPath): string {
  try {
    return UTF8.decode(content);
  } catch (cause) {
    throw new StudioApplyError(
      "studio_apply_source_invalid",
      "Studio apply only supports valid UTF-8 source files",
      { cause, details: { file } }
    );
  }
}

function redactSource(source: string, file: StudioPath): string {
  if (!STRUCTURED_SOURCE_PATTERN.test(file.path)) {
    return redactString(source);
  }
  try {
    const lowerPath = file.path.toLowerCase();
    const jsonLike = lowerPath.endsWith(".json") || lowerPath.endsWith(".jsonc");
    const parsed = jsonLike
      ? JSON.parse(source)
      : YAML.parse(source);
    if (parsed === null || typeof parsed !== "object") {
      return INVALID_STRUCTURED_SOURCE;
    }
    const redacted = redactValue(parsed);
    return jsonLike
      ? `${JSON.stringify(redacted, null, 2)}\n`
      : YAML.stringify(redacted);
  } catch {
    // Invalid structured source is not echoed because a partial parser or
    // regex redactor cannot prove that nested/block secrets were removed.
    return INVALID_STRUCTURED_SOURCE;
  }
}

function prefixedLines(prefix: "-" | "+", source: string): string[] {
  if (source === "") {
    return [];
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => `${prefix}${line}\n`);
}

function lineCount(source: string): number {
  if (source === "") {
    return 0;
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

function appendWithinBudget(
  chunks: string[],
  value: string,
  remainingBytes: number
): { readonly remainingBytes: number; readonly complete: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= remainingBytes) {
    chunks.push(value);
    return { remainingBytes: remainingBytes - bytes, complete: true };
  }
  if (remainingBytes > 0) {
    const prefix = Buffer.from(value, "utf8").subarray(0, remainingBytes);
    chunks.push(prefix.toString("utf8").replace(/\uFFFD$/u, ""));
  }
  return { remainingBytes: 0, complete: false };
}

export function renderStudioApplyTextDiff(input: {
  readonly file: StudioPath;
  readonly before: Uint8Array | undefined;
  readonly after: Uint8Array | undefined;
  readonly maxBytes: number;
}): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new StudioApplyError(
      "studio_apply_config_invalid",
      "Text diff byte limit must be a non-negative safe integer"
    );
  }

  const before =
    input.before === undefined
      ? ""
      : redactSource(decodeUtf8(input.before, input.file), input.file);
  const after =
    input.after === undefined
      ? ""
      : redactSource(decodeUtf8(input.after, input.file), input.file);
  const beforeLines = lineCount(before);
  const afterLines = lineCount(after);
  const label = `${input.file.root}:${input.file.path}`;
  const chunks = [
    `--- ${input.before === undefined ? "/dev/null" : label}\n`,
    `+++ ${input.after === undefined ? "/dev/null" : label}\n`,
    `@@ -1,${beforeLines} +1,${afterLines} @@\n`,
    ...prefixedLines("-", before),
    ...prefixedLines("+", after)
  ];

  const bounded: string[] = [];
  let remaining = input.maxBytes;
  let truncated = false;
  for (const chunk of chunks) {
    const appended = appendWithinBudget(bounded, chunk, remaining);
    remaining = appended.remainingBytes;
    if (!appended.complete) {
      truncated = true;
      break;
    }
  }
  return { text: bounded.join(""), truncated };
}

export function projectStudioApplyDiff(input: {
  readonly file: StudioPath;
  readonly kind: StudioApplyFileDiff["kind"];
  readonly before: Uint8Array | undefined;
  readonly after: Uint8Array | undefined;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly beforeMode: number | null;
  readonly afterMode: number | null;
  readonly maxTextBytes: number;
}): StudioApplyFileDiff {
  const textual = renderStudioApplyTextDiff({
    file: input.file,
    before: input.before,
    after: input.after,
    maxBytes: input.maxTextBytes
  });
  return {
    file: input.file,
    kind: input.kind,
    before_sha256: input.beforeSha256,
    after_sha256: input.afterSha256,
    before_mode: input.beforeMode,
    after_mode: input.afterMode,
    textual_diff: textual.text,
    textual_diff_truncated: textual.truncated,
    redacted: true
  };
}
