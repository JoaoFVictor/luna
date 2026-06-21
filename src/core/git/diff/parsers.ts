export type GitDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "changed"
  | "unmerged"
  | "unknown";

export type RawDiffEntry = {
  path: string;
  previousPath?: string;
  status: GitDiffFileStatus;
  oldMode: string;
  newMode: string;
  isSubmodule: boolean;
};

export type NumstatEntry = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

export function nulFields(output: string): string[] {
  const fields = output.split("\0");

  if (fields.at(-1) === "") {
    fields.pop();
  }

  return fields;
}

export function gitFileStatusFromCode(code: string): GitDiffFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

export function parseRawDiff(raw: string): Map<string, RawDiffEntry> {
  const entries = new Map<string, RawDiffEntry>();
  const fields = nulFields(raw);

  for (let index = 0; index < fields.length; ) {
    const metadata = fields[index++];
    const [, oldMode, newMode, , , statusCode] =
      metadata.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/) ?? [];

    if (!oldMode || !newMode || !statusCode) {
      continue;
    }

    const status = gitFileStatusFromCode(statusCode);
    const firstPath = fields[index++];
    const secondPath = status === "renamed" || status === "copied" ? fields[index++] : undefined;
    const path = status === "renamed" || status === "copied" ? secondPath : firstPath;
    const previousPath = status === "renamed" ? firstPath : undefined;

    if (!path) {
      continue;
    }

    entries.set(path, {
      path,
      previousPath,
      status,
      oldMode,
      newMode,
      isSubmodule: oldMode === "160000" || newMode === "160000"
    });
  }

  return entries;
}

function parseCount(value: string): number {
  return value === "-" ? 0 : Number.parseInt(value, 10);
}

export function parseNumstat(numstat: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>();
  const fields = nulFields(numstat);

  for (let index = 0; index < fields.length; ) {
    const stats = fields[index++];
    const firstTab = stats.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : stats.indexOf("\t", firstTab + 1);

    if (firstTab === -1 || secondTab === -1) {
      continue;
    }

    const additions = stats.slice(0, firstTab);
    const deletions = stats.slice(firstTab + 1, secondTab);
    const pathInStats = stats.slice(secondTab + 1);
    const path = pathInStats === "" ? fields[index + 1] : pathInStats;

    if (pathInStats === "") {
      index += 2;
    }

    if (!additions || !deletions || !path) {
      continue;
    }

    entries.set(path, {
      path,
      additions: parseCount(additions),
      deletions: parseCount(deletions),
      binary: additions === "-" && deletions === "-"
    });
  }

  return entries;
}
