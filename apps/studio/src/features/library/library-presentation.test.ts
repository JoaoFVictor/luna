import { describe, expect, it } from "vitest"
import { capabilityCategory } from "./library-presentation"

describe("capabilityCategory", () => {
  it("keeps authoritative presentation metadata", () => expect(capabilityCategory("git", "Integrações")).toBe("Integrações"))
  it("provides a human fallback for older manifests", () => expect(capabilityCategory("repository-context", undefined)).toBe("Contexto e dados"))
})
