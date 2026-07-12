import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { CapabilityRegistration, CapabilitySummary } from "@/api/types"
import { CapabilityCatalogPanel } from "@/features/library/capability-catalog-panel"

const capability: CapabilitySummary = {
  id: "sample",
  version: "2.0.0",
  kind: "composition",
  workflow_node_types: [],
  depends_on: ["base"],
  presets: { recommended: ["base.inspect"] },
  re_exports: {
    built_ins: ["base.inspect"],
    patterns: [],
    tools: [],
    gates: [],
    policies: [],
    ports: [],
    artifact_publishers: [],
  },
  presentation: {
    title: "Sample capability",
    summary: "Composes the inspection flow",
    category: "Quality",
    tags: ["inspection"],
  },
  docs: [{
    title: "Sample guide",
    path: "docs/sample.md",
    url: "https://example.test/sample",
  }],
}

const registration: CapabilityRegistration = {
  registration_kind: "built_in",
  id: "sample.run",
  owner: {
    capability_id: "sample",
    capability_version: "2.0.0",
    capability_kind: "composition",
  },
  presentation: { title: "Run sample" },
  input_schema: {},
  output_schema: {},
  required_ports: [],
  requires_repository: false,
}

describe("CapabilityCatalogPanel", () => {
  it("makes manifest metadata inspectable without inventing ids", () => {
    render(
      <CapabilityCatalogPanel
        capabilities={[capability]}
        registrations={[registration]}
        consumers={{
          status: "complete",
          incomplete_sources: [],
          capabilities: {
            sample: { workflows: ["review"], agents: ["reviewer"] },
          },
          registrations: {
            "sample.run": { workflows: ["review"], agents: [] },
          },
        }}
        search="base.inspect"
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Sample capability/u }))

    expect(screen.getByText("recommended")).toBeTruthy()
    expect(screen.getByText("Sample guide")).toBeTruthy()
    expect(screen.getByText("docs/sample.md")).toBeTruthy()
    expect(screen.getByText("sample.run")).toBeTruthy()
    expect(screen.getByText("review")).toBeTruthy()
    expect(screen.getByText("reviewer")).toBeTruthy()
    expect(screen.getAllByText("base.inspect").length).toBeGreaterThan(0)
  })

  it("reports an honest empty state for unmatched metadata", () => {
    render(
      <CapabilityCatalogPanel
        capabilities={[capability]}
        registrations={[registration]}
        search="missing-capability"
      />,
    )

    expect(screen.getByText("Nenhuma capability encontrada")).toBeTruthy()
  })
})
