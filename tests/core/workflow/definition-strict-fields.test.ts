import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { loadWorkflowDefinition } from "../../../src/core/workflow/definition.js";

const fixtures = path.join(process.cwd(), "tests/fixtures/workflows");

function registry() {
  return createCapabilityRegistry([context, reports, artifacts]);
}

async function copyWorkflowFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflows-"));
  await cp(path.join(fixtures, name), path.join(root, name), { recursive: true });
  return root;
}

async function patchWorkflow(
  root: string,
  workflowId: string,
  edit: (yaml: string) => string
): Promise<void> {
  const file = path.join(root, workflowId, "workflow.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

describe("strict workflow field validation", () => {
  it("rejects invalid artifact format and required values", async () => {
    const invalidFormatRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(invalidFormatRoot, "minimum", (yaml) =>
      yaml.replace("format: json", "format: yaml")
    );
    await expect(loadWorkflowDefinition(invalidFormatRoot, "minimum", {
      capabilityRegistry: registry()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].artifacts[0].format"
    });

    const invalidRequiredRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(invalidRequiredRoot, "minimum", (yaml) =>
      yaml.replace("format: json", "required: nope\n        format: json")
    );
    await expect(loadWorkflowDefinition(invalidRequiredRoot, "minimum", {
      capabilityRegistry: registry()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].artifacts[0].required"
    });
  });

  it("rejects stale context.collect_context input fields not accepted by runtime", async () => {
    const root = await copyWorkflowFixture("minimum");
    await patchWorkflow(root, "minimum", (yaml) =>
      yaml.replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    input:\n      agent_id: reviewer"
      )
    );

    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "context.collect_context",
      path: "$.nodes[0].input"
    });
  });
});
