import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { CreatedAgent } from "@flue/runtime";
import type { RunConfiguredWorkflowOptions } from "../../src/core/configured-workflow-runner.js";
import type { RunIdentity } from "../../src/core/types.js";

export type PromptCall = {
  text: string;
  options: Record<string, unknown>;
};

export type InitCall = {
  agent: CreatedAgent;
  options?: { name?: string };
};

export type LocalCall = {
  cwd?: string;
  env?: Record<string, string | undefined>;
};

const originalEnv = { ...process.env };

export const modelProfiles = {
  default: {
    model: "openai-codex/gpt-5.4-mini",
    reasoning_effort: "medium" as const
  },
  deep: {
    model: "openai-codex/gpt-5.4-mini",
    reasoning_effort: "high" as const
  }
};

export const githubRun: RunIdentity = {
  run_id: "run-1",
  workflow_id: "code-review",
  attempt: 1,
  source: "github",
  event: "pull_request",
  action: "selected",
  route_target: { type: "workflow", id: "code-review" },
  subject: { type: "pull_request", id: "42" },
  started_at: "2026-06-20T00:00:00.000Z"
};

export async function createImplementationSafeGitSkill(root: string): Promise<void> {
  const skillDir = path.join(root, "skills", "implementation-safe-git");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: implementation-safe-git",
      "description: Keep implementation work scoped and reviewable.",
      "---",
      "",
      "# Implementation Safe Git",
      ""
    ].join("\n")
  );
}

export function resetEnv(): void {
  process.env = { ...originalEnv };
}

export async function importWorkflowWithRunnerMock(
  modulePath: string,
  runConfiguredWorkflow: (options: RunConfiguredWorkflowOptions) => Promise<unknown>,
  registerConfiguredPiOAuthProviders: () => Promise<void> = async () => {}
): Promise<{ run: (ctx: never) => Promise<unknown> }> {
  vi.resetModules();
  vi.doMock("../../src/core/configured-workflow-runner.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/core/configured-workflow-runner.js")>()),
    runConfiguredWorkflow
  }));
  vi.doMock("../../src/core/agent-runtime/flue/pi-auth.js", async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/core/agent-runtime/flue/pi-auth.js")
    >()),
    registerConfiguredPiOAuthProviders
  }));

  return await import(modulePath) as { run: (ctx: never) => Promise<unknown> };
}

export function cleanupFlueMocks(): void {
  vi.doUnmock("../../src/core/configured-workflow-runner.js");
  vi.doUnmock("../../src/core/agent-runtime/flue/capabilities.js");
  vi.doUnmock("../../src/core/agents/loop-runner.js");
  vi.doUnmock("../../src/core/agent-runtime/flue/pi-auth.js");
  vi.resetModules();
  vi.restoreAllMocks();
  resetEnv();
}
