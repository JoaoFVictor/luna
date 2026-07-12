import { describe, expect, it } from "vitest"

import { launchAdapterDescription, launchAdapterLabel, launchAdapterPlaceholder, launchEffectLabel } from "@/features/launch/launch-presentation"

describe("launch presentation", () => {
  it("translates known security effects", () => {
    expect(launchEffectLabel("credential_read")).toBe("Usará a conexão configurada")
  })

  it("uses a source-specific input example", () => {
    expect(launchAdapterPlaceholder("github")).toContain("github.com")
    expect(launchAdapterPlaceholder("jira")).toContain("atlassian.net/browse")
    expect(launchAdapterPlaceholder("plane")).toContain("app.plane.so")
    expect(launchAdapterPlaceholder("custom")).toBe("Cole uma URL ou identificador")
  })

  it("keeps unknown effects readable without hiding their meaning", () => {
    expect(launchEffectLabel("provider_custom_write")).toBe("Provider custom write")
    expect(launchAdapterLabel("github.pull-request", "GitHub")).toBe("Pull request · GitHub")
  })

  it("uses human copy for known adapter sources", () => {
    expect(launchAdapterLabel("github.pr-url", "github")).toBe("Pull request do GitHub")
    expect(launchAdapterDescription("github.pr-url", "github", "English fallback")).toBe(
      "Carrega um pull request do GitHub a partir da URL.",
    )
  })
})
