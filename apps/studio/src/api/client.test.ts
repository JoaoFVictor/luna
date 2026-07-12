import { afterEach, describe, expect, it, vi } from "vitest"

import { StudioApiClient, StudioApiError } from "@/api/client"
import type { RunPlanInput } from "@/api/types"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const planId = `rp_${"p".repeat(32)}`

const validRunPlan = {
  plan_id: planId,
  created_at: "2026-07-11T12:00:00.000Z",
  expires_at: "2026-07-11T12:05:00.000Z",
  workflow_id: "review",
  execution_scope: { kind: "workflow" },
  mode: "read_only",
  workflow_revision: digest("1"),
  definition_bundle_hash: digest("2"),
  catalog_fingerprint: digest("3"),
  execution_snapshot_hash: digest("4"),
  invocation_hash: digest("5"),
  config_hash: digest("6"),
  repository_required: false,
  input_provenance: {
    kind: "adapter",
    adapter_id: "task-url",
    adapter_input_hash: digest("7"),
  },
  potential_effects: [],
  resolved_effects: [],
  effect_uncertainties: [],
  warnings: [],
  confirmation_required: false,
  confirmation_token: "t".repeat(48),
} as const

const validSession = {
  csrf_token: "csrf-token",
  expires_at: "2026-07-11T01:00:00.000Z",
  principal: {
    id: "local-user",
    authentication: "local-session",
  },
  mode: "local-single-user",
} as const

afterEach(() => {
  window.history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
})

describe("StudioApiClient", () => {
  it("sends an explicit JSON object when deleting a draft", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(validSession),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    await client.deleteDraft("draft with spaces", '"etag"')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [requestUrl, requestInit] = fetchMock.mock.calls[1]
    expect(requestUrl).toBe("/api/studio/v1/drafts/draft%20with%20spaces")
    expect(requestInit?.method).toBe("DELETE")
    expect(requestInit?.body).toBe("{}")
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe(
      "application/json",
    )
    expect(new Headers(requestInit?.headers).get("X-Luna-CSRF")).toBe(
      "csrf-token",
    )
  })

  it("rejects a successful response that violates the canonical contract", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workflows: "not-an-array" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()

    await expect(client.workflows()).rejects.toMatchObject({
      code: "studio_response_invalid",
      status: 200,
    })
  })

  it("patches configuration by classified path and rejects raw YAML in the response", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const draftId = "6d518d68-fe3e-48fa-89f0-2db1ad3dd946"
    const digest = `sha256:${"a".repeat(64)}`
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            draft_id: draftId,
            record_revision: 2,
            content_revision: 2,
            status: "dirty",
            draft_hash: digest,
            etag: '"next"',
            configuration: {
              workflow_id: "review",
              status: "ready",
              declared: true,
              config_present: true,
              schema_present: true,
              raw_yaml_enabled: false,
              schema_summary: {
                total_leaf_count: 1,
                classified_field_count: 1,
                unclassified_field_count: 0,
                unsupported_classified_field_count: 0,
              },
              fields: [],
              references: [],
              diagnostics: [],
            },
            raw_yaml: "secret: must-not-cross-contract",
            created_at: "2026-07-11T01:00:00.000Z",
            updated_at: "2026-07-11T01:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    await expect(
      client.patchConfigurationDraft(
        "review",
        draftId,
        '"etag"',
        [{ path: ["settings", "enabled"], value: true }],
      ),
    ).rejects.toMatchObject({ code: "studio_response_invalid", status: 200 })

    const [requestUrl, requestInit] = fetchMock.mock.calls[1]
    expect(requestUrl).toBe(
      `/api/studio/v1/configuration/workflows/review/drafts/${draftId}`,
    )
    expect(requestInit?.method).toBe("PATCH")
    expect(requestInit?.body).toBe(
      JSON.stringify({
        updates: [{ path: ["settings", "enabled"], value: true }],
      }),
    )
    const headers = new Headers(requestInit?.headers)
    expect(headers.get("If-Match")).toBe('"etag"')
    expect(headers.get("X-Luna-CSRF")).toBe("csrf-token")
  })

  it("sends only the canonical public plan union and validates the 202 receipt", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validRunPlan), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: true,
            dispatch_status: "queued",
            run_id: "queued-run-1",
            plan_id: planId,
            execution_snapshot_hash: digest("4"),
            accepted_at: "2026-07-11T12:00:01.000Z",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    const input: RunPlanInput = {
      kind: "adapter",
      definition_source: { kind: "installed" },
      execution_scope: { kind: "workflow" },
      adapter_id: "task-url",
      input: { kind: "cli" as const, value: "opaque://task/42" },
      acknowledged_effects: ["network_read"],
    }
    const plan = await client.planRun(input)
    const receipt = await client.executeRun(plan.plan_id, {
      confirmation_token: plan.confirmation_token,
      idempotency_key: "stable-idempotency-key",
      confirmation: {
        kind: "local_explicit",
        real_run_confirmed: true,
        listed_effects_confirmed: true,
      },
    })

    expect(plan.mode).toBe("read_only")
    expect(receipt.run_id).toBe("queued-run-1")
    const planBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(planBody).toEqual(input)
    expect(planBody).not.toHaveProperty("workflow_id")
    expect(planBody).not.toHaveProperty("config")
    expect(planBody).not.toHaveProperty("actor_binding")
    expect(fetchMock.mock.calls[2][0]).toBe(
      `/api/studio/v1/run-plans/${planId}/execute`,
    )
    expect(fetchMock.mock.calls[2][1]?.body).toBe(
      JSON.stringify({
        confirmation_token: "t".repeat(48),
        idempotency_key: "stable-idempotency-key",
        confirmation: {
          kind: "local_explicit",
          real_run_confirmed: true,
          listed_effects_confirmed: true,
        },
      }),
    )
  })

  it("rejects browser-supplied workflow/config fields before sending a plan", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    expect(() => client.planRun({
      kind: "adapter",
      adapter_id: "task-url",
      input: { kind: "cli", value: "opaque://task/42" },
      acknowledged_effects: [],
      workflow_id: "browser-forged",
      config: { secret: true },
    } as unknown as RunPlanInput)).toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("preserves the server acceptance-unknown diagnostic for safe UI handling", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "studio_run_dispatch_failed",
              message: "Run acceptance could not be verified",
              details: { acceptance_unknown: true, plan_id: planId },
              request_id: "request-launch-unknown",
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    const error = await client.executeRun(planId, {
      confirmation_token: "t".repeat(48),
      idempotency_key: "stable-idempotency-key",
      confirmation: {
        kind: "local_explicit",
        real_run_confirmed: true,
        listed_effects_confirmed: true,
      },
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(StudioApiError)
    expect(error).toMatchObject({
      code: "studio_run_dispatch_failed",
      details: { acceptance_unknown: true, plan_id: planId },
    })
  })

  it("rejects malformed error details instead of trusting an unchecked envelope", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "studio_run_dispatch_failed",
              message: "Untrusted malformed envelope",
              details: { acceptance_unknown: { forged: true } },
              request_id: "request-malformed-error",
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()

    await expect(client.executeRun(planId, {
      confirmation_token: "t".repeat(48),
      idempotency_key: "stable-idempotency-key",
      confirmation: {
        kind: "local_explicit",
        real_run_confirmed: true,
        listed_effects_confirmed: true,
      },
    })).rejects.toMatchObject({
      code: "studio_request_failed",
      status: 503,
      details: {},
    })
  })

  it("uses canonical history URLs and sends only restore-as-draft confirmation", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const baseRevision = "a".repeat(40)
    const targetRevision = "b".repeat(40)
    const draftId = "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38"
    const resource = { kind: "agent", id: "reviewer" } as const
    const json = (value: unknown, status = 200) => new Response(
      JSON.stringify(value),
      { status, headers: { "Content-Type": "application/json" } },
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json({
        resource,
        revisions: [{
          revision_id: targetRevision,
          committed_at: "2026-07-11T12:00:00.000Z",
          subject: "Update reviewer",
        }],
        truncated: false,
      }))
      .mockResolvedValueOnce(json({
        resource,
        base_revision_id: baseRevision,
        target_revision_id: targetRevision,
        diff: [],
      }))
      .mockResolvedValueOnce(json({
        resource,
        revision_id: targetRevision,
        draft: {
          draft_id: draftId,
          record_revision: 1,
          content_revision: 1,
          layout_revision: 0,
          primary_resource: resource,
          status: "dirty",
          draft_hash: digest("c"),
          etag: `"studio-draft:${draftId}:1:${digest("c")}"`,
          files: [],
          created_at: "2026-07-11T12:00:00.000Z",
          updated_at: "2026-07-11T12:00:00.000Z",
        },
      }, 201))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    await client.resourceHistory(resource, 10)
    await client.compareResourceHistory(resource, baseRevision, targetRevision)
    await client.restoreResourceHistory(resource, targetRevision)

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/studio/v1/resources/agent/reviewer/history?limit=10",
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/studio/v1/resources/agent/reviewer/history/compare" +
        `?base_revision_id=${baseRevision}&target_revision_id=${targetRevision}`,
    )
    expect(fetchMock.mock.calls[3][0]).toBe(
      "/api/studio/v1/resources/agent/reviewer/history/restore",
    )
    expect(fetchMock.mock.calls[3][1]?.body).toBe(JSON.stringify({
      revision_id: targetRevision,
      confirm_restore_as_new_draft: true,
    }))
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get("X-Luna-CSRF"))
      .toBe("csrf-token")
  })

  it("rejects a history diff that is not marked as redacted", async () => {
    const baseRevision = "a".repeat(40)
    const targetRevision = "b".repeat(40)
    const resource = { kind: "agent", id: "reviewer" } as const
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        resource,
        base_revision_id: baseRevision,
        target_revision_id: targetRevision,
        diff: [{
          file: { root: "project", path: "agents/reviewer/agent.yaml" },
          kind: "modified",
          before_sha256: digest("a"),
          after_sha256: digest("b"),
          before_mode: 0o644,
          after_mode: 0o644,
          textual_diff: "unsafe raw diff",
          textual_diff_truncated: false,
          redacted: false,
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await expect(
      client.compareResourceHistory(resource, baseRevision, targetRevision),
    ).rejects.toMatchObject({ code: "studio_response_invalid", status: 200 })
  })
})
