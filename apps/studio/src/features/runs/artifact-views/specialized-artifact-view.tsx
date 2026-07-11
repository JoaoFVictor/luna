import type { ReactNode } from "react"

import type { ArtifactPreview } from "@/api/types"

import { projectSpecializedArtifactView } from "./specialized-artifact-view-registry"

export function SpecializedArtifactView({
  preview,
  genericFallback,
}: {
  preview: ArtifactPreview
  genericFallback: ReactNode
}) {
  if (preview.kind !== "json" || preview.metadata.semantic_type === undefined) {
    return genericFallback
  }

  const projection = projectSpecializedArtifactView(
    preview.metadata.semantic_type,
    preview.value,
  )
  if (projection.kind === "unsupported") {
    return genericFallback
  }

  return (
    <div data-specialized-artifact={preview.metadata.semantic_type}>
      {projection.content}
    </div>
  )
}
