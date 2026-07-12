import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioChangeSet } from "../../../src/studio/application/drafts/change-set.js";
import type { StudioDraftBlobReaderPort } from "../../../src/studio/application/drafts/persistence.js";
import { StudioDraftValidationService } from "../../../src/studio/application/validation/draft-validation.js";
import { StudioCanonicalDefinitionError } from "../../../src/studio/application/validation/definition-validation.js";
import { StudioSnapshotCleanupAggregateError } from "../../../src/studio/application/validation/snapshot.js";
import { FileSystemStudioValidationSnapshot } from "../../../src/studio/adapters/filesystem/validation-snapshot.js";
import { NativeStudioDefinitionValidation } from "../../../src/studio/adapters/native/definition-validation.js";
import type {
  StudioBaseFile,
  StudioChangeSet,
  StudioDependency,
  StudioDraftFileChange
} from "../../../src/studio/contracts/drafts.js";
import type { StudioResourceRef } from "../../../src/studio/contracts/paths.js";
import { StudioDraftValidationResultSchema } from "../../../src/studio/contracts/validation.js";

const DRAFT_ID = "00000000-0000-4000-8000-000000000020";
const fixtureRoot = path.join(process.cwd(), "tests/fixtures/workflows/minimum");
const workflowFiles = [
  "workflow.yaml",
  "input.schema.json",
  "output.schema.json"
] as const;
const temporaryDirectories: string[] = [];

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

class MemoryBlobStore implements StudioDraftBlobReaderPort {
  constructor(private readonly values: ReadonlyMap<string, string>) {}

  async getBlob(
    _draftId: string,
    reference: string,
    _options: { readonly maxBytes: number }
  ): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) {
      throw new Error(`Missing test blob ${reference}`);
    }
    return value;
  }
}

async function sourceFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function changeSet(input: {
  readonly resources: readonly StudioResourceRef[];
  readonly baseFiles: readonly StudioBaseFile[];
  readonly dependencies?: readonly StudioDependency[];
  readonly changes?: readonly StudioDraftFileChange[];
}): StudioChangeSet {
  return createStudioChangeSet({
    draftId: DRAFT_ID,
    primaryResource: input.resources[0]!,
    resources: input.resources,
    resourceRevisions: Object.fromEntries(
      input.resources.map((resource) => [
        `${resource.kind}:${resource.id}`,
        null
      ])
    ),
    baseBundleHash: digest("base-bundle"),
    technicalCatalogFingerprint: digest("technical-catalog"),
    presentationCatalogFingerprint: digest("presentation-catalog"),
    baseFiles: input.baseFiles,
    dependencies: input.dependencies ?? [],
    allowedFiles: input.baseFiles.map((entry) => entry.file),
    changes: input.changes,
    now: "2026-07-10T21:00:00.000Z"
  });
}

async function minimumWorkflowProject(): Promise<{
  readonly projectRoot: string;
  readonly contents: ReadonlyMap<string, string>;
  readonly baseFiles: readonly StudioBaseFile[];
}> {
  const projectRoot = await temporaryDirectory("luna-studio-project-");
  const workflowRoot = path.join(projectRoot, "workflows", "minimum");
  await mkdir(path.dirname(workflowRoot), { recursive: true });
  await cp(fixtureRoot, workflowRoot, { recursive: true });
  const contents = new Map<string, string>();
  const baseFiles: StudioBaseFile[] = [];
  for (const filename of workflowFiles) {
    const content = await readFile(path.join(workflowRoot, filename), "utf8");
    contents.set(digest(content), content);
    baseFiles.push({
      file: {
        root: "project",
        path: `workflows/minimum/${filename}`
      },
      sha256: digest(content),
      content_ref: digest(content),
      mode: 0o644
    });
  }
  return { projectRoot, contents, baseFiles };
}

function validationService(input: {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly temporaryRoot: string;
  readonly blobs: ReadonlyMap<string, string>;
}): StudioDraftValidationService {
  return new StudioDraftValidationService({
    snapshots: new FileSystemStudioValidationSnapshot({
      projectRoot: input.projectRoot,
      configRoot: input.configRoot,
      temporaryRoot: input.temporaryRoot,
      blobs: new MemoryBlobStore(input.blobs)
    }),
    definitions: new NativeStudioDefinitionValidation(),
    now: () => new Date("2026-07-10T21:30:00.000Z")
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio draft canonical validation", () => {
  it("projects authoritative node and edge locations for canvas diagnostics", async () => {
    const resource = { kind: "workflow", id: "minimum" } as const;
    const draft = changeSet({ resources: [resource], baseFiles: [] });
    const service = new StudioDraftValidationService({
      snapshots: {
        async create() {
          return {
            projectRoot: "/unused-project",
            configRoot: "/unused-config",
            verifiedFiles: [],
            async dispose() {}
          };
        }
      },
      definitions: {
        async validate() {
          throw new StudioCanonicalDefinitionError(
            "workflow_reference_unknown",
            "Workflow dependency is unknown.",
            {
              fieldPath: "$.nodes[1].after[0]",
              nodeId: "publish",
              edge: { from: "missing", to: "publish" }
            }
          );
        }
      }
    });

    const result = await service.validate(draft);
    expect(result.diagnostics[0]).toMatchObject({
      node_id: "publish",
      field_path: "$.nodes[1].after[0]",
      node_field_path: ["after", 0],
      edge: { from: "missing", to: "publish" }
    });
  });

  it("does not project a node field path without authoritative node ownership", async () => {
    const resource = { kind: "workflow", id: "minimum" } as const;
    const draft = changeSet({ resources: [resource], baseFiles: [] });
    const service = new StudioDraftValidationService({
      snapshots: {
        async create() {
          return {
            projectRoot: "/unused-project",
            configRoot: "/unused-config",
            verifiedFiles: [],
            async dispose() {}
          };
        }
      },
      definitions: {
        async validate() {
          throw new StudioCanonicalDefinitionError(
            "workflow_schema_invalid",
            "Workflow node input is invalid.",
            { fieldPath: "$.nodes[4].input.prompt" }
          );
        }
      }
    });

    const result = await service.validate(draft);
    expect(result.diagnostics[0]).toMatchObject({
      field_path: "$.nodes[4].input.prompt"
    });
    expect(result.diagnostics[0]).not.toHaveProperty("node_field_path");
    expect(result.diagnostics[0]).not.toHaveProperty("node_id");
  });

  it("drops oversized semantic locations instead of failing DTO projection", async () => {
    const resource = { kind: "workflow", id: "minimum" } as const;
    const draft = changeSet({
      resources: [resource],
      baseFiles: []
    });
    let disposed = false;
    const service = new StudioDraftValidationService({
      snapshots: {
        async create() {
          return {
            projectRoot: "/unused-project",
            configRoot: "/unused-config",
            verifiedFiles: [],
            async dispose() {
              disposed = true;
            }
          };
        }
      },
      definitions: {
        async validate() {
          throw new StudioCanonicalDefinitionError(
            "workflow_capability_missing",
            "Workflow failed canonical validation.",
            {
              fieldPath: "p".repeat(1_025),
              capability: "c".repeat(257)
            }
          );
        }
      },
      now: () => new Date("2026-07-10T21:30:00.000Z")
    });

    const result = await service.validate(draft, { compile: true });

    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        code: "workflow_capability_missing",
        message: "Workflow failed canonical validation.",
        resource
      }
    ]);
    expect(disposed).toBe(true);
  });

  it("validates and compiles a workflow through the real native pipeline", async () => {
    const project = await minimumWorkflowProject();
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const draft = changeSet({
      resources: [{ kind: "workflow", id: "minimum" }],
      baseFiles: project.baseFiles
    });
    const service = validationService({
      projectRoot: project.projectRoot,
      configRoot,
      temporaryRoot,
      blobs: project.contents
    });

    const result = await service.validate(draft, { compile: true });

    expect(result).toMatchObject({
      draft_id: DRAFT_ID,
      status: "valid",
      compiled: true,
      validated_at: "2026-07-10T21:30:00.000Z",
      resources: [
        {
          resource: { kind: "workflow", id: "minimum" },
          status: "valid",
          revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          diagnostics: [],
          compiled_workflow: {
            workflow_id: "minimum",
            workflow_revision: expect.stringMatching(/^sha256:/),
            nodes: expect.any(Array),
            edges: expect.any(Array)
          }
        }
      ]
    });
    expect(result.resources[0]?.compiled_workflow?.nodes.length).toBeGreaterThan(0);
    for (const field of [
      "record_revision",
      "content_revision",
      "layout_revision"
    ] as const) {
      expect(
        StudioDraftValidationResultSchema.safeParse({
          ...result,
          [field]: Number.MAX_SAFE_INTEGER + 1
        }).success
      ).toBe(false);
    }
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("rejects a draft dependency that the runtime would reject after compilation", async () => {
    const project = await minimumWorkflowProject();
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const workflowFile = project.baseFiles.find((entry) =>
      entry.file.path.endsWith("workflow.yaml")
    )!;
    const original = project.contents.get(workflowFile.content_ref!)!;
    const invalid = original
      .replace(
        "  - id: context\n    type: built_in",
        "  - id: context\n    after: [final_report]\n    type: built_in"
      )
      .replace("    after: [context]\n    input:", "    input:");
    const blobs = new Map(project.contents);
    blobs.set(digest(invalid), invalid);
    const draft = changeSet({
      resources: [{ kind: "workflow", id: "minimum" }],
      baseFiles: project.baseFiles,
      changes: [{
        action: "write",
        file: workflowFile.file,
        base_sha256: workflowFile.sha256,
        content_sha256: digest(invalid),
        content_ref: digest(invalid)
      }]
    });
    const service = validationService({
      projectRoot: project.projectRoot,
      configRoot,
      temporaryRoot,
      blobs
    });

    const result = await service.validate(draft, { compile: true });

    expect(result).toMatchObject({
      status: "invalid",
      diagnostics: [{
        severity: "error",
        code: "workflow_deferred_dependency_invalid",
        resource: { kind: "workflow", id: "minimum" },
        node_id: "context",
        edge: { from: "final_report", to: "context" }
      }]
    });
  });

  it("returns a safe domain diagnostic for an invalid workflow overlay", async () => {
    const project = await minimumWorkflowProject();
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const workflowFile = project.baseFiles.find((entry) =>
      entry.file.path.endsWith("workflow.yaml")
    )!;
    const original = project.contents.get(workflowFile.content_ref!)!;
    const invalid = original.replace(
      "uses: context.collect_context",
      "uses: missing.unknown"
    );
    const blobs = new Map(project.contents);
    blobs.set(digest(invalid), invalid);
    const draft = changeSet({
      resources: [{ kind: "workflow", id: "minimum" }],
      baseFiles: project.baseFiles,
      changes: [
        {
          action: "write",
          file: workflowFile.file,
          base_sha256: workflowFile.sha256,
          content_sha256: digest(invalid),
          content_ref: digest(invalid)
        }
      ]
    });
    const service = validationService({
      projectRoot: project.projectRoot,
      configRoot,
      temporaryRoot,
      blobs
    });

    const result = await service.validate(draft, { compile: true });

    expect(result).toMatchObject({
      status: "invalid",
      resources: [
        {
          status: "invalid",
          diagnostics: [
            {
              severity: "error",
              code: "workflow_capability_missing",
              resource: { kind: "workflow", id: "minimum" }
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain(temporaryRoot);
    expect(JSON.stringify(result)).not.toContain(project.projectRoot);
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("validates an agent and hashes instructions plus output schema", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const models = [
      "model_profiles:",
      "  default:",
      "    model: test/test-model",
      "    reasoning_effort: low",
      ""
    ].join("\n");
    await sourceFile(configRoot, "models.yaml", models);
    const files = new Map<string, string>([
      [
        "agents/helper/agent.yaml",
        [
          "id: helper",
          "description: Helper agent",
          "model_profile: default",
          "mode: read_only",
          "instructions_file: instructions.md",
          "output_schema: output.schema.json",
          ""
        ].join("\n")
      ],
      ["agents/helper/instructions.md", "Return a concise result.\n"],
      [
        "agents/helper/output.schema.json",
        '{"type":"object","additionalProperties":true}\n'
      ]
    ]);
    const blobs = new Map<string, string>();
    const baseFiles: StudioBaseFile[] = [];
    for (const [relativePath, content] of files) {
      await sourceFile(projectRoot, relativePath, content);
      blobs.set(digest(content), content);
      baseFiles.push({
        file: { root: "project", path: relativePath },
        sha256: digest(content),
        content_ref: digest(content),
        mode: 0o644
      });
    }
    const draft = changeSet({
      resources: [{ kind: "agent", id: "helper" }],
      baseFiles,
      dependencies: [{
        file: { root: "config", path: "models.yaml" },
        sha256: digest(models)
      }]
    });
    const service = validationService({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs
    });

    const result = await service.validate(draft);

    expect(result).toMatchObject({
      status: "valid",
      compiled: false,
      resources: [
        {
          resource: { kind: "agent", id: "helper" },
          revision: expect.stringMatching(/^sha256:/)
        }
      ]
    });

    const agentFile = baseFiles.find(
      (file) => file.file.path === "agents/helper/agent.yaml"
    );
    if (agentFile?.content_ref === null || agentFile?.content_ref === undefined) {
      throw new Error("Expected agent definition fixture");
    }
    const unknownProfile = files.get("agents/helper/agent.yaml")!.replace(
      "model_profile: default",
      "model_profile: missing"
    );
    blobs.set(digest(unknownProfile), unknownProfile);
    const invalid = changeSet({
      resources: [{ kind: "agent", id: "helper" }],
      baseFiles,
      dependencies: [{
        file: { root: "config", path: "models.yaml" },
        sha256: digest(models)
      }],
      changes: [{
        action: "write",
        file: agentFile.file,
        base_sha256: agentFile.sha256,
        content_sha256: digest(unknownProfile),
        content_ref: digest(unknownProfile)
      }]
    });

    await expect(service.validate(invalid)).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({
        code: "agent_model_profile_unknown",
        resource: { kind: "agent", id: "helper" }
      })]
    });
  });

  it("validates workflow-owned config in the isolated config root", async () => {
    const project = await minimumWorkflowProject();
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const workflowPath = path.join(
      project.projectRoot,
      "workflows/minimum/workflow.yaml"
    );
    const originalWorkflow = await readFile(workflowPath, "utf8");
    const configuredWorkflow = originalWorkflow.replace(
      "capabilities:",
      [
        "config:",
        "  file: workflows/minimum.yaml",
        "  schema: config.schema.json",
        "capabilities:"
      ].join("\n")
    );
    await writeFile(workflowPath, configuredWorkflow, "utf8");
    const configSchema = [
      "{",
      '  "type": "object",',
      '  "additionalProperties": false,',
      '  "required": ["enabled"],',
      '  "properties": { "enabled": { "type": "boolean" } }',
      "}",
      ""
    ].join("\n");
    await sourceFile(
      project.projectRoot,
      "workflows/minimum/config.schema.json",
      configSchema
    );
    const configContent = "enabled: true\n";
    await sourceFile(configRoot, "workflows/minimum.yaml", configContent);

    const dependencyContents = new Map<string, string>();
    const dependencies: StudioDependency[] = [];
    for (const filename of [
      "workflow.yaml",
      "input.schema.json",
      "output.schema.json",
      "config.schema.json"
    ]) {
      const relativePath = `workflows/minimum/${filename}`;
      const content = await readFile(
        path.join(project.projectRoot, relativePath),
        "utf8"
      );
      dependencyContents.set(digest(content), content);
      dependencies.push({
        file: { root: "project", path: relativePath },
        sha256: digest(content)
      });
    }
    const configFile: StudioBaseFile = {
      file: { root: "config", path: "workflows/minimum.yaml" },
      sha256: digest(configContent),
      content_ref: digest(configContent),
      mode: 0o644
    };
    dependencyContents.set(digest(configContent), configContent);
    const draft = changeSet({
      resources: [{ kind: "config", id: "minimum" }],
      baseFiles: [configFile],
      dependencies
    });
    const service = validationService({
      projectRoot: project.projectRoot,
      configRoot,
      temporaryRoot,
      blobs: dependencyContents
    });

    const result = await service.validate(draft);

    expect(result).toMatchObject({
      status: "valid",
      resources: [
        {
          resource: { kind: "config", id: "minimum" },
          revision: expect.stringMatching(/^sha256:/)
        }
      ]
    });
  });

  it("does not mask an internal validation failure when disposal also fails", async () => {
    const operationFailure = new Error("injected validation failure");
    const cleanupFailure = new Error("injected disposal failure");
    const draft = changeSet({
      resources: [{ kind: "workflow", id: "minimum" }],
      baseFiles: []
    });
    const service = new StudioDraftValidationService({
      snapshots: {
        async create() {
          return {
            projectRoot: "/private/project",
            configRoot: "/private/config",
            verifiedFiles: [],
            async dispose(): Promise<void> {
              throw cleanupFailure;
            }
          };
        }
      },
      definitions: {
        async validate() {
          throw operationFailure;
        }
      }
    });

    let caught: unknown;
    try {
      await service.validate(draft);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(StudioSnapshotCleanupAggregateError);
    expect(caught).toMatchObject({ operationCause: operationFailure, cleanupCause: cleanupFailure });
    expect((caught as AggregateError).errors).toEqual([
      operationFailure,
      cleanupFailure
    ]);
  });
});
