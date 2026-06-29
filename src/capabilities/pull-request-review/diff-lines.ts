export function patchHasRightSideLine(
  patch: string | null | undefined,
  line: number
): boolean {
  if (patch === undefined || patch === null) {
    return false;
  }

  let rightLine: number | undefined;
  for (const rawLine of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk !== null) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (rightLine === undefined || rawLine.startsWith("diff --git")) {
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      if (rightLine === line) {
        return true;
      }
      rightLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      if (rightLine === line) {
        return true;
      }
      rightLine += 1;
    }
  }

  return false;
}
