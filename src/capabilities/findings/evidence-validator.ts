import type { RepoContext } from "../../capabilities/git/diff/types.js";
import type { Finding } from "../../core/findings/types.js";

function hasValidLineEvidence(
  filesByPath: Map<string, RepoContext["files"][number]>,
  evidence: Finding["evidence"][number]
): boolean {
  const changedFile = filesByPath.get(evidence.path);

  if (changedFile === undefined || changedFile.excerpt === null) {
    return false;
  }

  if (
    evidence.line_start < changedFile.excerpt.start_line ||
    evidence.line_end > changedFile.excerpt.end_line
  ) {
    return false;
  }

  return true;
}

function evidenceWithoutUnmatchedQuote(
  filesByPath: Map<string, RepoContext["files"][number]>,
  evidence: Finding["evidence"][number]
): Finding["evidence"][number] {
  const changedFile = filesByPath.get(evidence.path);

  if (
    changedFile?.excerpt === undefined ||
    changedFile.excerpt === null ||
    evidence.quote === undefined
  ) {
    return evidence;
  }

  const lineContent = excerptLineRangeContent(
    changedFile.excerpt.content,
    changedFile.excerpt.start_line,
    evidence.line_start,
    evidence.line_end
  );

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

export function validateFindingEvidence(
  repoContext: RepoContext,
  findings: readonly Finding[]
): Finding[] {
  const filesByPath = new Map(
    repoContext.files.map((changedFile) => [changedFile.path, changedFile])
  );

  return findings.map((finding) => {
    const evidence = finding.evidence
      .filter((entry) => hasValidLineEvidence(filesByPath, entry))
      .map((entry) => evidenceWithoutUnmatchedQuote(filesByPath, entry));
    const shouldDowngrade =
      evidence.length === 0 &&
      (finding.confidence === "high" || finding.confidence === "medium");

    return {
      ...finding,
      confidence: shouldDowngrade ? "low" : finding.confidence,
      evidence
    };
  });
}
