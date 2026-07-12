import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { FileSystemStudioDraftRepository } from "../../../src/studio/adapters/filesystem/draft-repository.js";
import { FileSystemStudioValidationSnapshot } from "../../../src/studio/adapters/filesystem/validation-snapshot.js";
import { NativeStudioDefinitionValidation } from "../../../src/studio/adapters/native/definition-validation.js";
import { StudioDraftValidationService } from "../../../src/studio/application/validation/draft-validation.js";
import { createNativeStudioDraftAuthoringSurface } from "../../../src/studio/server/native-draft-authoring-surface.js";
import {
  PRESENTATION_FINGERPRINT,
  TECHNICAL_FINGERPRINT
} from "./authoring-test-support.js";

export async function nativeFixture() {
  const projectRoot = await mkdtemp(
    path.join(tmpdir(), "luna-studio-draft-authoring-")
  );
  const configRoot = path.join(projectRoot, "config");
  await mkdir(configRoot);
  await writeFile(
    path.join(configRoot, "models.yaml"),
    [
      "model_profiles:",
      "  fast:",
      "    model: test/test-model",
      "    reasoning_effort: low",
      ""
    ].join("\n"),
    "utf8"
  );
  const lockManager = {
    acquire: async () => async () => undefined
  };
  const drafts = new FileSystemStudioDraftRepository({
    projectRoot,
    lockManager
  });
  const definitions = new NativeStudioDefinitionValidation({
    platform: nativeLunaPlatformRegistrations
  });
  const validation = new StudioDraftValidationService({
    snapshots: new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      blobs: drafts
    }),
    definitions
  });
  const plan = vi.fn();
  const apply = vi.fn();
  const surface = createNativeStudioDraftAuthoringSurface({
    projectRoot,
    configRoot,
    platform: nativeLunaPlatformRegistrations,
    authoring: { drafts, validation, apply: { plan, apply } },
    catalogs: {
      technical: () => TECHNICAL_FINGERPRINT,
      presentation: () => PRESENTATION_FINGERPRINT
    }
  });
  return { ...surface, projectRoot, configRoot, drafts };
}

export const JSON_SCHEMA = '{"type":"object","additionalProperties":false}\n';

export async function installAgent(
  projectRoot: string,
  agentId: string,
  options: {
    readonly contextFile?: string;
    readonly mode?: "read_only" | "trusted_local_write";
  } = {}
): Promise<void> {
  const directory = path.join(projectRoot, "agents", agentId);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "agent.yaml"),
      [
        `id: ${agentId}`,
        `description: Agent ${agentId}.`,
        "model_profile: fast",
        `mode: ${options.mode ?? "read_only"}`,
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        ...(options.contextFile === undefined
          ? []
          : ["context:", "  files:", `    - ${options.contextFile}`]),
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(path.join(directory, "instructions.md"), "Be precise.\n", "utf8"),
    writeFile(path.join(directory, "output.schema.json"), JSON_SCHEMA, "utf8"),
    ...(options.contextFile === undefined
      ? []
      : [writeFile(path.join(directory, options.contextFile), "Repository guidance.\n", "utf8")])
  ]);
}

export function workflowWithAgent(workflowId: string, agentId: string): string {
  return [
    `id: ${workflowId}`,
    "type: workflow",
    "mode: read_only",
    "input_schema: input.schema.json",
    "output_schema: output.schema.json",
    "capabilities: [agents]",
    "nodes:",
    "  - id: execute",
    "    type: agent",
    `    agent: ${agentId}`,
    "    output_schema: output.schema.json",
    ""
  ].join("\n");
}
