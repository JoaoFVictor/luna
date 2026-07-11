import { afterEach, describe, expect, it, vi } from "vitest"

import { StudioApiClient } from "@/api/client"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const timestamp = "2026-07-11T12:00:00.000Z"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const validSession = {
  csrf_token: "csrf-token",
  expires_at: "2026-07-11T13:00:00.000Z",
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

describe("StudioApiClient domain modules", () => {
  it("composes flat domain capabilities without an inheritance chain", () => {
    const client = new StudioApiClient()

    expect(Object.getPrototypeOf(StudioApiClient.prototype)).toBe(
      Object.prototype,
    )
    expect(Object.hasOwn(client, "request")).toBe(true)
    expect(Object.hasOwn(client, "workflows")).toBe(true)
    expect(Object.hasOwn(client, "runCatalogPage")).toBe(true)
    expect(Object.hasOwn(client, "routing")).toBe(true)
    expect(Object.hasOwn(client, "workflowConfiguration")).toBe(true)
    expect(Object.hasOwn(client, "resourceHistory")).toBe(true)
  })

  it("keeps bootstrap authority in the HTTP core and consumes the URL capability", async () => {
    window.history.replaceState(
      { preserved: true },
      "",
      "/studio?source=local#tab=launch&capability=launch-token&panel=effects",
    )
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(validSession))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    const listener = vi.fn()
    const unsubscribe = client.subscribeSession(listener)

    await expect(client.bootstrap()).resolves.toEqual({
      mode: "full",
      expiresAt: validSession.expires_at,
    })
    expect(client.canMutate()).toBe(true)
    expect(client.sessionSnapshot()).toEqual({
      mode: "full",
      expiresAt: validSession.expires_at,
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(window.location.pathname).toBe("/studio")
    expect(window.location.search).toBe("?source=local")
    expect(window.location.hash).toBe("#tab=launch&panel=effects")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/studio/v1/session/exchange")
    expect(init?.body).toBe(JSON.stringify({ capability: "launch-token" }))
    expect(new Headers(init?.headers).get("X-Luna-CSRF")).toBeNull()

    await expect(client.bootstrap()).resolves.toEqual(client.sessionSnapshot())
    expect(fetchMock).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("rotates CSRF without a launch capability and drops authority on 401", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json({
        error: {
          code: "studio_session_expired",
          message: "Session expired",
          details: {},
          request_id: "request-session-expired",
        },
      }, 401))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    const listener = vi.fn()
    client.subscribeSession(listener)

    await client.bootstrap()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/studio/v1/session/csrf")
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Luna-CSRF"))
      .toBeNull()

    await expect(client.workflows()).rejects.toMatchObject({
      status: 401,
      code: "studio_session_expired",
      requestId: "request-session-expired",
    })
    expect(client.canMutate()).toBe(false)
    expect(client.sessionSnapshot()).toEqual({ mode: "read-only-session" })
    expect(listener).toHaveBeenCalledTimes(2)

    await expect(client.createDraft({
      resource: { kind: "workflow", id: "review" },
      source: { mode: "blank" },
    })).rejects.toMatchObject({
      status: 403,
      code: "studio_csrf_unavailable",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps the flat spyable API while parsing catalog domain responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        status: "complete",
        fingerprint: digest("1"),
        workflows: [],
        diagnostics: [],
      }))
      .mockResolvedValueOnce(json({
        status: "complete",
        fingerprint: digest("2"),
        agents: [],
        diagnostics: [],
      }))
      .mockResolvedValueOnce(json({
        technical_fingerprint: digest("3"),
        presentation_fingerprint: digest("4"),
        capabilities: [],
        registrations: [],
      }))
      .mockResolvedValueOnce(json({ adapters: [] }))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    const workflows = vi.spyOn(client, "workflows")

    await expect(client.workflows()).resolves.toMatchObject({
      status: "complete",
      workflows: [],
    })
    await expect(client.agents()).resolves.toMatchObject({ agents: [] })
    await expect(client.library()).resolves.toMatchObject({ capabilities: [] })
    await expect(client.inputAdapters()).resolves.toEqual({ adapters: [] })

    expect(workflows).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/studio/v1/workflows",
      "/api/studio/v1/agents",
      "/api/studio/v1/library",
      "/api/studio/v1/input-adapters",
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe("same-origin")
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json")
    }
  })

  it("preserves encoded draft queries, mutation headers, and strict parsing", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const file = {
      root: "project" as const,
      path: "workflows/review config/workflow.yaml",
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json({ file, value: { id: "review" } }))
      .mockResolvedValueOnce(json({ file, value: { forged: "not-a-draft" } }))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    await expect(client.draftSourceView("draft with spaces", file)).resolves.toEqual({
      file,
      value: { id: "review" },
    })
    await expect(client.editDraftSource(
      "draft with spaces",
      '"etag"',
      file,
      [{ op: "set", path: ["description"], value: "Updated" }],
    )).rejects.toMatchObject({
      code: "studio_response_invalid",
      status: 200,
    })

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/studio/v1/drafts/draft%20with%20spaces/source-view" +
        "?root=project&path=workflows%2Freview+config%2Fworkflow.yaml",
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/studio/v1/drafts/draft%20with%20spaces/source-edits",
    )
    const mutation = fetchMock.mock.calls[2][1]
    expect(mutation?.method).toBe("POST")
    expect(mutation?.body).toBe(JSON.stringify({
      file,
      operations: [{
        op: "set",
        path: ["description"],
        value: "Updated",
      }],
    }))
    const headers = new Headers(mutation?.headers)
    expect(headers.get("If-Match")).toBe('"etag"')
    expect(headers.get("X-Luna-CSRF")).toBe("csrf-token")
  })

  it("preserves run filters, log filters, and non-fetch stream URLs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        items: [],
        next_cursor: null,
        as_of: timestamp,
      }))
      .mockResolvedValueOnce(json({
        run_id: "run-1",
        items: [],
        next_cursor: null,
        as_of: timestamp,
        snapshot_bytes: 0,
        scanned_bytes: 0,
        redaction: "best_effort",
      }))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await expect(client.runCatalogPage({
      cursor: "cursor value",
      limit: 17,
      status: "failed",
      workflowId: "review nightly",
      source: "adapter:task-url",
      planId: `rp_${"p".repeat(32)}`,
    })).resolves.toMatchObject({ items: [], next_cursor: null })
    await expect(client.runLogs("run-1", {
      cursor: "lc2.abcdefghijklmnopqrst.abcdefghijklmnopqrst",
      levels: ["warn", "error"],
      nodeId: "review/final",
      limit: 37,
    })).resolves.toMatchObject({ run_id: "run-1", redaction: "best_effort" })

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/studio/v1/runs?limit=17&direction=desc&cursor=cursor+value" +
        "&status=failed&workflow_id=review+nightly&source=adapter%3Atask-url" +
        `&plan_id=rp_${"p".repeat(32)}`,
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/studio/v1/runs/run-1/logs?limit=37" +
        "&cursor=lc2.abcdefghijklmnopqrst.abcdefghijklmnopqrst" +
        "&levels=warn%2Cerror&node_id=review%2Ffinal",
    )
    expect(client.runEventStreamUrl("run with spaces", 19)).toBe(
      "/api/studio/v1/runs/run%20with%20spaces/events/stream?after_sequence=19",
    )
    expect(client.artifactDownloadUrl("run / 1", "artifact / report")).toBe(
      "/api/studio/v1/runs/run%20%2F%201/artifacts/" +
        "artifact%20%2F%20report/download",
    )
  })

  it("keeps draft apply idempotency and optimistic concurrency in one request", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json({ forged: "invalid-apply-result" }))
    vi.stubGlobal("fetch", fetchMock)

    const client = new StudioApiClient()
    await client.bootstrap()
    await expect(client.applyDraft(
      "draft / one",
      '"etag"',
      "plan-token",
      "stable-idempotency-key",
    )).rejects.toMatchObject({ code: "studio_response_invalid" })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe("/api/studio/v1/drafts/draft%20%2F%20one/apply")
    expect(init?.body).toBe(JSON.stringify({
      plan_token: "plan-token",
      idempotency_key: "stable-idempotency-key",
    }))
    const headers = new Headers(init?.headers)
    expect(headers.get("If-Match")).toBe('"etag"')
    expect(headers.get("X-Luna-CSRF")).toBe("csrf-token")
  })
})
