import type { z } from "zod"

import { Badge } from "@/components/ui/badge"

import {
  ReviewAcceptanceViewSchema,
  ReviewCoverageCheckViewSchema,
  ReviewCoveragePlanViewSchema,
  ReviewFindingsViewSchema,
  ReviewProviderPublishViewSchema,
} from "./review-schemas"
import {
  ArtifactMetrics,
  ArtifactStringList,
  ArtifactViewFrame,
  SafeArtifactText,
} from "./view-primitives"

export function ReviewFindingsView({
  value,
}: {
  value: z.infer<typeof ReviewFindingsViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Findings da revisão">
      <ArtifactMetrics
        items={[
          { label: "Findings", value: value.findings.length },
          { label: "Faixas revisadas", value: value.reviewed_range_count },
        ]}
      />
      {value.summary !== undefined && (
        <p className="text-sm text-muted-foreground">
          <SafeArtifactText>{value.summary}</SafeArtifactText>
        </p>
      )}
      {value.findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum finding reportado.</p>
      ) : (
        <ol className="space-y-3">
          {value.findings.map((finding, index) => (
            <li key={`${index}:${finding.title}`} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="font-medium">
                  <SafeArtifactText>{finding.title}</SafeArtifactText>
                </h4>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">severidade: {finding.severity}</Badge>
                  <Badge variant="outline">confiança: {finding.confidence}</Badge>
                  {finding.category !== undefined && (
                    <Badge variant="secondary">{finding.category}</Badge>
                  )}
                </div>
              </div>
              <p className="text-sm">
                <SafeArtifactText>{finding.description}</SafeArtifactText>
              </p>
              <div>
                <h5 className="text-xs font-medium text-muted-foreground">Evidências</h5>
                {finding.evidence.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">Sem evidência publicável.</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                    {finding.evidence.map((evidence) => (
                      <li
                        key={`${evidence.path}:${evidence.line_start}:${evidence.line_end}`}
                        className="rounded border px-2 py-1"
                      >
                        {evidence.path}:{evidence.line_start}-{evidence.line_end}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-sm">
                <span className="font-medium">Recomendação: </span>
                <SafeArtifactText>{finding.recommendation}</SafeArtifactText>
              </p>
            </li>
          ))}
        </ol>
      )}
    </ArtifactViewFrame>
  )
}

type CoverageValue =
  | z.infer<typeof ReviewCoveragePlanViewSchema>
  | z.infer<typeof ReviewCoverageCheckViewSchema>

export function ReviewCoverageView({ value }: { value: CoverageValue }) {
  const missing = value.missing_ranges.map(
    (range) => `${range.path}:${range.line_start}-${range.line_end}`,
  )
  const blocked = value.blocked_ranges.map(
    (range) => `${range.path}: ${range.reason}`,
  )

  return (
    <ArtifactViewFrame
      title={value.kind === "plan" ? "Plano de cobertura" : "Cobertura verificada"}
      status={value.status}
    >
      <p className="text-sm text-muted-foreground">
        <SafeArtifactText>{value.summary}</SafeArtifactText>
      </p>
      <ArtifactMetrics items={value.metrics} />
      <ArtifactStringList title="Faixas ausentes" items={missing} />
      <ArtifactStringList title="Faixas bloqueadas" items={blocked} />
    </ArtifactViewFrame>
  )
}

export function ReviewAcceptanceView({
  value,
}: {
  value: z.infer<typeof ReviewAcceptanceViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Decisão de aceitação" status={value.status}>
      <p className="text-sm">
        <SafeArtifactText>{value.summary}</SafeArtifactText>
      </p>
      <ArtifactMetrics
        items={[
          { label: "Ação recomendada", value: value.recommended_action },
          { label: "Bloqueios", value: value.blocking_reasons.length },
        ]}
      />
      <ArtifactStringList title="Razões de bloqueio" items={value.blocking_reasons} />
    </ArtifactViewFrame>
  )
}

export function ReviewProviderPublishView({
  value,
}: {
  value: z.infer<typeof ReviewProviderPublishViewSchema>
}) {
  if (value.status === "skipped") {
    return (
      <ArtifactViewFrame title="Publicação no provider" status="não publicada">
        <ArtifactMetrics
          items={[{ label: "Integração habilitada", value: value.enabled ? "sim" : "não" }]}
        />
        <p className="text-sm text-muted-foreground">
          <SafeArtifactText>{value.reason}</SafeArtifactText>
        </p>
      </ArtifactViewFrame>
    )
  }

  return (
    <ArtifactViewFrame title="Publicação no provider" status="publicada">
      <ArtifactMetrics
        items={[
          { label: "Provider", value: value.provider },
          { label: "Evento", value: value.event },
          { label: "Comentários inline", value: value.inline_comments },
          { label: "Comentários fallback", value: value.fallback_comments },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Referência externa: <SafeArtifactText>{value.external_id}</SafeArtifactText>
      </p>
    </ArtifactViewFrame>
  )
}
