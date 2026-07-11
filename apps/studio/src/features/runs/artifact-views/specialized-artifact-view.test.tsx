import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { ArtifactPreview } from "@/api/types"

import { STUDIO_ARTIFACT_SEMANTIC_TYPES } from "../../../../../../src/studio/contracts/artifact-semantics.js"
import { SpecializedArtifactView } from "./specialized-artifact-view"
import { KNOWN_SPECIALIZED_ARTIFACT_SEMANTIC_TYPES } from "./specialized-artifact-view-registry"

const HANDLE = `ah_${"a".repeat(43)}`

function jsonPreview(semanticType: string | undefined, value: unknown): ArtifactPreview {
  return {
    kind: "json",
    metadata: {
      manifest_handle: HANDLE,
      name: "artifact.json",
      attempt: 1,
      media_type: "application/json",
      ...(semanticType === undefined ? {} : { semantic_type: semanticType }),
      status: "committed",
      created_at: "2026-07-11T12:00:00.000Z",
      preview_capability: "probe_required",
      content_length: 100,
      downloadable: true,
      raw_download_redaction: "not_applied",
    },
    inspected_bytes: 100,
    truncated: false,
    integrity: "verified",
    encoding: "utf-8",
    value: value as never,
    redaction: { mode: "best_effort", changed: false },
    render_policy: "structured_data_only",
  }
}

function renderView(preview: ArtifactPreview) {
  return render(
    <SpecializedArtifactView
      preview={preview}
      genericFallback={<div>fallback genérico seguro</div>}
    />,
  )
}

describe("SpecializedArtifactView", () => {
  it("registers every declared Studio semantic view exactly once", () => {
    expect([...KNOWN_SPECIALIZED_ARTIFACT_SEMANTIC_TYPES].sort()).toEqual(
      Object.values(STUDIO_ARTIFACT_SEMANTIC_TYPES).sort(),
    )
  })

  it("renders validated findings as escaped React text and redacts physical paths", () => {
    const view = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings, {
        summary: "Inspecionado em /mnt/private/repo e \\\\server\\share\\repo",
        reviewed_ranges: [],
        findings: [
          {
            title: "<img src=x onerror=alert(1)>",
            severity: "high",
            confidence: "high",
            description: "Falha em /tmp/luna-worktrees/run-1 e C:\\Users\\alice\\repo",
            evidence: [
              { path: "src/safe.ts", line_start: 10, line_end: 12, quote: "raw" },
            ],
            recommendation: "Corrigir file:///home/alice/private sem inserir HTML.",
          },
        ],
      }),
    )

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined()
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.textContent).toContain("[PATH REDACTED]")
    expect(view.container.textContent).not.toContain("/mnt/private")
    expect(view.container.textContent).not.toContain("/tmp/luna-worktrees")
    expect(view.container.textContent).not.toContain("C:\\Users\\alice")
    expect(view.container.textContent).not.toContain("\\\\server\\share")
    expect(view.container.textContent).not.toContain("file://")
  })

  it("falls back when a known semantic payload violates its schema or bounds", () => {
    const invalidPath = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings, {
        findings: [
          {
            title: "finding",
            severity: "high",
            confidence: "high",
            description: "description",
            evidence: [{ path: "/home/golias/private.ts", line_start: 1, line_end: 2 }],
            recommendation: "fix",
          },
        ],
      }),
    )
    expect(invalidPath.getByText("fallback genérico seguro")).toBeDefined()
    expect(invalidPath.container.textContent).not.toContain("/home/golias")
    invalidPath.unmount()

    renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings, {
        findings: Array.from({ length: 501 }, (_, index) => ({
          title: `finding ${index}`,
          severity: "info",
          confidence: "low",
          description: "description",
          evidence: [],
          recommendation: "recommendation",
        })),
      }),
    )
    expect(screen.getByText("fallback genérico seguro")).toBeDefined()
  })

  it("projects worktree and validation data without physical paths or raw output", () => {
    const worktree = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationWorktree, {
        operation_id: "repository-workspace.capture",
        run_id: "run-1",
        workspace_id: "repo:run-1",
        path: "/home/golias/luna/.runs/private",
        preserved: true,
        reason: "created",
        lifecycle: "active",
        captured_at: "2026-07-11T12:00:00.000Z",
        repository_id: "luna",
        remote: "origin",
        base_ref: "main",
        base_sha: "a".repeat(40),
        branch: "feature/safe",
      }),
    )
    expect(worktree.container.textContent).toContain("feature/safe")
    expect(worktree.container.textContent).not.toContain("/home/golias")
    worktree.unmount()

    const validation = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationValidation, {
        passed: false,
        commands: [
          {
            cmd: "/usr/bin/npm",
            args: ["test"],
            exit_code: 1,
            stdout: "secret stdout /home/golias/private",
            stderr: "secret stderr",
            stdout_truncated: false,
            stderr_truncated: true,
            duration_ms: 42,
            timed_out: false,
          },
        ],
      }),
    )
    expect(validation.container.textContent).toContain("Comando 1")
    expect(validation.container.textContent).toContain("saída truncada")
    expect(validation.container.textContent).not.toContain("secret stdout")
    expect(validation.container.textContent).not.toContain("secret stderr")
    expect(validation.container.textContent).not.toContain("/usr/bin/npm")
  })

  it("uses generic fallback for legacy, unknown, non-JSON, and invalid provider payloads", () => {
    const previews: ArtifactPreview[] = [
      jsonPreview(undefined, {}),
      jsonPreview("vendor.future.result.v1", {}),
      {
        ...jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings, {}),
        kind: "text",
        encoding: "utf-8",
        text: "plain",
        redaction: { mode: "best_effort", changed: false },
        render_policy: "plain_text_only",
      } as ArtifactPreview,
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewProviderPublish, {
        operation_id: "pull-request-review.publish",
        skipped: false,
      }),
    ]

    for (const preview of previews) {
      const view = renderView(preview)
      expect(view.getByText("fallback genérico seguro")).toBeDefined()
      view.unmount()
    }
  })

  it("does not create clickable provider or change-request URLs", () => {
    const view = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewProviderPublish, {
        operation_id: "pull-request-review.publish",
        enabled: true,
        skipped: false,
        provider: "github",
        provider_id: "github-main",
        external_id: "review-42",
        url: "javascript:alert(1)",
        event: "comment",
        inline_comments: 2,
        fallback_comments: 0,
      }),
    )

    expect(view.container.textContent).toContain("review-42")
    expect(view.container.textContent).not.toContain("javascript:alert")
    expect(view.container.querySelector("a")).toBeNull()
    view.unmount()

    const changeRequest = renderView(
      jsonPreview(STUDIO_ARTIFACT_SEMANTIC_TYPES.implementationChangeRequest, {
        operation_id: "change-request.create",
        enabled: true,
        skipped: false,
        provider: "github",
        provider_id: "github-main",
        external_id: "42",
        url: "javascript:alert(2)",
        title: "Safe title",
        source_branch: "feature/safe",
        target_branch: "main",
        adopted: false,
      }),
    )
    expect(changeRequest.container.textContent).toContain("Safe title")
    expect(changeRequest.container.textContent).not.toContain("javascript:alert")
    expect(changeRequest.container.querySelector("a")).toBeNull()
  })
})
