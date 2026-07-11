import { describe, expect, it, vi } from "vitest";
import { NativeStudioDefinitionValidation } from "../../../src/studio/adapters/native/definition-validation.js";
import { NativeStudioInstalledApplyVerifier } from "../../../src/studio/adapters/native/installed-apply-verifier.js";
import { studioApplyValueDigest } from "../../../src/studio/application/apply/digests.js";

describe("NativeStudioInstalledApplyVerifier", () => {
  it("reloads every installed resource through canonical validation with compile enabled", async () => {
    const definitions = new NativeStudioDefinitionValidation();
    const workflowRevision = studioApplyValueDigest({ workflow: "demo" });
    const agentRevision = studioApplyValueDigest({ agent: "helper" });
    const validate = vi
      .spyOn(definitions, "validate")
      .mockImplementation(async ({ resource }) => ({
        revision:
          resource.kind === "workflow" ? workflowRevision : agentRevision
      }));
    const verifier = new NativeStudioInstalledApplyVerifier({
      projectRoot: "/tmp/luna-studio-project",
      configRoot: "/tmp/luna-studio-config",
      definitions
    });

    await expect(
      verifier.verify({
        resources: [
          { kind: "workflow", id: "demo" },
          { kind: "agent", id: "helper" }
        ],
        expectedResourceRevisions: {
          "workflow:demo": workflowRevision,
          "agent:helper": agentRevision
        },
        technicalCatalogFingerprint: studioApplyValueDigest({ catalog: true }),
        compilerContractVersion: "test-v1"
      })
    ).resolves.toEqual({
      "workflow:demo": workflowRevision,
      "agent:helper": agentRevision
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.calls.every(([input]) => input.compile)).toBe(true);
  });
});

