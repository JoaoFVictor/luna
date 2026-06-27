import { describe, expect, it } from "vitest";
import { manifest } from "../../../src/capabilities/runtime/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";

describe("runtime capability", () => {
  it("keeps implementation commit and push lifecycle separate from git write side effects", () => {
    const registry = createCapabilityRegistry([manifest]);
    const runtime = registry.get("runtime");

    expect(runtime.built_ins?.["runtime.prepare_commit"]).toMatchObject({
      id: "runtime.prepare_commit"
    });
    expect(runtime.built_ins?.["runtime.record_commit_lifecycle"]).toMatchObject({
      id: "runtime.record_commit_lifecycle"
    });
    expect(runtime.built_ins?.["runtime.prepare_push"]).toMatchObject({
      id: "runtime.prepare_push"
    });
    expect(runtime.built_ins?.["runtime.record_push_lifecycle"]).toMatchObject({
      id: "runtime.record_push_lifecycle"
    });
    expect(runtime.built_ins?.["runtime.prepare_commit"]).not.toHaveProperty(
      "side_effect_policy"
    );
    expect(runtime.built_ins?.["runtime.prepare_push"]).not.toHaveProperty(
      "side_effect_policy"
    );
    expect(runtime.policies).toBeUndefined();
  });
});
