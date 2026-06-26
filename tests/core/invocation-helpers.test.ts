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
import {
  InvocationSchema,
  type NormalizedInvocation
} from "../../src/core/router/invocation.js";
import { RunIdentitySchema } from "../../src/core/invocation/types.js";

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

const validInvocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42"
  },
  references: {
    base_ref: "main",
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: {
    pull_request: {
      number: 42
    }
  }
};

const validRunIdentity = {
  run_id:
    "20260618t150405123z-code-review-github-pull-request-octo-org-hello-world-pull-request-42-a1-abcdef123456-n9x8",
  runtime_run_id: "runtime-run-abcdef123456",
  workflow_id: "code-review",
  attempt: 1,
  source: "github",
  event: "pull_request",
  action: "selected",
  route_target: { type: "workflow", id: "code-review" },
  subject: { type: "pull_request", id: "42" },
  started_at: "2026-06-18T15:04:05.123Z"
};

describe("invocation helpers", () => {
  it("accepts a valid normalized GitHub PR invocation", () => {
    expect(InvocationSchema.parse(validInvocation)).toEqual(validInvocation);
  });

  it("accepts optional subject url and normalized actor fields", () => {
    const parsed = InvocationSchema.parse({
      ...validInvocation,
      subject: {
        type: "pull_request",
        id: "42",
        title: "Review normalized input adapters"
      },
      actor: {
        id: "123",
        display_name: "Mona Octocat"
      }
    });

    expect(parsed).toMatchObject({
      subject: { title: "Review normalized input adapters" },
      actor: { id: "123", display_name: "Mona Octocat" }
    });
  });

  it("rejects legacy or invalid invocation shapes", () => {
    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        actor: {
          type: "user",
          login: "octocat",
          name: "Mona Octocat",
          email: "mona@example.com"
        }
      })
    ).toThrow();

    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        references: {
          base_ref: "main",
          pull_number: 42
        }
      })
    ).toThrow();

    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        payload: {
          "": {
            number: 42
          }
        }
      })
    ).toThrow();

    expect(() =>
      InvocationSchema.parse({
        target: "github_pr",
        owner: "octo-org",
        repo: "hello-world",
        pull_number: 42
      })
    ).toThrow();

    expect(() =>
      InvocationSchema.parse({
        ...validInvocation,
        workflow: "code-review"
      })
    ).toThrow();
  });

  it("accepts and requires the explicit run identity contract fields", () => {
    expect(RunIdentitySchema.parse(validRunIdentity)).toEqual(validRunIdentity);

    expect(() =>
      RunIdentitySchema.parse({
        run_id:
          "20260618t150405z-github-pull-request-octo-org-hello-world-pull-request-42-a1",
        attempt: 1,
        source: "github",
        event: "pull_request"
      })
    ).toThrow();
  });

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
