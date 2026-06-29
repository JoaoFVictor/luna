import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import { InvocationSchema } from "../../../src/core/router/invocation.js";
import {
  createPlaneWebhookAdapter,
  normalizePlaneWebhook,
  planeWebhookAdapterFactory,
  verifyPlaneWebhookSignature
} from "../../../src/providers/plane/webhook-adapter.js";
import type { WebhookAdapterInput } from "../../../src/webhooks/contracts.js";

const receivedAt = "2026-06-28T12:00:00.000Z";

function signature(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return undefined;
}

function issuePayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    issue: {
      id: "issue-1",
      url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
      name: "Implement webhooks",
      sequence_id: 42,
      description_stripped: "Wire webhook ingress.",
      state: { name: "Backlog" },
      priority: "high",
      labels: [{ name: "github:org/repo" }]
    },
    workspace: {
      slug: "acme"
    },
    project: {
      slug: "proj"
    },
    ...overrides
  };
}

function documentedIssuePayload(
  action: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    event: "issue",
    action,
    workspace_id: "workspace-1",
    data: {
      id: "issue-1",
      url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
      name: "Implement webhooks",
      project_id: "project-1",
      sequence_id: 42,
      description_html: "<p>Wire webhook ingress.</p>",
      state: { name: "Backlog" },
      priority: "high",
      labels: [{ name: "github:org/repo" }],
      workspace_detail: {
        slug: "acme"
      },
      project_detail: {
        identifier: "PROJ"
      }
    },
    ...overrides
  };
}

function input(options: {
  event?: string;
  omitEventHeader?: boolean;
  deliveryId?: string;
  rawBody?: Buffer;
  body?: unknown;
  signatureHeader?: string;
} = {}): WebhookAdapterInput {
  const { event = "issue", rawBody, body, signatureHeader } = options;
  const payload = body ?? issuePayload("create");
  const encoded = rawBody ?? Buffer.from(JSON.stringify(payload));
  const deliveryId = "deliveryId" in options ? options.deliveryId : "delivery-1";
  const resolvedSignature =
    "signatureHeader" in options
      ? signatureHeader
      : signature("plane-secret", encoded);

  return {
    provider: "plane",
    headers: {
      ...(
        options.omitEventHeader === true
          ? {}
          : { "X-Plane-Event": event }
      ),
      "X-Plane-Delivery": deliveryId,
      "X-Plane-Signature": resolvedSignature
    },
    rawBody: encoded,
    body: payload,
    receivedAt
  };
}

describe("Plane webhook adapter signature verification", () => {
  it("accepts a valid HMAC-SHA256 hex signature over the raw body", () => {
    const body = issuePayload("create");
    const rawBody = Buffer.from(JSON.stringify(body));

    expect(signature("plane-secret", rawBody)).toBe(
      "bdae96dafe2560b2e1290022b117ccaee4b82f8e3ad2ac68858771de87c3cca7"
    );
    expect(() =>
      verifyPlaneWebhookSignature(
        input({
          rawBody,
          body,
          signatureHeader:
            "bdae96dafe2560b2e1290022b117ccaee4b82f8e3ad2ac68858771de87c3cca7"
        }),
        "plane-secret"
      )
    ).not.toThrow();
  });

  it("rejects a missing signature", () => {
    const error = captureError(() =>
      verifyPlaneWebhookSignature(input({ signatureHeader: undefined }), "plane-secret")
    );

    expect(error).toMatchObject({
      code: "webhook_signature_missing",
      statusCode: 401,
      message: "Plane webhook signature is missing"
    });
  });

  it("rejects an invalid signature", () => {
    const error = captureError(() =>
      verifyPlaneWebhookSignature(
        input({
          signatureHeader:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }),
        "plane-secret"
      )
    );

    expect(error).toMatchObject({
      code: "webhook_signature_invalid",
      statusCode: 401,
      message: "Plane webhook signature is invalid"
    });
  });
});

describe("Plane webhook adapter normalization", () => {
  it("accepts issue create and produces a valid invocation", () => {
    const result = normalizePlaneWebhook(input());

    expect(result).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        version: "2026-06",
        source: "plane",
        event: "issue",
        action: "create",
        repository: {
          provider: "github",
          owner: "org",
          name: "repo"
        },
        subject: {
          type: "plane_issue",
          id: "issue-1",
          url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
          title: "Implement webhooks"
        },
        payload: {
          plane: {
            instance_id: "acme",
            workspace_slug: "acme",
            project_id: "proj",
            issue_id: "issue-1",
            sequence_id: 42,
            description: "Wire webhook ingress.",
            status: "Backlog",
            priority: "high",
            labels: ["github:org/repo"],
            repository_hint_source: "label:github:org/repo"
          },
          raw: issuePayload("create")
        }
      }
    });

    if (result.kind !== "accepted") {
      throw new Error("Expected accepted result");
    }
    expect(InvocationSchema.parse(result.invocation)).toEqual(result.invocation);
    expect(result.invocation.payload?.raw).toEqual(issuePayload("create"));
  });

  it("accepts Plane's documented issue payload shape", () => {
    const payload = documentedIssuePayload("create");
    const result = normalizePlaneWebhook(input({ body: payload, omitEventHeader: true }));

    expect(result).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        version: "2026-06",
        source: "plane",
        event: "issue",
        action: "create",
        repository: {
          provider: "github",
          owner: "org",
          name: "repo"
        },
        subject: {
          type: "plane_issue",
          id: "issue-1",
          url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
          title: "Implement webhooks"
        },
        payload: {
          plane: {
            instance_id: "acme",
            workspace_slug: "acme",
            project_identifier: "PROJ",
            issue_identifier: 42,
            issue_id: "issue-1",
            sequence_id: 42,
            description: "Wire webhook ingress.",
            status: "Backlog",
            priority: "high",
            labels: ["github:org/repo"],
            repository_hint_source: "label:github:org/repo"
          },
          raw: payload
        }
      }
    });
  });

  it("accepts Plane's real webhook work item payload without a URL", () => {
    const payload = documentedIssuePayload("updated", {
      activity: {
        field: "state",
        old_value: "Todo",
        new_value: "In Progress"
      },
      data: {
        id: "issue-1",
        name: "Implement webhooks",
        project_id: "project-1",
        sequence_id: 42,
        description_html: "<p>Wire webhook ingress.</p>",
        state: { name: "In Progress" },
        priority: "high",
        labels: [{ name: "github:org/repo" }],
        workspace_detail: {
          slug: "acme"
        },
        project_detail: {
          identifier: "PROJ"
        }
      }
    });

    const result = normalizePlaneWebhook(input({ body: payload }), {
      issue_state_allowlist: ["In Progress"]
    });

    expect(result).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        action: "update",
        subject: {
          type: "plane_issue",
          id: "issue-1",
          url: "https://app.plane.so/acme/browse/PROJ-42",
          title: "Implement webhooks"
        },
        payload: {
          plane: {
            instance_id: "acme",
            workspace_slug: "acme",
            project_identifier: "PROJ",
            issue_identifier: 42,
            issue_id: "issue-1",
            sequence_id: 42,
            status: "In Progress",
            labels: ["github:org/repo"]
          }
        }
      }
    });
  });

  it("accepts the Plane state-updated smoke fixture with the configured allowlist", async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(process.cwd(), "examples/webhooks/plane-issue-state-updated.json"),
        "utf8"
      )
    ) as unknown;

    expect(
      normalizePlaneWebhook(input({ body: payload }), {
        issue_state_allowlist: ["In Progress"]
      })
    ).toMatchObject({
      kind: "accepted",
      invocation: {
        action: "update",
        subject: {
          url: "https://app.plane.so/acme/projects/proj/issues/issue-1"
        },
        payload: {
          plane: expect.objectContaining({
            status: "In Progress"
          })
        }
      }
    });
  });

  it("ignores Plane's duplicate state_id update when state allowlist is configured", () => {
    const payload = documentedIssuePayload("updated", {
      activity: {
        field: "state_id",
        old_value: "state-todo-id",
        new_value: "state-in-progress-id"
      },
      data: {
        id: "issue-1",
        url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
        name: "Implement webhooks",
        project_id: "project-1",
        sequence_id: 42,
        state: { name: "In Progress" },
        priority: "high",
        labels: [{ name: "github:org/repo" }],
        workspace_detail: {
          slug: "acme"
        }
      }
    });

    expect(
      normalizePlaneWebhook(input({ body: payload }), {
        issue_state_allowlist: ["In Progress"]
      })
    ).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_state_ignored"
    });
  });

  it("ignores issue updates when activity new_value is outside the configured state allowlist", () => {
    const payload = documentedIssuePayload("updated", {
      activity: {
        field: "state",
        old_value: "In Progress",
        new_value: "Todo"
      },
      data: {
        id: "issue-1",
        url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
        name: "Implement webhooks",
        project_id: "project-1",
        sequence_id: 42,
        state: { name: "In Progress" },
        priority: "high",
        labels: [{ name: "github:org/repo" }],
        workspace_detail: {
          slug: "acme"
        }
      }
    });

    expect(
      normalizePlaneWebhook(input({ body: payload }), {
        issue_state_allowlist: ["In Progress"]
      })
    ).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_state_ignored"
    });
  });

  it("produces an invocation accepted by the implementation workflow input schema", async () => {
    const result = normalizePlaneWebhook(input());
    if (result.kind !== "accepted") {
      throw new Error("Expected accepted result");
    }

    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "workflows/implementation/input.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>;

    expect(matchesJsonSchema(schema, result.invocation)).toBe(true);
  });

  it("accepts issue update", () => {
    expect(normalizePlaneWebhook(input({ body: issuePayload("update") }))).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        action: "update",
        payload: {
          plane: expect.objectContaining({
            issue_id: "issue-1"
          }),
          raw: issuePayload("update")
        }
      }
    });
  });

  it("normalizes Plane's past-tense issue actions", () => {
    expect(
      normalizePlaneWebhook(input({ body: issuePayload("created") }))
    ).toMatchObject({
      kind: "accepted",
      invocation: {
        action: "create"
      }
    });
    expect(
      normalizePlaneWebhook(input({ body: issuePayload("updated") }))
    ).toMatchObject({
      kind: "accepted",
      invocation: {
        action: "update"
      }
    });
    expect(normalizePlaneWebhook(input({ body: issuePayload("deleted") }))).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_delete_ignored"
    });
  });

  it("ignores issue updates outside the configured state allowlist", () => {
    expect(
      normalizePlaneWebhook(input({ body: issuePayload("update") }), {
        issue_state_allowlist: ["In Progress"]
      })
    ).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_state_ignored"
    });
  });

  it("accepts issue updates inside the configured state allowlist", () => {
    const body = issuePayload("update", {
      activity: {
        field: "state",
        old_value: "Backlog",
        new_value: "In Progress"
      },
      issue: {
        id: "issue-1",
        url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
        name: "Implement webhooks",
        sequence_id: 42,
        description_stripped: "Wire webhook ingress.",
        state: { name: "In Progress" },
        priority: "high",
        labels: [{ name: "github:org/repo" }]
      }
    });

    expect(
      normalizePlaneWebhook(input({ body }), {
        issue_state_allowlist: ["In Progress"]
      })
    ).toMatchObject({
      kind: "accepted",
      deliveryId: "delivery-1",
      invocation: {
        action: "update",
        payload: {
          plane: expect.objectContaining({
            status: "In Progress"
          })
        }
      }
    });
  });

  it("ignores issue delete", () => {
    expect(normalizePlaneWebhook(input({ body: issuePayload("delete") }))).toEqual({
      kind: "ignored",
      deliveryId: "delivery-1",
      reason: "plane_issue_delete_ignored"
    });
  });

  it("rejects a missing issue id", () => {
    const error = captureError(() =>
      normalizePlaneWebhook(
        input({
          body: issuePayload("create", {
            issue: {
              url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
              name: "Implement webhooks"
            }
          })
        })
      )
    );

    expect(error).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400,
      message: "Plane issue webhook payload is invalid"
    });
  });

  it("rejects issue webhooks without a repository hint label", () => {
    const error = captureError(() =>
      normalizePlaneWebhook(
        input({
          body: issuePayload("create", {
            issue: {
              id: "issue-1",
              url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
              name: "Implement webhooks",
              labels: [{ name: "backend" }]
            }
          })
        })
      )
    );

    expect(error).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400,
      message: "Plane issue webhook repository hint is missing"
    });
  });

  it("rejects issue webhooks missing required implementation subject fields", () => {
    const missingTitle = captureError(() =>
      normalizePlaneWebhook(
        input({
          body: issuePayload("create", {
            issue: {
              id: "issue-1",
              url: "https://app.plane.so/acme/projects/proj/issues/issue-1",
              labels: [{ name: "github:org/repo" }]
            }
          })
        })
      )
    );

    expect(missingTitle).toMatchObject({
      code: "webhook_payload_invalid",
      statusCode: 400,
      message: "Plane issue webhook title is missing"
    });
  });
});

describe("Plane webhook adapter factory", () => {
  it("creates secret-bound adapters without reading secrets at import time", () => {
    expect(createPlaneWebhookAdapter("plane-secret")).toMatchObject({
      id: "plane",
      description: "Plane webhook adapter"
    });
    expect(planeWebhookAdapterFactory.create({ secret: "plane-secret" })).toMatchObject({
      id: "plane",
      description: "Plane webhook adapter"
    });
  });

  it("rejects unknown Plane webhook config keys", () => {
    expect(() =>
      planeWebhookAdapterFactory.create({
        secret: "plane-secret",
        config: { issue_state_alllowlist: ["In Progress"] }
      })
    ).toThrow();
  });
});
