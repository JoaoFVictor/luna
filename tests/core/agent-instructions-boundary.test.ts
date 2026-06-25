import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type InstructionViolation = {
  path: string;
  line: number;
  rule: string;
  text: string;
};

type InstructionLine = {
  path: string;
  line: number;
  text: string;
};

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function lunaSkillFiles(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, "skills"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("luna-"))
    .map((entry) => path.posix.join("skills", entry.name, "SKILL.md"))
    .sort();
}

async function instructionFiles(): Promise<string[]> {
  return ["AGENTS.md", ...(await lunaSkillFiles())];
}

function linesWithPath(relativePath: string, content: string): InstructionLine[] {
  return content.split(/\r?\n/).map((text, index) => ({
    path: relativePath,
    line: index + 1,
    text
  }));
}

function isDiagnosticScanLine(text: string): boolean {
  return /^\s*(?:rg|rtk rg)\b/.test(text);
}

function isNegativeBoundaryLine(text: string): boolean {
  return /\b(?:do not|don't|must not|never|forbidden|reject|rejected|ban|banned|not recommend)\b/i.test(
    text
  );
}

function isBulletStart(text: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(text);
}

function isBlockBoundary(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("```");
}

function lineEndsSentence(text: string): boolean {
  return /[.!?]\s*$/.test(text.trimEnd());
}

function connectedTextForLine(
  lines: readonly InstructionLine[],
  index: number
): string {
  let start = index;
  while (start > 0) {
    const previous = lines[start - 1].text;
    const current = lines[start].text;
    if (
      isBlockBoundary(previous) ||
      isBlockBoundary(current) ||
      isBulletStart(current) ||
      lineEndsSentence(previous)
    ) {
      break;
    }
    start -= 1;
  }

  let end = index;
  while (end + 1 < lines.length) {
    const current = lines[end].text;
    const next = lines[end + 1].text;
    if (
      isBlockBoundary(current) ||
      isBlockBoundary(next) ||
      isBulletStart(next) ||
      lineEndsSentence(current)
    ) {
      break;
    }
    end += 1;
  }

  const connectedText = lines
    .slice(start, end + 1)
    .map((line) => line.text.trim())
    .join(" ");

  return connectedText;
}

function clausesContainingPath(
  lines: readonly InstructionLine[],
  index: number,
  pathPattern: RegExp
): string[] {
  const connectedText = connectedTextForLine(lines, index);
  const clauses = connectedText.match(/[^;.!?]+[;.!?]?/g) ?? [connectedText];
  return clauses
    .map((clause) => clause.trim())
    .filter((clause) => pathPattern.test(clause));
}

function isAllowedLegacyFlueCutoverSentence(text: string): boolean {
  return (
    /\b(?:legacy|existing)\b/i.test(text) &&
    /\b(?:Task 18|atomic cutover)\b/.test(text) &&
    /\b(?:may remain|only until|Existing code only|do not add new runtime guidance)\b/i.test(
      text
    )
  );
}

function staleProviderRootViolations(
  relativePath: string,
  content: string
): InstructionViolation[] {
  const lines = linesWithPath(relativePath, content);
  const providerPathPattern = /src\/core\/providers(?:\/|\b)[^\s`,.)]*/;

  return lines.flatMap((line, index) => {
    if (!providerPathPattern.test(line.text)) {
      return [];
    }

    const pathClauses = clausesContainingPath(lines, index, providerPathPattern);
    if (
      isDiagnosticScanLine(line.text) ||
      pathClauses.every((clause) => isNegativeBoundaryLine(clause))
    ) {
      return [];
    }

    return [
      {
        ...line,
        rule: "stale provider root guidance"
      }
    ];
  });
}

function staleFlueAdapterPathViolations(
  relativePath: string,
  content: string
): InstructionViolation[] {
  const lines = linesWithPath(relativePath, content);
  const fluePathPattern = /src\/core\/agent-runtime\/flue[^\s`,.)]*/;

  return lines.flatMap((line, index) => {
    if (!fluePathPattern.test(line.text)) {
      return [];
    }

    if (isDiagnosticScanLine(line.text)) {
      return [];
    }

    const pathClauses = clausesContainingPath(lines, index, fluePathPattern);
    return pathClauses.every((clause) => isAllowedLegacyFlueCutoverSentence(clause))
      ? []
      : [
          {
            ...line,
            rule: "stale Flue adapter path guidance"
          }
        ];
  });
}

function configuredWorkflowRuntimeViolations(
  relativePath: string,
  content: string
): InstructionViolation[] {
  const lines = linesWithPath(relativePath, content);
  const configuredWorkflowPathPattern = /src\/core\/configured-workflow(?:\/|\b)[^\s`,.)]*/;

  return lines.flatMap((line, index) => {
    if (!configuredWorkflowPathPattern.test(line.text)) {
      return [];
    }

    const pathClauses = clausesContainingPath(
      lines,
      index,
      configuredWorkflowPathPattern
    );
    if (
      isDiagnosticScanLine(line.text) ||
      pathClauses.every((clause) => isNegativeBoundaryLine(clause))
    ) {
      return [];
    }

    return [
      {
        ...line,
        rule: "configured workflow runner as target runtime guidance"
      }
    ];
  });
}

async function scanInstructionViolations(): Promise<InstructionViolation[]> {
  const files = await instructionFiles();
  const violations = await Promise.all(
    files.map(async (relativePath) => {
      const content = await readText(relativePath);
      return [
        ...staleProviderRootViolations(relativePath, content),
        ...staleFlueAdapterPathViolations(relativePath, content),
        ...configuredWorkflowRuntimeViolations(relativePath, content)
      ];
    })
  );

  return violations.flat();
}

describe("agent instruction boundaries", () => {
  it.each([
    {
      content: "Provider built-ins live in `src/core/providers/built-ins.ts`.",
      rule: "stale provider root guidance"
    },
    {
      content: "Jira API helpers belong under `src/core/providers/jira/`.",
      rule: "stale provider root guidance"
    },
    {
      content: "Provider auth belongs under `src/core/providers/**`.",
      rule: "stale provider root guidance"
    },
    {
      content: "Materialize Flue tools in `src/core/agent-runtime/flue/tool-registry.ts`.",
      rule: "stale Flue adapter path guidance"
    },
    {
      content: "Use `src/core/configured-workflow/` as the runtime target.",
      rule: "configured workflow runner as target runtime guidance"
    },
    {
      content:
        "Do not add provider code under `src/core/providers/**`.\nProvider auth belongs under `src/core/providers/**`.",
      rule: "stale provider root guidance"
    },
    {
      content:
        "Do not add provider code under `src/core/providers/**`. Provider auth belongs under `src/core/providers/**`.",
      rule: "stale provider root guidance"
    },
    {
      content:
        "Do not add provider code under `src/core/providers/**`; provider auth belongs under `src/core/providers/**`.",
      rule: "stale provider root guidance"
    },
    {
      content:
        "Never use src/core/configured-workflow/ as target runtime. Use src/core/configured-workflow/ for workflow execution.",
      rule: "configured workflow runner as target runtime guidance"
    },
    {
      content:
        "Never use src/core/configured-workflow/ as target runtime; use src/core/configured-workflow/ for workflow execution.",
      rule: "configured workflow runner as target runtime guidance"
    },
    {
      content:
        "`src/core/agent-runtime/flue/**`: legacy may remain only until Task 18 atomic cutover.\nMaterialize Flue tools in `src/core/agent-runtime/flue/tool-registry.ts`.",
      rule: "stale Flue adapter path guidance"
    },
    {
      content:
        "`src/core/agent-runtime/flue/**`: legacy Flue code may remain only until Task 18 atomic cutover. Materialize Flue tools in `src/core/agent-runtime/flue/tool-registry.ts`.",
      rule: "stale Flue adapter path guidance"
    },
    {
      content:
        "`src/core/agent-runtime/flue/**`: legacy Flue code may remain only until Task 18 atomic cutover; materialize Flue tools in `src/core/agent-runtime/flue/tool-registry.ts`.",
      rule: "stale Flue adapter path guidance"
    }
  ])("rejects stale instruction fixture: $content", ({ content, rule }) => {
    const violations = [
      ...staleProviderRootViolations("fixture.md", content),
      ...staleFlueAdapterPathViolations("fixture.md", content),
      ...configuredWorkflowRuntimeViolations("fixture.md", content)
    ];

    expect(violations).toContainEqual(expect.objectContaining({ rule }));
  });

  it.each([
    "Do not add provider code under `src/core/providers/**`.",
    "Never use `src/core/configured-workflow/` as a target runtime path.",
    "`src/core/agent-runtime/flue/**`: legacy Flue adapter code may remain only until Task 18 atomic cutover.",
    "Existing legacy Flue code under `src/core/agent-runtime/flue/**` may remain only until the Task 18 atomic cutover.",
    "rtk rg -n \"src/core/providers/|src/core/agent-runtime/flue|src/core/configured-workflow/\" AGENTS.md skills"
  ])("allows explicit ban, diagnostic scan, or bounded legacy wording: $content", (content) => {
    const violations = [
      ...staleProviderRootViolations("fixture.md", content),
      ...staleFlueAdapterPathViolations("fixture.md", content),
      ...configuredWorkflowRuntimeViolations("fixture.md", content)
    ];

    expect(violations).toEqual([]);
  });

  it("keeps Luna agent instructions aligned with rebuild module boundaries", async () => {
    expect(await scanInstructionViolations()).toEqual([]);
  });
});
