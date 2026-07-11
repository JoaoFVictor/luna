import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { SafeMarkdownPreview } from "@/features/agents/safe-markdown-preview"
import { safeMarkdownBlocks } from "@/features/agents/safe-markdown"

describe("safe agent instructions preview", () => {
  it("projects a deliberately small Markdown subset", () => {
    expect(safeMarkdownBlocks("# Role\n\n- inspect\n- report\n\n```json\n{}\n```"))
      .toMatchObject([
        { kind: "heading", level: 1, text: "Role" },
        { kind: "list", ordered: false, items: ["inspect", "report"] },
        { kind: "code", language: "json", text: "{}" },
      ])
  })

  it("never activates embedded HTML", () => {
    render(<SafeMarkdownPreview markdown={'<img src=x onerror="alert(1)">'} />)
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy()
    expect(document.querySelector("img")).toBeNull()
  })
})
