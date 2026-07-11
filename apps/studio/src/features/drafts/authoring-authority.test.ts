import { describe, expect, it } from "vitest"

import { authoringAuthorityUnavailable } from "@/features/drafts/authoring-authority"

const settled = {
  data: { projected: true },
  isFetching: false,
  isError: false,
}

describe("authoring authority", () => {
  it("fails closed while stale data is refetching or its refetch failed", () => {
    expect(authoringAuthorityUnavailable(false, [
      { ...settled, isFetching: true },
    ])).toBe(true)
    expect(authoringAuthorityUnavailable(false, [
      { ...settled, isError: true },
    ])).toBe(true)
  })

  it("fails closed for local content and missing projections", () => {
    expect(authoringAuthorityUnavailable(true, [settled])).toBe(true)
    expect(authoringAuthorityUnavailable(false, [{
      ...settled,
      data: undefined,
    }])).toBe(true)
    expect(authoringAuthorityUnavailable(false, [settled])).toBe(false)
  })
})
