import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import type { CapabilityCatalog, DraftFile, JsonValue, ModelConfiguration } from "@/api/types"
import { draftFileKey } from "@/features/drafts/draft-file-session"
import { AgentStructuredEditor } from "@/features/agents/agent-structured-editor"

const models: ModelConfiguration = {
  editing: "read_only",
  profiles: [{
    id: "default",
    source: { kind: "literal", model: "test-model" },
    reasoning_effort: "medium",
    transport: "sse",
    consumers: [],
  }],
  diagnostics: [],
}

const library: CapabilityCatalog = {
  technical_fingerprint: `sha256:${"1".repeat(64)}`,
  presentation_fingerprint: `sha256:${"2".repeat(64)}`,
  capabilities: [],
  registrations: [
    {
      registration_kind: "tool",
      id: "repository.read-file",
      owner: { capability_id: "repository", capability_version: "1", capability_kind: "execution" },
      presentation: { title: "Read file" },
      protocol: "local",
      input_schema: {},
      output_schema: {},
      runtime_requirements: ["tool_calling"],
      materialization: "local",
      allowlist_required: false,
      allowed_agent_modes: ["read_only", "trusted_local_write"],
      safety: { local_writes: false, network: false, external_side_effects: false },
    },
    {
      registration_kind: "tool",
      id: "repository.write-file",
      owner: { capability_id: "repository", capability_version: "1", capability_kind: "execution" },
      presentation: { title: "Write file" },
      protocol: "local",
      input_schema: {},
      output_schema: {},
      runtime_requirements: ["tool_calling"],
      materialization: "local",
      allowlist_required: false,
      allowed_agent_modes: ["trusted_local_write"],
      safety: { local_writes: true, network: false, external_side_effects: false },
    },
    {
      registration_kind: "schema",
      id: "findings.review_output",
      owner: { capability_id: "findings", capability_version: "1", capability_kind: "execution" },
      presentation: { title: "Review output" },
      schema: { type: "object" },
    },
  ],
}

const instructions: DraftFile = {
  file: { root: "project", path: "agents/reviewer/instructions.md" },
  media_type: "text/markdown",
  state: "present",
  content: "# Review",
}

const source = {
  id: "reviewer",
  description: "Review changes",
  model_profile: "default",
  mode: "read_only",
  instructions_file: "instructions.md",
  output_schema: "findings.review_output",
}

function renderEditor(
  rawLocalChanges = false,
  onDirtyChange = vi.fn(),
  files: readonly DraftFile[] = [instructions],
  agentSource: JsonValue = source,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AgentStructuredEditor
          agentId="reviewer"
          source={agentSource}
          files={files}
          contents={Object.fromEntries(files.flatMap((file) =>
            file.state === "present" ? [[draftFileKey(file), file.content ?? ""]] : []
          ))}
          models={models}
          library={library}
          agents={[]}
          agentsCatalogStatus="complete"
          runtime={{ editing: "read_only", workflow_runtime_id: "langgraph", agent_runtime_id: "pi", workspace_strategy: "git_worktree", plugin_count: 1, option_values_redacted: true }}
          workflows={[]}
          workflowsCatalogStatus="complete"
          canMutate
          rawLocalChanges={rawLocalChanges}
          pending={false}
          onDirtyChange={onDirtyChange}
          onSourceSave={vi.fn()}
          onFileSave={vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe("AgentStructuredEditor", () => {
  it("blocks structured fields while the raw fallback has local changes", () => {
    renderEditor(true)
    expect((screen.getByLabelText("Descrição") as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText("Edição estruturada pausada")).toBeTruthy()
  })

  it("uses canonical mode authority to block write tools for read-only agents", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("tab", { name: /Recursos e permissões/u }))
    expect(screen.getByLabelText("Adicionar tool repository.read-file").getAttribute("aria-disabled")).not.toBe("true")
    expect(screen.getByLabelText("Adicionar tool repository.write-file").getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText("Edita arquivos")).toBeTruthy()
  })

  it("preserves unsaved section state while moving between studio tabs", () => {
    renderEditor()
    const description = screen.getByLabelText("Descrição") as HTMLTextAreaElement
    fireEvent.change(description, { target: { value: "Updated only in the form" } })

    fireEvent.click(screen.getByRole("tab", { name: /Recursos e permissões/u }))
    fireEvent.click(screen.getByRole("tab", { name: /Identidade/u }))

    expect((screen.getByLabelText("Descrição") as HTMLTextAreaElement).value)
      .toBe("Updated only in the form")
  })

  it("does not block navigation for formatting-only General input", () => {
    const onDirtyChange = vi.fn()
    renderEditor(false, onDirtyChange)

    fireEvent.change(screen.getByLabelText("Descrição"), {
      target: { value: "  Review changes  " },
    })

    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
  })

  it("never treats a config-root decoy as an agent-owned file", () => {
    renderEditor(false, vi.fn(), [{
      ...instructions,
      file: { root: "config", path: instructions.file.path },
    }])

    expect(screen.getByText("Instructions indisponível no draft")).toBeTruthy()
  })

  it("edits an agent-owned JSON contract even without the conventional schema suffix", () => {
    const output: DraftFile = {
      file: { root: "project", path: "agents/reviewer/contract.json" },
      media_type: "application/json",
      state: "present",
      content: "{\"type\":\"object\"}\n",
    }
    renderEditor(false, vi.fn(), [instructions, output], {
      ...source,
      output_schema: "contract.json",
    })

    fireEvent.click(screen.getByRole("tab", { name: /Formato da resposta/u }))
    expect(screen.getByRole("option", { name: "contract.json" })).toBeTruthy()
  })

  it("uses canonical registered-schema precedence over a same-named local decoy", () => {
    const decoy: DraftFile = {
      file: { root: "project", path: "agents/reviewer/findings.review_output" },
      media_type: "text/plain",
      state: "present",
      content: "{\"type\":\"string\"}\n",
    }
    renderEditor(false, vi.fn(), [instructions, decoy])

    fireEvent.click(screen.getByRole("tab", { name: /Formato da resposta/u }))
    expect(screen.getByText("Schema registrado: findings.review_output")).toBeTruthy()
    expect(screen.queryByRole("option", { name: "findings.review_output" })).toBeNull()
  })
})
