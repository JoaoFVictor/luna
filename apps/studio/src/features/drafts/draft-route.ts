type DraftRouteTarget = {
  readonly draft_id: string
  readonly primary_resource: {
    readonly kind: "workflow" | "agent" | "config"
    readonly id: string
  }
}

export function draftHref(draft: DraftRouteTarget): string {
  const draftId = encodeURIComponent(draft.draft_id)

  if (draft.primary_resource.kind === "agent") {
    return `/agent-drafts/${draftId}`
  }

  if (draft.primary_resource.kind === "config") {
    const query = new URLSearchParams({
      workflow: draft.primary_resource.id,
      draft: draft.draft_id,
    })
    return `/configuration?${query.toString()}`
  }

  return `/drafts/${draftId}`
}
