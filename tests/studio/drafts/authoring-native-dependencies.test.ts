import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installAgent,
  JSON_SCHEMA,
  nativeFixture,
  workflowWithAgent
} from "./authoring-native-test-support.js";

describe("native Studio draft dependency authoring", () => {
  it("adds a composed workflow closure and validates the draft", async () => {
    const { service, projectRoot, drafts } = await nativeFixture();
    const childDirectory = path.join(projectRoot, "workflows", "child-flow");
    const grandchildDirectory = path.join(
      projectRoot,
      "workflows",
      "grandchild-flow"
    );
    await Promise.all([
      mkdir(childDirectory, { recursive: true }),
      mkdir(grandchildDirectory, { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        path.join(childDirectory, "workflow.yaml"),
        [
          "id: child-flow",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities: []",
          "nodes:",
          "  - id: grandchild",
          "    type: workflow",
          "    workflow: grandchild-flow",
          "    input: {}",
          ""
        ].join("\n"),
        "utf8"
      ),
      writeFile(path.join(childDirectory, "input.schema.json"), JSON_SCHEMA, "utf8"),
      writeFile(path.join(childDirectory, "output.schema.json"), JSON_SCHEMA, "utf8"),
      writeFile(
        path.join(grandchildDirectory, "workflow.yaml"),
        [
          "id: grandchild-flow",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities: []",
          "nodes: []",
          ""
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        path.join(grandchildDirectory, "input.schema.json"),
        JSON_SCHEMA,
        "utf8"
      ),
      writeFile(
        path.join(grandchildDirectory, "output.schema.json"),
        JSON_SCHEMA,
        "utf8"
      )
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "parent-flow" },
      source: { mode: "blank" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) throw new Error("Expected workflow definition");

    const updated = await service.patch(
      draft.draft_id,
      {
        edits: [{
          action: "write",
          file: definition.file,
          content: [
            "id: parent-flow",
            "type: workflow",
            "mode: read_only",
            "input_schema: input.schema.json",
            "output_schema: output.schema.json",
            "capabilities: []",
            "nodes:",
            "  - id: child",
            "    type: workflow",
            "    workflow: child-flow",
            "    input: {}",
            ""
          ].join("\n")
        }]
      },
      draft.etag
    );

    expect(
      (await drafts.get(draft.draft_id))?.dependencies.map(
        (dependency) => dependency.file.path
      )
    ).toEqual([
      "workflows/child-flow/input.schema.json",
      "workflows/child-flow/output.schema.json",
      "workflows/child-flow/workflow.yaml",
      "workflows/grandchild-flow/input.schema.json",
      "workflows/grandchild-flow/output.schema.json",
      "workflows/grandchild-flow/workflow.yaml"
    ]);
    await expect(service.validate(updated.draft_id, updated.etag)).resolves.toMatchObject({
      validation: { status: "valid" }
    });
  });

  it("replaces and removes agent dependency guards with the definition", async () => {
    const { service, projectRoot, drafts } = await nativeFixture();
    await Promise.all([
      installAgent(projectRoot, "agent-a"),
      installAgent(projectRoot, "agent-b")
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "switch-agent" },
      source: { mode: "blank" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected workflow definition in draft projection");
    }
    const withA = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: workflowWithAgent("switch-agent", "agent-a")
          }
        ]
      },
      draft.etag
    );
    expect(
      (await drafts.get(draft.draft_id))?.dependencies.map(
        (dependency) => dependency.file.path
      )
    ).toEqual([
      "models.yaml",
      "agents/agent-a/agent.yaml",
      "agents/agent-a/instructions.md",
      "agents/agent-a/output.schema.json"
    ]);

    const withB = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: workflowWithAgent("switch-agent", "agent-b")
          }
        ]
      },
      withA.etag
    );
    expect(
      (await drafts.get(draft.draft_id))?.dependencies.map(
        (dependency) => dependency.file.path
      )
    ).toEqual([
      "models.yaml",
      "agents/agent-b/agent.yaml",
      "agents/agent-b/instructions.md",
      "agents/agent-b/output.schema.json"
    ]);

    await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: [
              "id: switch-agent",
              "type: workflow",
              "mode: read_only",
              "input_schema: input.schema.json",
              "output_schema: output.schema.json",
              "capabilities: []",
              "nodes: []",
              ""
            ].join("\n")
          }
        ]
      },
      withB.etag
    );
    expect((await drafts.get(draft.draft_id))?.dependencies).toEqual([]);
  });

  it("does not silently adopt an external change to a retained dependency", async () => {
    const { service, projectRoot, drafts } = await nativeFixture();
    await installAgent(projectRoot, "guarded-agent");
    const workflowDirectory = path.join(
      projectRoot,
      "workflows",
      "guarded-workflow"
    );
    await mkdir(workflowDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(workflowDirectory, "workflow.yaml"),
        workflowWithAgent("guarded-workflow", "guarded-agent"),
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "input.schema.json"),
        JSON_SCHEMA,
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "output.schema.json"),
        JSON_SCHEMA,
        "utf8"
      )
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "guarded-workflow" },
      source: { mode: "existing" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    const before = (await drafts.get(draft.draft_id))?.dependencies.find(
      (dependency) => dependency.file.path.endsWith("instructions.md")
    );
    if (definition?.content === undefined || before === undefined) {
      throw new Error("Expected definition and dependency guard");
    }

    await writeFile(
      path.join(projectRoot, "agents", "guarded-agent", "instructions.md"),
      "Changed outside the Studio.\n",
      "utf8"
    );
    const updated = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: `${definition.content}# Studio-only comment\n`
          }
        ]
      },
      draft.etag
    );
    const after = (await drafts.get(draft.draft_id))?.dependencies.find(
      (dependency) => dependency.file.path.endsWith("instructions.md")
    );

    expect(after?.sha256).toBe(before.sha256);
    await expect(
      service.compile(updated.draft_id, updated.etag)
    ).rejects.toMatchObject({ code: "studio_snapshot_source_conflict" });
  });

  it("adds, swaps, guards, and rejects removal of a dirty config schema", async () => {
    const { service, configRoot, drafts } = await nativeFixture();
    const configDirectory = path.join(configRoot, "workflows");
    await mkdir(configDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(configDirectory, "config-a.json"), "{}\n", "utf8"),
      writeFile(path.join(configDirectory, "config-b.json"), "{}\n", "utf8")
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "config-closure" },
      source: { mode: "blank" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected workflow definition in draft projection");
    }
    const withConfigA = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: [
              "id: config-closure",
              "type: workflow",
              "mode: read_only",
              "input_schema: input.schema.json",
              "output_schema: output.schema.json",
              "config:",
              "  file: workflows/config-a.json",
              "  schema: config.schema.json",
              "capabilities: []",
              "nodes: []",
              ""
            ].join("\n")
          },
          {
            action: "write",
            file: {
              root: "project",
              path: "workflows/config-closure/config.schema.json"
            },
            content: JSON_SCHEMA
          }
        ]
      },
      draft.etag
    );
    expect((await drafts.get(draft.draft_id))?.dependencies).toEqual([
      expect.objectContaining({
        file: { root: "config", path: "workflows/config-a.json" }
      })
    ]);

    const withConfigB = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: [
              "id: config-closure",
              "type: workflow",
              "mode: read_only",
              "input_schema: input.schema.json",
              "output_schema: output.schema.json",
              "config:",
              "  file: workflows/config-b.json",
              "  schema: config.schema.json",
              "capabilities: []",
              "nodes: []",
              ""
            ].join("\n")
          }
        ]
      },
      withConfigA.etag
    );
    const guardB = (await drafts.get(draft.draft_id))?.dependencies[0];
    expect(guardB?.file).toEqual({
      root: "config",
      path: "workflows/config-b.json"
    });

    await writeFile(
      path.join(configDirectory, "config-b.json"),
      '{"changed":true}\n',
      "utf8"
    );
    const withComment = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: `${
              withConfigB.files.find((file) =>
                file.file.path.endsWith("workflow.yaml")
              )?.content ?? ""
            }# retained guard\n`
          }
        ]
      },
      withConfigB.etag
    );
    expect((await drafts.get(draft.draft_id))?.dependencies[0]?.sha256).toBe(
      guardB?.sha256
    );
    await expect(
      service.compile(withComment.draft_id, withComment.etag)
    ).rejects.toMatchObject({ code: "studio_snapshot_source_conflict" });

    const beforeRemoval = await drafts.get(draft.draft_id);
    await expect(
      service.patch(
        draft.draft_id,
        {
          edits: [
            {
              action: "write",
              file: definition.file,
              content: [
                "id: config-closure",
                "type: workflow",
                "mode: read_only",
                "input_schema: input.schema.json",
                "output_schema: output.schema.json",
                "capabilities: []",
                "nodes: []",
                ""
              ].join("\n")
            }
          ]
        },
        withComment.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_dirty_file_conflict",
      details: {
        file: {
          root: "project",
          path: "workflows/config-closure/config.schema.json"
        },
        fieldPath: "$.edits[0].content"
      }
    });
    expect(await drafts.get(draft.draft_id)).toEqual(beforeRemoval);
  });

  it("authorizes new schema paths atomically with a canonical definition edit", async () => {
    const { service, drafts, projectRoot } = await nativeFixture();
    const workflowDirectory = path.join(projectRoot, "workflows", "schema-path");
    await mkdir(workflowDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(workflowDirectory, "workflow.yaml"),
        [
          "id: schema-path",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities: []",
          "nodes: []",
          ""
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "input.schema.json"),
        JSON_SCHEMA,
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "output.schema.json"),
        JSON_SCHEMA,
        "utf8"
      )
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "schema-path" },
      source: { mode: "existing" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected workflow definition in draft projection");
    }
    const requestSchema = {
      root: "project" as const,
      path: "workflows/schema-path/request.schema.json"
    };
    const updated = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: [
              "id: schema-path",
              "type: workflow",
              "mode: read_only",
              "input_schema: request.schema.json",
              "output_schema: output.schema.json",
              "capabilities: []",
              "nodes: []",
              ""
            ].join("\n")
          },
          { action: "write", file: requestSchema, content: JSON_SCHEMA }
        ]
      },
      draft.etag
    );
    const persisted = await drafts.get(draft.draft_id);

    expect(persisted?.allowed_files.map((file) => file.path)).toEqual([
      "workflows/schema-path/output.schema.json",
      "workflows/schema-path/request.schema.json",
      "workflows/schema-path/workflow.yaml"
    ]);
    expect(
      persisted?.changes.some((change) =>
        change.file.path.endsWith("input.schema.json")
      )
    ).toBe(false);
    await expect(
      service.compile(updated.draft_id, updated.etag)
    ).resolves.toMatchObject({
      validation: { status: "valid", compiled: true }
    });
  });

  it("deduplicates identical base and mutation blobs in one patch", async () => {
    const { service, projectRoot } = await nativeFixture();
    const workflowDirectory = path.join(
      projectRoot,
      "workflows",
      "shared-blob"
    );
    await mkdir(workflowDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(workflowDirectory, "workflow.yaml"),
        [
          "id: shared-blob",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities: []",
          "nodes: []",
          ""
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "input.schema.json"),
        JSON_SCHEMA,
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "output.schema.json"),
        '{"type":"array"}\n',
        "utf8"
      ),
      writeFile(
        path.join(workflowDirectory, "request.schema.json"),
        JSON_SCHEMA,
        "utf8"
      )
    ]);
    const draft = await service.create({
      resource: { kind: "workflow", id: "shared-blob" },
      source: { mode: "existing" }
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
            content: [
              "id: shared-blob",
              "type: workflow",
              "mode: read_only",
              "input_schema: request.schema.json",
              "output_schema: output.schema.json",
              "capabilities: []",
              "nodes: []",
              ""
            ].join("\n")
          },
          {
            action: "write",
            file: {
              root: "project",
              path: "workflows/shared-blob/output.schema.json"
            },
            content: JSON_SCHEMA
          }
        ]
      },
      draft.etag
    );

    await expect(
      service.compile(updated.draft_id, updated.etag)
    ).resolves.toMatchObject({
      validation: { status: "valid", compiled: true }
    });
  });

  it("keeps the previous authority while YAML is temporarily invalid", async () => {
    const { service } = await nativeFixture();
    const draft = await service.create({
      resource: { kind: "workflow", id: "invalid-between-edits" },
      source: { mode: "blank" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("workflow.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected workflow definition in draft projection");
    }
    await expect(
      service.patch(
        draft.draft_id,
        {
          edits: [
            {
              action: "write",
              file: definition.file,
              content: "input_schema: [temporarily invalid\n"
            },
            {
              action: "write",
              file: {
                root: "project",
                path: "workflows/invalid-between-edits/untrusted.schema.json"
              },
              content: JSON_SCHEMA
            }
          ]
        },
        draft.etag
      )
    ).rejects.toMatchObject({
      code: "studio_draft_authoring_file_not_editable"
    });

    const invalid = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: "input_schema: [temporarily invalid\n"
          }
        ]
      },
      draft.etag
    );
    const input = invalid.files.find((file) =>
      file.file.path.endsWith("input.schema.json")
    );
    if (input === undefined) {
      throw new Error("Expected original input schema authority to remain");
    }
    await expect(
      service.patch(
        invalid.draft_id,
        {
          edits: [
            { action: "write", file: input.file, content: '{"type":"string"}\n' }
          ]
        },
        invalid.etag
      )
    ).resolves.toMatchObject({ content_revision: 3 });
  });

  it("changes agent instruction and schema paths in the same patch", async () => {
    const { service, drafts, projectRoot } = await nativeFixture();
    await installAgent(projectRoot, "path-agent");
    const draft = await service.create({
      resource: { kind: "agent", id: "path-agent" },
      source: { mode: "existing" }
    });
    const definition = draft.files.find((file) =>
      file.file.path.endsWith("agent.yaml")
    );
    if (definition === undefined) {
      throw new Error("Expected agent definition in draft projection");
    }
    const updated = await service.patch(
      draft.draft_id,
      {
        edits: [
          {
            action: "write",
            file: definition.file,
            content: [
              "id: path-agent",
              "description: Agent with custom paths.",
              "model_profile: fast",
              "mode: read_only",
              "instructions_file: prompt.md",
              "output_schema: result.json",
              ""
            ].join("\n")
          },
          {
            action: "write",
            file: { root: "project", path: "agents/path-agent/prompt.md" },
            content: "Return structured output.\n"
          },
          {
            action: "write",
            file: { root: "project", path: "agents/path-agent/result.json" },
            content: JSON_SCHEMA
          }
        ]
      },
      draft.etag
    );
    expect(
      (await drafts.get(draft.draft_id))?.allowed_files.map((file) => file.path)
    ).toEqual([
      "agents/path-agent/agent.yaml",
      "agents/path-agent/prompt.md",
      "agents/path-agent/result.json"
    ]);
    await expect(
      service.validate(updated.draft_id, updated.etag)
    ).resolves.toMatchObject({ validation: { status: "valid" } });
  });
});
