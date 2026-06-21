import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  codedError,
  parsePayload,
  payloadObject,
  requireReferences,
  requireRepository,
  requireSubject,
  requireTarget
} from "../../src/core/invocation/helpers.js";
import type { NormalizedInvocation } from "../../src/core/invocation/types.js";

const invocation: NormalizedInvocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  target: {
    type: "workflow",
    id: "code-review"
  },
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42",
    title: "Add enterprise adapters"
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: {
    pull_request: {
      number: 42
    }
  }
};

describe("invocation helpers", () => {
  it("creates coded errors", () => {
    expect(codedError("Broken", "example_code")).toMatchObject({
      message: "Broken",
      code: "example_code"
    });
  });

  it("requires repository, subject, target, and references", () => {
    expect(requireRepository(invocation)).toEqual(invocation.repository);
    expect(requireSubject(invocation, "pull_request")).toEqual(invocation.subject);
    expect(requireTarget(invocation)).toEqual(invocation.target);
    expect(requireReferences(invocation, ["base_sha", "head_sha"])).toEqual({
      base_sha: "abc123",
      head_sha: "def456"
    });
  });

  it("throws coded errors for missing invocation fields", () => {
    expect(() =>
      requireRepository({ ...invocation, repository: undefined })
    ).toThrow(expect.objectContaining({ code: "invocation_repository_missing" }));

    expect(() =>
      requireSubject({ ...invocation, subject: undefined })
    ).toThrow(expect.objectContaining({ code: "invocation_subject_missing" }));

    expect(() =>
      requireTarget({ ...invocation, target: undefined })
    ).toThrow(expect.objectContaining({ code: "invocation_target_missing" }));

    expect(() =>
      requireReferences({ ...invocation, references: {} }, ["base_sha"])
    ).toThrow(expect.objectContaining({ code: "invocation_reference_missing" }));
  });

  it("throws when subject type does not match the expected type", () => {
    expect(() =>
      requireSubject(invocation, "jira_issue")
    ).toThrow(expect.objectContaining({ code: "invocation_subject_invalid" }));
  });

  it("returns object payloads and rejects missing or non-object payloads", () => {
    expect(payloadObject(invocation, "pull_request")).toEqual({ number: 42 });

    expect(() =>
      payloadObject({ ...invocation, payload: undefined }, "pull_request")
    ).toThrow(expect.objectContaining({ code: "invocation_payload_missing" }));

    expect(() =>
      payloadObject({ ...invocation, payload: { pull_request: null } }, "pull_request")
    ).toThrow(expect.objectContaining({ code: "invocation_payload_missing" }));

    expect(() =>
      payloadObject({ ...invocation, payload: { pull_request: [] } }, "pull_request")
    ).toThrow(expect.objectContaining({ code: "invocation_payload_missing" }));
  });

  it("parses payloads with Zod and maps validation failures to the supplied code", () => {
    const schema = z.object({ number: z.number().int().positive() }).strict();

    expect(parsePayload(invocation, "pull_request", schema, "pr_payload_invalid")).toEqual({
      number: 42
    });

    expect(() =>
      parsePayload(
        { ...invocation, payload: { pull_request: { number: 0 } } },
        "pull_request",
        schema,
        "pr_payload_invalid"
      )
    ).toThrow(expect.objectContaining({ code: "pr_payload_invalid" }));
  });
});
