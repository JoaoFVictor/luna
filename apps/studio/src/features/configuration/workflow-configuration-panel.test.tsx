import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type { ConfigurationDraft, WorkflowConfiguration } from "@/api/types"
import { SessionContext } from "@/app/studio-context"
import { WorkflowConfigurationPanel } from "@/features/configuration/workflow-configuration-panel"

const WORKFLOW_ID = "review"
const DRAFT_ID = "4b939152-e94b-4946-9506-0ee05824ee49"
const DIGEST = `sha256:${"a".repeat(64)}`
const ETAG = `"studio-draft:${DRAFT_ID}:1:${DIGEST}"`
const PRIVATE_CANARY = "CONFIG_PRIVATE_CANARY_browser_must_not_render"

const configuration: WorkflowConfiguration = {
  workflow_id: WORKFLOW_ID,
  status: "ready",
  declared: true,
  config_present: true,
  schema_present: true,
  raw_yaml_enabled: false,
  file_reference: "config:review.yaml",
  schema_reference: "project:workflows/review/config.schema.json",
  installed_revision: DIGEST,
  schema_summary: {
    total_leaf_count: 3,
    classified_field_count: 2,
    unclassified_field_count: 1,
    unsupported_classified_field_count: 0,
  },
  fields: [
    {
      path: ["settings", "enabled"],
      expression: "$.config.settings.enabled",
      value_type: "boolean",
      exposure: "editable",
      required: true,
      present: true,
      value: false,
      title: "Enabled",
    },
    {
      path: ["settings", "provider"],
      expression: "$.config.settings.provider",
      value_type: "string",
      exposure: "read_only",
      required: true,
      present: true,
      value: "github",
      title: "Provider",
    },
  ],
  references: [{ expression: "$.config.settings.enabled" }],
  diagnostics: [],
}

function draft(enabled: boolean): ConfigurationDraft {
  return {
    draft_id: DRAFT_ID,
    record_revision: enabled ? 2 : 1,
    content_revision: enabled ? 2 : 1,
    status: "dirty",
    draft_hash: DIGEST,
    etag: enabled ? `${ETAG}-next` : ETAG,
    configuration: {
      ...configuration,
      fields: configuration.fields.map((field) =>
        field.expression === "$.config.settings.enabled"
          ? { ...field, value: enabled }
          : field,
      ),
    },
    created_at: "2026-07-11T01:00:00.000Z",
    updated_at: "2026-07-11T01:00:00.000Z",
  }
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider
          value={{
            bootstrap: { mode: "full", expiresAt: "2026-07-11T02:00:00.000Z" },
            canMutate: true,
          }}
        >
          {children}
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("WorkflowConfigurationPanel", () => {
  it("reopens a persisted configuration draft supplied by the drafts list", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "workflowConfiguration").mockResolvedValue(configuration)
    const loadDraft = vi
      .spyOn(studioApi, "configurationDraft")
      .mockResolvedValue(draft(true))

    render(
      <WorkflowConfigurationPanel
        workflowId={WORKFLOW_ID}
        initialDraftId={DRAFT_ID}
      />,
      { wrapper: wrapper(queryClient) },
    )

    expect(await screen.findByText("Ativado")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Começar a editar" })).toBeNull()
    expect(loadDraft).toHaveBeenCalledWith(WORKFLOW_ID, DRAFT_ID, expect.any(AbortSignal))
  })

  it("renders classified fields only and patches an editable leaf by path", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "workflowConfiguration").mockResolvedValue(configuration)
    vi.spyOn(studioApi, "createConfigurationDraft").mockResolvedValue(draft(false))
    const patch = vi
      .spyOn(studioApi, "patchConfigurationDraft")
      .mockResolvedValue(draft(true))

    render(<WorkflowConfigurationPanel workflowId={WORKFLOW_ID} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("Enabled")).toBeDefined()
    expect(screen.getByText("Provider")).toBeDefined()
    expect(screen.queryByText(PRIVATE_CANARY)).toBeNull()
    expect(document.body.textContent).not.toContain(PRIVATE_CANARY)

    fireEvent.click(screen.getByRole("button", { name: "Começar a editar" }))
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enabled" }).hasAttribute("data-disabled"),
      ).toBe(false),
    )
    const provider = screen.getByDisplayValue("github") as HTMLInputElement
    expect(provider.disabled).toBe(true)

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }))
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações (1)" }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        WORKFLOW_ID,
        DRAFT_ID,
        ETAG,
        [{ path: ["settings", "enabled"], value: true }],
      ),
    )
    expect(await screen.findByText("Ativado")).toBeDefined()
    expect(document.body.textContent).not.toContain(PRIVATE_CANARY)
  })

  it("reuses the same idempotency key when a confirmed apply is retried", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const validDraft: ConfigurationDraft = {
      ...draft(false),
      status: "valid",
    }
    vi.spyOn(studioApi, "workflowConfiguration").mockResolvedValue(configuration)
    vi.spyOn(studioApi, "createConfigurationDraft").mockResolvedValue(draft(false))
    vi.spyOn(studioApi, "validateConfigurationDraft").mockResolvedValue({
      draft: validDraft,
      validation: {
        status: "valid",
        diagnostics: [],
        validated_at: "2026-07-11T01:01:00.000Z",
      },
    })
    vi.spyOn(studioApi, "planConfigurationApply").mockResolvedValue({
      status: "ready",
      draft_id: DRAFT_ID,
      record_revision: validDraft.record_revision,
      content_revision: validDraft.content_revision,
      draft_hash: DIGEST,
      changes: [
        {
          path: ["settings", "enabled"],
          before_present: true,
          before: false,
          after_present: true,
          after: true,
        },
      ],
      conflicts: [],
      plan_token: "p".repeat(32),
      expires_at: "2026-07-11T01:05:00.000Z",
    })
    const apply = vi
      .spyOn(studioApi, "applyConfigurationDraft")
      .mockRejectedValue(new Error("acceptance unknown"))

    render(<WorkflowConfigurationPanel workflowId={WORKFLOW_ID} />, {
      wrapper: wrapper(queryClient),
    })

    await screen.findByText("Enabled")
    fireEvent.click(screen.getByRole("button", { name: "Começar a editar" }))
    fireEvent.click(await screen.findByRole("button", { name: "Verificar alterações" }))
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Revisar e aplicar" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: "Revisar e aplicar" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar aplicação" }),
    )
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar configuração" }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))

    const openApply = screen.queryByRole("button", {
      name: "Aplicar configuração",
    })
    if (openApply === null) {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar apply" }))
    }
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar configuração" }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))

    expect(apply.mock.calls[0]?.[4]).toBe(apply.mock.calls[1]?.[4])
    expect(apply.mock.calls[0]?.[4]).toContain(DRAFT_ID)
    expect(apply.mock.calls[0]?.[4]).toContain(DIGEST)
  })
})
