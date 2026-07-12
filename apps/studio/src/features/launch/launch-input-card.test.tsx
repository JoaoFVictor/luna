import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LaunchInputCard } from "@/features/launch/launch-input-card"

describe("LaunchInputCard provider neutrality", () => {
  it("renders adapter-owned context without assuming URL, task, or pull-request semantics", () => {
    render(<LaunchInputCard
      adapters={[{
        id: "acme.record-key",
        source: "acme-cloud",
        description: "Informe a chave opaca aceita pela integração Acme.",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 1_000 },
      }]}
      mode="adapter"
      adapterId="acme.record-key"
      opaqueInput=""
      invocationJson="{}"
      acknowledgedAdapterEffects={[]}
      canMutate
      planning={false}
      previewing={false}
      executing={false}
      invocationRoutingDescription="Entrada direta"
      onModeChange={vi.fn()}
      onAdapterChange={vi.fn()}
      onOpaqueInputChange={vi.fn()}
      onInvocationJsonChange={vi.fn()}
      onAdapterEffectChange={vi.fn()}
      onPreview={vi.fn()}
    />)

    expect(screen.getByText("Record key · Acme cloud")).toBeTruthy()
    expect(screen.getByText("Informe a chave opaca aceita pela integração Acme.")).toBeTruthy()
    expect(screen.getByText(/O valor será interpretado pela fonte selecionada/)).toBeTruthy()
    expect(screen.getByLabelText("Valor de entrada").getAttribute("placeholder")).toBe(
      "Informe o valor aceito por esta fonte",
    )
    expect(screen.queryByText(/pull request|tarefa do|URL ou identificador/iu)).toBeNull()
  })
})
