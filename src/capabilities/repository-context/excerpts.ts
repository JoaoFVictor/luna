import type { RightSideRange } from "../../core/repository/diff-hunks.js";
import type { RelatedContextFile } from "./contracts.js";
import { truncateUtf8 } from "./file-analysis.js";
export type { RightSideRange as FocusRange } from "../../core/repository/diff-hunks.js";

export function excerptFrom(
  content: string,
  maxBytes: number,
  truncated: boolean,
  focusRanges: readonly RightSideRange[] = []
): RelatedContextFile["excerpt"] {
  if (focusRanges.length > 0) {
    return focusedExcerptFrom(content, maxBytes, truncated, focusRanges);
  }

  const excerpt = truncateUtf8(content, maxBytes);
  return {
    start_line: 1,
    end_line: Math.max(1, excerpt.split("\n").length),
    content: excerpt,
    ...((truncated || excerpt.length < content.length) ? { truncated: true } : {})
  };
}

function focusedExcerptFrom(
  content: string,
  maxBytes: number,
  truncated: boolean,
  focusRanges: readonly RightSideRange[]
): RelatedContextFile["excerpt"] {
  const lines = content.split("\n");
  const chunks = mergeFocusRanges(focusRanges, lines.length, 8);
  const output: string[] = [];
  let bytes = 0;
  let omitted = false;

  for (const [index, chunk] of chunks.entries()) {
    const chunkLines = lines.slice(chunk.line_start - 1, chunk.line_end);
    const prefix = index === 0 ? [] : ["[... omitted lines ...]"];
    const candidate = [...prefix, ...chunkLines].join("\n");
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    const separatorBytes = output.length === 0 ? 0 : 1;
    if (bytes + separatorBytes + candidateBytes > maxBytes) {
      omitted = true;
      break;
    }
    output.push(candidate);
    bytes += separatorBytes + candidateBytes;
  }

  if (output.length === 0) {
    const first = chunks[0] ?? { line_start: 1, line_end: Math.min(lines.length, 1) };
    const fallback = truncateUtf8(
      lines.slice(first.line_start - 1, first.line_end).join("\n"),
      maxBytes
    );
    return {
      start_line: first.line_start,
      end_line: first.line_end,
      content: fallback,
      truncated: true
    };
  }

  const contentExcerpt = output.join("\n");
  return {
    start_line: chunks[0]?.line_start ?? 1,
    end_line: chunks[chunks.length - 1]?.line_end ?? Math.max(1, contentExcerpt.split("\n").length),
    content: contentExcerpt,
    ...((truncated || omitted || contentExcerpt.length < content.length) ? { truncated: true } : {})
  };
}

function mergeFocusRanges(
  ranges: readonly RightSideRange[],
  totalLines: number,
  contextLines: number
): readonly RightSideRange[] {
  const expanded = ranges
    .map((range) => ({
      line_start: Math.max(1, range.line_start - contextLines),
      line_end: Math.min(totalLines, range.line_end + contextLines)
    }))
    .sort((left, right) => left.line_start - right.line_start || left.line_end - right.line_end);
  const merged: RightSideRange[] = [];

  for (const range of expanded) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.line_start <= previous.line_end + 1) {
      merged[merged.length - 1] = {
        line_start: previous.line_start,
        line_end: Math.max(previous.line_end, range.line_end)
      };
      continue;
    }
    merged.push(range);
  }

  return merged;
}
