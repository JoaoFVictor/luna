import { describe, expect, it } from "vitest";
import { projectConfiguredWorkflowRuntimeNodes } from "../../src/core/configured-workflow/runtime-node.js";
import type { WorkflowDefinition } from "../../src/core/workflow/definition-types.js";

describe("configured workflow runtime node projection", () => {
  it("keeps capability-native git built-ins instead of projecting them to legacy runtime names", () => {
    const nodes = projectConfiguredWorkflowRuntimeNodes({
      graph: {
        nodes: [
          {
            id: "commit",
            type: "built_in",
            uses: "git.commit"
          }
        ]
      }
    } as WorkflowDefinition);

    expect(nodes).toEqual([
      {
        id: "commit",
        type: "built_in",
        uses: "git.commit"
      }
    ]);
  });
});
