import { describe, expect, it } from "vitest"

import { launchAdapterDescription, launchAdapterLabel, launchAdapterPlaceholder, launchEffectLabel } from "@/features/launch/launch-presentation"

describe("launch presentation", () => {
  it("translates known security effects", () => {
    expect(launchEffectLabel("credential_read")).toBe("Usará a conexão configurada")
  })

  it("does not invent provider-specific input examples", () => {
    expect(launchAdapterPlaceholder()).toBe("Informe o valor esperado por este adapter")
  })

  it("keeps unknown effects readable without hiding their meaning", () => {
    expect(launchEffectLabel("provider_custom_write")).toBe("Provider custom write")
    expect(launchAdapterLabel("acme.work-item", "Acme Cloud")).toBe("Work item · Acme cloud")
  })

  it("uses only adapter catalog metadata for contextual copy", () => {
    expect(launchAdapterLabel("vendor.work-item", "vendor")).toBe("Work item · Vendor")
    expect(launchAdapterDescription("vendor.work-item", "Descrição fornecida pelo adapter.")).toBe(
      "Descrição fornecida pelo adapter.",
    )
    expect(launchAdapterDescription("vendor.work-item", "")).toBe(
      "Prepara uma entrada usando vendor.work-item.",
    )
    expect(launchAdapterLabel("github.pr-url", "github")).toBe("Pr URL · Github")
    expect(launchAdapterDescription("github.pr-url", "Catalog-owned description")).toBe(
      "Catalog-owned description",
    )
  })
})
