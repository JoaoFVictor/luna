import type { Finding, RepoContext } from "./types.js";

function hasValidEvidence(
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

  if (
    evidence.quote !== undefined &&
    !excerptLineRangeContent(
      changedFile.excerpt.content,
      changedFile.excerpt.start_line,
      evidence.line_start,
      evidence.line_end
    ).includes(evidence.quote)
  ) {
    return false;
  }

  return true;
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
    const evidence = finding.evidence.filter((entry) =>
      hasValidEvidence(filesByPath, entry)
    );
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
