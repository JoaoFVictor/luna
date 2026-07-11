import { describe, expect, it } from "vitest";
import type { StudioYamlSourceOperation } from "../../../src/studio/contracts/draft-authoring.js";
import {
  installAgent,
  nativeFixture,
  workflowWithAgent
} from "./authoring-native-test-support.js";

describe("native Studio draft authoring templates and validation", () => {
  it("instantiates and compiles the versioned read-only pipeline template", async () => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "workflow", id: "template-pipeline" },
      source: {
        mode: "template",
        template_id: "read-only-pipeline",
        template_version: "1"
      }
    });

    const compiled = await service.compile(draft.draft_id, draft.etag);

    expect(compiled.validation).toMatchObject({
      status: "valid",
      compiled: true,
      resources: [
        {
          compiled_workflow: {
            workflow_id: "template-pipeline",
            nodes: [{ id: "preflight", kind: "built_in" }]
          }
        }
      ]
    });
  });

  it("instantiates an agent template with its dependency closure", async () => {
    const { service, projectRoot, drafts } = await nativeFixture();
    await installAgent(projectRoot, "template-agent");

    const draft = await service.create({
      resource: { kind: "workflow", id: "template-agent-flow" },
      source: {
        mode: "template",
        template_id: "agent-workflow",
        template_version: "1",
        parameters: {
          agent: {
            id: "template-agent",
            output_schema: "output.schema.json"
          }
        }
      }
    });

    expect(
      (await drafts.get(draft.draft_id))?.dependencies.map(
        (dependency) => dependency.file.path
      )
    ).toEqual([
      "models.yaml",
      "agents/template-agent/agent.yaml",
      "agents/template-agent/instructions.md",
      "agents/template-agent/output.schema.json"
    ]);
    await expect(
      service.compile(draft.draft_id, draft.etag)
    ).resolves.toMatchObject({
      validation: {
        status: "valid",
        compiled: true,
        resources: [
          {
            compiled_workflow: {
              nodes: [
                { id: "context", kind: "built_in" },
                { id: "agent_task", kind: "agent" }
              ]
            }
          }
        ]
      }
    });
  });

  it("instantiates the parallel review template with two explicit read-only agents", async () => {
    const { service, projectRoot } = await nativeFixture();
    await Promise.all([
      installAgent(projectRoot, "primary-reviewer"),
      installAgent(projectRoot, "secondary-reviewer")
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "parallel-review-flow" },
      source: {
        mode: "template",
        template_id: "parallel-review",
        template_version: "1",
        parameters: {
          primary_reviewer: {
            id: "primary-reviewer",
            output_schema: "output.schema.json",
            mode: "read_only"
          },
          secondary_reviewer: {
            id: "secondary-reviewer",
            output_schema: "output.schema.json",
            mode: "read_only"
          }
        }
      }
    });

    const compiled = await service.compile(draft.draft_id, draft.etag);

    expect(compiled.validation).toMatchObject({
      status: "valid",
      resources: [{
        compiled_workflow: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "primary_review", kind: "agent" }),
            expect.objectContaining({ id: "secondary_review", kind: "agent" }),
            expect.objectContaining({ id: "report", kind: "built_in" })
          ])
        }
      }]
    });
  });

  it("instantiates a canonical gated repair pattern and validates parameter modes", async () => {
    const { service, projectRoot } = await nativeFixture();
    await Promise.all([
      installAgent(projectRoot, "repair-worker"),
      installAgent(projectRoot, "repair-reviewer", { contextFile: "context.md" })
    ]);
    const source = {
      mode: "template" as const,
      template_id: "gated-repair-loop",
      template_version: "1",
      parameters: {
        worker: {
          id: "repair-worker",
          output_schema: "output.schema.json",
          mode: "read_only" as const
        },
        reviewer: {
          id: "repair-reviewer",
          output_schema: "output.schema.json",
          mode: "read_only" as const
        }
      }
    };
    const draft = await service.create({
      resource: { kind: "workflow", id: "gated-repair-flow" },
      source
    });

    await expect(service.compile(draft.draft_id, draft.etag)).resolves.toMatchObject({
      validation: {
        status: "valid",
        resources: [{
          compiled_workflow: {
            nodes: expect.arrayContaining([
              expect.objectContaining({ id: "repair", kind: "pattern" })
            ])
          }
        }]
      }
    });

    await expect(service.create({
      resource: { kind: "workflow", id: "invalid-reviewer-mode" },
      source: {
        ...source,
        parameters: {
          ...source.parameters,
          reviewer: {
            ...source.parameters.reviewer,
            mode: "trusted_local_write"
          }
        }
      }
    })).rejects.toMatchObject({
      code: "studio_draft_authoring_resource_invalid"
    });
  });

  it.each([
    ["human-approval-side-effect", "approval-flow", ["approval", "enforce_approval", "commit"]],
    ["context-report", "context-report-flow", ["context", "report"]]
  ] as const)("instantiates and compiles the %s template", async (
    templateId,
    workflowId,
    expectedNodes
  ) => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "workflow", id: workflowId },
      source: {
        mode: "template",
        template_id: templateId,
        template_version: "1"
      }
    });

    const compiled = await service.compile(draft.draft_id, draft.etag);

    expect(compiled.validation.status).toBe("valid");
    expect(
      compiled.validation.resources[0]?.compiled_workflow?.nodes.map((node) => node.id)
    ).toEqual(expectedNodes);
  });

  it("generates a blank workflow accepted by the canonical compiler", async () => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "workflow", id: "blank-workflow" },
      source: { mode: "blank" }
    });

    const compiled = await service.compile(draft.draft_id, draft.etag);

    expect(compiled.validation).toMatchObject({
      status: "valid",
      compiled: true,
      resources: [
        {
          resource: { kind: "workflow", id: "blank-workflow" },
          status: "valid",
          compiled_workflow: {
            workflow_id: "blank-workflow",
            nodes: [],
            edges: []
          }
        }
      ]
    });
  });

  it("blocks a context-dependent agent without explicit collection and passage", async () => {
    const { service, projectRoot } = await nativeFixture();
    await installAgent(projectRoot, "context-agent", { contextFile: "context.md" });
    const draft = await service.create({
      resource: { kind: "workflow", id: "missing-agent-context" },
      source: { mode: "blank" }
    });
    const file = draft.files.find((candidate) =>
      candidate.file.path.endsWith("workflow.yaml")
    )?.file;
    if (file === undefined) throw new Error("Expected workflow definition");

    const edited = await service.editSource(
      draft.draft_id,
      {
        file,
        operations: [
          { op: "sequence_insert", path: ["capabilities"], value: "agents" },
          {
            op: "sequence_insert",
            path: ["nodes"],
            value: {
              id: "execute",
              type: "agent",
              agent: "context-agent",
              output_schema: "output.schema.json"
            }
          }
        ]
      },
      draft.etag
    );
    const result = await service.compile(edited.draft_id, edited.etag);

    expect(result.validation).toMatchObject({ status: "invalid", compiled: true });
    expect(result.validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "workflow_agent_context_missing",
        field_path: "$.nodes[0].input.context"
      })
    );
  });

  it.each<{
    readonly label: string;
    readonly expectedCode: string;
    readonly operations: readonly StudioYamlSourceOperation[];
  }>([
    {
      label: "cyclic DAG",
      expectedCode: "workflow_cycle_detected",
      operations: [
        { op: "sequence_insert", path: ["capabilities"], value: "runtime" },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "first",
            type: "built_in",
            uses: "runtime.preflight",
            after: ["second"]
          }
        },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "second",
            type: "built_in",
            uses: "runtime.preflight",
            after: ["first"]
          }
        }
      ]
    },
    {
      label: "side effect without policy",
      expectedCode: "workflow_side_effect_policy_missing",
      operations: [
        {
          op: "sequence_insert",
          path: ["capabilities"],
          value: "repository-workspace"
        },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "workspace",
            type: "built_in",
            uses: "repository-workspace.capture"
          }
        }
      ]
    },
    {
      label: "gate outside a pattern",
      expectedCode: "workflow_unknown_field",
      operations: [
        { op: "sequence_insert", path: ["capabilities"], value: "runtime" },
        { op: "sequence_insert", path: ["capabilities"], value: "hitl" },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "preflight",
            type: "built_in",
            uses: "runtime.preflight",
            gates: [{ id: "approval", type: "hitl.approval" }]
          }
        }
      ]
    }
  ])("keeps $label editable but reports canonical validation", async ({
    expectedCode,
    operations
  }) => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "workflow", id: `invalid-${expectedCode}` },
      source: { mode: "blank" }
    });
    const file = draft.files.find((candidate) =>
      candidate.file.path.endsWith("workflow.yaml")
    )?.file;
    if (file === undefined) {
      throw new Error("Expected workflow definition in blank draft");
    }

    const edited = await service.editSource(
      draft.draft_id,
      { file, operations: [...operations] },
      draft.etag
    );
    const result = await service.compile(edited.draft_id, edited.etag);

    expect(result.validation).toMatchObject({ status: "invalid", compiled: true });
    expect(result.validation.diagnostics).toContainEqual(
      expect.objectContaining({ code: expectedCode })
    );
  });

  it("generates a blank agent accepted by the canonical loader", async () => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "agent", id: "blank-agent" },
      source: { mode: "blank", model_profile: "fast" }
    });

    const validated = await service.validate(draft.draft_id, draft.etag);

    expect(validated.validation).toMatchObject({
      status: "valid",
      compiled: false,
      resources: [
        {
          resource: { kind: "agent", id: "blank-agent" },
          status: "valid"
        }
      ]
    });
  });

  it("expands agent dependencies after a blank workflow is edited", async () => {
    const { service, projectRoot, drafts } = await nativeFixture();
    await installAgent(projectRoot, "installed-agent");
    const draft = await service.create({
      resource: { kind: "workflow", id: "agent-workflow" },
      source: { mode: "blank" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected workflow definition in draft projection");
    }

    const updated = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: workflowWithAgent("agent-workflow", "installed-agent")
          }
        ]
      },
      draft.etag
    );
    const persisted = await drafts.get(draft.draft_id);

    expect(
      persisted?.dependencies.map((dependency) => dependency.file.path)
    ).toEqual([
      "models.yaml",
      "agents/installed-agent/agent.yaml",
      "agents/installed-agent/instructions.md",
      "agents/installed-agent/output.schema.json"
    ]);
    await expect(
      service.compile(updated.draft_id, updated.etag)
    ).resolves.toMatchObject({
      validation: { status: "valid", compiled: true }
    });
  });
});
