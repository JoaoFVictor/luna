import { describe, expect, it } from "vitest"

import {
  parseWorkflowSchema,
  workflowSchemaProperties,
  workflowSchemaRequired,
  workflowSchemaWithProperties,
} from "@/features/workflows/workflow-schema-model"

describe("workflow schema model", () => {
  it("preserves unsupported keywords while builder fields change", () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string", minLength: 3 } },
      required: ["title"],
      allOf: [{ $ref: "#/$defs/shared" }],
      $defs: { shared: { type: "object" } },
    }

    const next = workflowSchemaWithProperties(
      schema,
      { ...workflowSchemaProperties(schema), count: { type: "integer" } },
      workflowSchemaRequired(schema),
    )

    expect(next).toMatchObject({
      allOf: [{ $ref: "#/$defs/shared" }],
      $defs: { shared: { type: "object" } },
      properties: {
        title: { type: "string", minLength: 3 },
        count: { type: "integer" },
      },
      required: ["title"],
    })
  })

  it("removes a stale required array when no property remains required", () => {
    const next = workflowSchemaWithProperties(
      { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      { title: { type: "string" } },
      new Set(),
    )

    expect(next).not.toHaveProperty("required")
  })

  it("keeps invalid raw JSON recoverable instead of fabricating a schema", () => {
    expect(parseWorkflowSchema("{ invalid")).toEqual({
      error: expect.any(String),
    })
  })
})
