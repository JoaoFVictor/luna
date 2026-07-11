import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { applyYamlSourceOperations } from "../../src/studio/application/authoring/index.js";

describe("Studio YAML structural editor", () => {
  it("applies a batch while preserving every byte outside edited ranges", () => {
    const source = [
      "id: sample",
      "type: workflow",
      "nodes:",
      "  # first node comment stays here",
      "  - id: context # inline id comment is untouched",
      "    type: built_in",
      "    uses: context.collect_context",
      "    after:",
      "      - bootstrap",
      "  # tail comment stays here",
      "tail: byte-identical # outside nodes",
      ""
    ].join("\n");

    const result = applyYamlSourceOperations({
      source,
      operations: [
        {
          op: "set",
          path: ["nodes", 0, "uses"],
          value: "runtime.preflight"
        },
        {
          op: "set",
          path: ["nodes", 0, "input"],
          value: { invocation: { expression: "$.invocation" } }
        },
        { op: "delete", path: ["nodes", 0, "after"] },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "report",
            type: "built_in",
            uses: "reports.final_report",
            after: ["context"]
          }
        }
      ]
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe([
      "id: sample",
      "type: workflow",
      "nodes:",
      "  # first node comment stays here",
      "  - id: context # inline id comment is untouched",
      "    type: built_in",
      "    uses: runtime.preflight",
      "    input:",
      "      invocation:",
      "        expression: $.invocation",
      "  - id: report",
      "    type: built_in",
      "    uses: reports.final_report",
      "    after:",
      "      - context",
      "  # tail comment stays here",
      "tail: byte-identical # outside nodes",
      ""
    ].join("\n"));
  });

  it("supports root agent fields and flow sequences without prototype mutation", () => {
    const source = "id: helper\nskills: [one]\nmode: read_only\n";
    const result = applyYamlSourceOperations({
      source,
      operations: [
        { op: "set", path: ["description"], value: "Reusable helper" },
        {
          op: "sequence_insert",
          path: ["skills"],
          index: 1,
          value: "two"
        },
        { op: "set", path: ["__proto__"], value: { polluted: true } },
        { op: "delete", path: ["mode"] }
      ]
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(YAML.parse(result.source)).toMatchObject({
      id: "helper",
      skills: ["one", "two"],
      description: "Reusable helper"
    });
    expect(Object.getOwnPropertyDescriptor(YAML.parse(result.source), "__proto__")?.value)
      .toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("removes a block sequence item without reformatting its siblings", () => {
    const source = [
      "nodes:",
      "  - id: first # keep exact",
      "    type: built_in",
      "  # comment between items survives",
      "  - id: second",
      "    type: agent",
      "  - id: third # keep exact",
      "    type: pattern",
      ""
    ].join("\n");
    const result = applyYamlSourceOperations({
      source,
      operations: [{ op: "sequence_remove", path: ["nodes"], index: 1 }]
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe([
      "nodes:",
      "  - id: first # keep exact",
      "    type: built_in",
      "  # comment between items survives",
      "  - id: third # keep exact",
      "    type: pattern",
      ""
    ].join("\n"));
  });

  it("is atomic when a later operation is invalid", () => {
    const source = "nodes: []\nmode: read_only\n";
    const result = applyYamlSourceOperations({
      source,
      operations: [
        { op: "set", path: ["mode"], value: "trusted_local_write" },
        { op: "sequence_remove", path: ["nodes"], index: 1 }
      ]
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      source,
      operationIndex: 1,
      diagnostics: [{ code: "yaml_operation_invalid" }]
    });
  });

  it("fails closed instead of mutating values shared through YAML anchors", () => {
    const source = [
      "defaults: &defaults",
      "  retries: 2",
      "worker:",
      "  config: *defaults",
      ""
    ].join("\n");
    const result = applyYamlSourceOperations({
      source,
      operations: [{ op: "set", path: ["defaults", "retries"], value: 3 }]
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      source,
      diagnostics: [{ code: "yaml_target_unsafe" }]
    });
  });
});
