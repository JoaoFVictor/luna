export type RightSideRange = {
  readonly line_start: number;
  readonly line_end: number;
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function rightSideRangesFromPatch(
  patch: string | null | undefined
): readonly RightSideRange[] {
  if (patch === null || patch === undefined) {
    return [];
  }

  const ranges: RightSideRange[] = [];
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null) {
      continue;
    }

    const start = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (length <= 0) {
      continue;
    }

    ranges.push({
      line_start: start,
      line_end: start + length - 1
    });
  }

  return ranges;
}

export function rightSideLineRangeContent(
  patch: string | null | undefined,
  lineStart: number,
  lineEnd: number
): string | undefined {
  if (patch === null || patch === undefined) {
    return undefined;
  }

  const linesByNumber = rightSideLinesByNumber(patch);
  const contents: string[] = [];
  for (let line = lineStart; line <= lineEnd; line += 1) {
    const content = linesByNumber.get(line);
    if (content === undefined) {
      return undefined;
    }
    contents.push(content);
  }

  return contents.join("\n");
}

export function patchHasRightSideLine(
  patch: string | null | undefined,
  line: number
): boolean {
  return rightSideLineRangeContent(patch, line, line) !== undefined;
}

function rightSideLinesByNumber(patch: string): ReadonlyMap<number, string> {
  let rightLine: number | undefined;
  const linesByNumber = new Map<number, string>();

  for (const rawLine of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk !== null) {
      rightLine = Number(hunk[1]);
      continue;
    }

    if (
      rightLine === undefined ||
      rawLine.startsWith("diff --git") ||
      rawLine.startsWith("\\ No newline")
    ) {
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      linesByNumber.set(rightLine, rawLine.slice(1));
      rightLine += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      linesByNumber.set(rightLine, rawLine.slice(1));
      rightLine += 1;
    }
  }

  return linesByNumber;
}
