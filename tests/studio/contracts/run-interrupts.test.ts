import { describe, expect, it } from "vitest";
import {
  StudioRunInterruptListQuerySchema,
  StudioRunInterruptResumeRequestSchema
} from "../../../src/studio/contracts/run-interrupts.js";

describe("StudioRunInterruptResumeRequestSchema", () => {
  it("defaults interrupt history pages to 50 and caps them at 200", () => {
    expect(StudioRunInterruptListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(StudioRunInterruptListQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
  it("accepts a bounded change request with feedback and targets", () => {
    expect(StudioRunInterruptResumeRequestSchema.parse({
      action: "request_changes",
      comment: "Use a shorter title",
      targets: ["text"]
    })).toEqual({
      action: "request_changes",
      comment: "Use a shorter title",
      targets: ["text"]
    });
  });

  it("returns a discriminated decision without compatibility approval flags", () => {
    expect(StudioRunInterruptResumeRequestSchema.parse({ action: "approve" })).toEqual({
      action: "approve"
    });
    expect(StudioRunInterruptResumeRequestSchema.safeParse({
      action: "approve",
      approved: true
    }).success).toBe(false);
  });

  it.each([
    { action: "request_changes", targets: ["text"] },
    { action: "request_changes", comment: "Change it" },
    { action: "request_changes", comment: "Change it", targets: ["text", "text"] },
    { action: "approve", targets: ["text"] },
    { action: "request_changes", comment: "Change it", targets: [], approved: false },
    { action: "revise", comment: "Change it", targets: ["text"] }
  ])("rejects an invalid review decision %#", (input) => {
    expect(StudioRunInterruptResumeRequestSchema.safeParse(input).success).toBe(false);
  });
});
