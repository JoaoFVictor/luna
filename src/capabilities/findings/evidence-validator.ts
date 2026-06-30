import type { RepoContext } from "../../capabilities/git/diff/types.js";
import type { Finding } from "../../core/findings/types.js";
import { rightSideLineRangeContent } from "../../core/repository/diff-hunks.js";
import { findingFingerprint } from "./fingerprint.js";

function hasValidLineEvidence(
  filesByPath: Map<string, RepoContext["files"][number]>,
  evidence: Finding["evidence"][number]
): boolean {
  const changedFile = filesByPath.get(evidence.path);

  if (changedFile === undefined) {
    return false;
  }

  return (
    excerptLineRangeContentFor(changedFile, evidence) !== undefined ||
    rightSideLineRangeContent(changedFile.patch, evidence.line_start, evidence.line_end) !== undefined
  );
}

function evidenceWithoutUnmatchedQuote(
  filesByPath: Map<string, RepoContext["files"][number]>,
  evidence: Finding["evidence"][number]
): Finding["evidence"][number] {
  const changedFile = filesByPath.get(evidence.path);

  if (changedFile === undefined || evidence.quote === undefined) {
    return evidence;
  }

  const lineContent =
    excerptLineRangeContentFor(changedFile, evidence) ??
    rightSideLineRangeContent(changedFile.patch, evidence.line_start, evidence.line_end);

  if (lineContent === undefined) {
    return evidence;
  }

  if (lineContent.includes(evidence.quote)) {
    return evidence;
  }

  return {
    path: evidence.path,
    line_start: evidence.line_start,
    line_end: evidence.line_end
  };
}

function excerptLineRangeContent(
  content: string,
  excerptStartLine: number,
  lineStart: number,
  lineEnd: number
): string {
  const lines = content.split("\n");
  const startIndex = lineStart - excerptStartLine;
  const endIndex = lineEnd - excerptStartLine;

  return lines.slice(startIndex, endIndex + 1).join("\n");
}

function excerptLineRangeContentFor(
  changedFile: RepoContext["files"][number],
  evidence: Finding["evidence"][number]
): string | undefined {
  if (changedFile.excerpt === null) {
    return undefined;
  }

  if (
    evidence.line_start < changedFile.excerpt.start_line ||
    evidence.line_end > changedFile.excerpt.end_line
  ) {
    return undefined;
  }

  return excerptLineRangeContent(
    changedFile.excerpt.content,
    changedFile.excerpt.start_line,
    evidence.line_start,
    evidence.line_end
  );
}

export function validateFindingEvidence(
  repoContext: RepoContext,
  findings: readonly Finding[]
): Finding[] {
  const filesByPath = new Map(
    repoContext.files.map((changedFile) => [changedFile.path, changedFile])
  );

  return findings.flatMap((finding) => {
    const evidence = finding.evidence
      .filter((entry) => hasValidLineEvidence(filesByPath, entry))
      .map((entry) => evidenceWithoutUnmatchedQuote(filesByPath, entry));

    if (evidence.length === 0) {
      return [];
    }

    const validatedFinding = {
      ...finding,
      evidence
    };

    return [{
      ...validatedFinding,
      fingerprint: findingFingerprint(validatedFinding)
    }];
  });
}
