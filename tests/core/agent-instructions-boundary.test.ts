import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DISCOURAGED_TERMS = [
  new RegExp(String.raw`\b${"leg"}acy\b`, "i"),
  new RegExp(String.raw`\b${"ol"}d architecture\b`, "i"),
  new RegExp(String.raw`\b${"ne"}w architecture\b`, "i"),
  new RegExp(String.raw`\b${"ol"}d runtime\b`, "i"),
  new RegExp(String.raw`\b${"ne"}w runtime\b`, "i"),
  new RegExp(String.raw`\b${"reb"}uild\b`, "i"),
  new RegExp(String.raw`\bconfigured-${"workflow"}\b`, "i"),
  new RegExp(String.raw`\bworkflow-${"scheduler"}\b`, "i"),
  new RegExp(String.raw`\b${"fl"}ue\b`, "i"),
  new RegExp(String.raw`\bgraph\.${"yaml"}\b`, "i")
] as const;

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

async function collectInstructionFiles(root: string): Promise<string[]> {
  const absoluteRoot = path.join(repoRoot, root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(root, entry.name);
      if (entry.isDirectory()) {
        return await collectInstructionFiles(relativePath);
      }

      return /\.(?:md|ya?ml)$/.test(entry.name) ? [relativePath] : [];
    })
  );

  return nested.flat();
}

async function instructionFiles(): Promise<string[]> {
  return [
    "AGENTS.md",
    ...(await lunaSkillFiles()),
    ...(await collectInstructionFiles("agents"))
  ].sort();
}

describe("agent instruction boundaries", () => {
  it("describes only the current Luna architecture", async () => {
    const violations: string[] = [];

    for (const relativePath of await instructionFiles()) {
      const lines = (await readText(relativePath)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (DISCOURAGED_TERMS.some((pattern) => pattern.test(line))) {
          violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
