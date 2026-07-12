import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, DownloadIcon, FileTextIcon, Settings2Icon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { artifactPreviewQuery, artifactsQuery } from "@/api/queries"
import type { ArtifactPreview, ArtifactSummary } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  redactPhysicalPaths,
  redactPhysicalPathsInJson,
} from "@/features/runs/artifact-views/common"
import { SpecializedArtifactView } from "@/features/runs/artifact-views/specialized-artifact-view"
import { formatDateTime } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

function GenericArtifactPreview({ preview }: { preview: ArtifactPreview }) {
  if (preview.kind === "json") {
    return (
      <div className="max-h-96 overflow-auto overscroll-contain rounded-lg border bg-muted/40">
        <pre className="p-3 text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(redactPhysicalPathsInJson(preview.value), null, 2)}
        </pre>
      </div>
    )
  }

  if (preview.kind === "text") {
    return (
      <div className="max-h-96 overflow-auto overscroll-contain rounded-lg border bg-muted/40">
        <pre className="p-3 text-xs whitespace-pre-wrap break-words">
          {redactPhysicalPaths(preview.text)}
        </pre>
      </div>
    )
  }

  return (
    <p className="rounded-lg border p-3 text-sm text-muted-foreground">
      Preview inline bloqueado:{" "}
      {preview.reason === "active_content"
        ? "conteúdo ativo"
        : "conteúdo binário"}
      .
    </p>
  )
}

function ArtifactPreviewBody({
  runId,
  handle,
}: {
  runId: string
  handle: string
}) {
  const preview = useQuery(artifactPreviewQuery(runId, handle))
  if (preview.isPending) return <PageLoading label="Inspecionando artifact" />
  if (preview.isError) {
    return <PageError error={preview.error} retry={() => void preview.refetch()} />
  }

  const value = preview.data
  const copyable = value.kind === "json"
    ? JSON.stringify(redactPhysicalPathsInJson(value.value), null, 2)
    : value.kind === "text"
      ? redactPhysicalPaths(value.text)
      : undefined
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">{value.kind}</Badge>
        <Badge variant="outline">integrity: {value.integrity}</Badge>
        {"redaction" in value && (
          <Badge variant={value.redaction.changed ? "secondary" : "outline"}>
            redaction {value.redaction.changed ? "aplicada" : "sem mudança detectada"}
          </Badge>
        )}
        {value.truncated && <Badge variant="secondary">preview truncado</Badge>}
        {value.metadata.semantic_type !== undefined && (
          <Badge variant="outline" className="max-w-full break-all">
            {value.metadata.semantic_type}
          </Badge>
        )}
      </div>
      <SpecializedArtifactView
        preview={value}
        genericFallback={<GenericArtifactPreview preview={value} />}
      />
      <Alert variant="destructive">
        <ShieldAlertIcon aria-hidden="true" />
        <AlertTitle>Download contém bytes originais</AlertTitle>
        <AlertDescription>
          O download não recebe redaction. Trate o arquivo como potencialmente sensível e não confiável.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        {copyable !== undefined && (
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(copyable).then(
                () => toast.success("Preview seguro copiado para reutilização"),
                () => toast.error("O navegador não permitiu copiar o preview"),
              )
            }}
          >
            <CopyIcon aria-hidden="true" /> Copiar preview seguro
          </Button>
        )}
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <a href={studioApi.artifactDownloadUrl(runId, handle)} download>
              <DownloadIcon aria-hidden="true" /> Baixar original
            </a>
          }
        />
      </div>
    </div>
  )
}

function unavailableArtifactCopy(artifact: ArtifactSummary) {
  if (artifact.status === "pending") {
    return {
      title: "Artifact ainda está sendo produzido",
      description: "O Studio atualizará a listagem; o preview só será solicitado quando o manifest estiver legível.",
    }
  }
  if (artifact.status === "failed") {
    return {
      title: "Artifact falhou antes de ficar disponível",
      description: "Não há conteúdo seguro para preview ou download neste manifest.",
    }
  }
  return {
    title: "Artifact indisponível",
    description: "O backend declarou que este manifest não pode ser lido pelo Studio.",
  }
}

function defaultArtifactHandle(
  artifacts: readonly ArtifactSummary[],
): string {
  return artifacts.find(
    (artifact) => artifact.preview_capability !== "unavailable",
  )?.manifest_handle ?? artifacts[0]?.manifest_handle ?? ""
}

/**
 * Filesystem readers can expose implementation manifests alongside authored
 * outputs. They are still inspectable, but should not compete with results in
 * the default view. This deliberately uses presentation metadata only: the
 * backend remains the source of truth and no provider-specific names are
 * assumed.
 */
function isInternalManifest(artifact: ArtifactSummary): boolean {
  const stem = artifact.name.replace(/\.[A-Za-z0-9]+$/, "")
  const hashNamed = /^(?:[a-f0-9]{32,}|(?:manifest|artifact)[._-][a-f0-9]{12,})$/i.test(stem)
  if (!hashNamed) return false
  // Pending, preview-less hash manifests are reader bookkeeping aliases. A
  // committed authored output can still have a hash-like name and must stay
  // visible when it carries semantic or node provenance.
  if (artifact.status === "pending" && artifact.preview_capability === "unavailable") {
    return true
  }
  return artifact.semantic_type === undefined && artifact.source_node_id === undefined
}

function artifactDisplayName(artifact: ArtifactSummary): string {
  if (!isInternalManifest(artifact)) return artifact.name
  const stem = artifact.name.replace(/\.[A-Za-z0-9]+$/, "")
  return `Manifest técnico · ${stem.slice(0, 12)}${stem.length > 12 ? "…" : ""}`
}

function artifactStatusLabel(status: ArtifactSummary["status"]): string {
  if (status === "committed") return "pronto"
  if (status === "pending") return "processando"
  if (status === "failed") return "falhou"
  return status
}

export function ArtifactsPanel({
  runId,
  expectedCount,
  terminalAt,
}: {
  runId: string
  expectedCount?: number
  terminalAt?: string
}) {
  const artifacts = useQuery(artifactsQuery(runId, { expectedCount, terminalAt }))
  const [selected, setSelected] = useState("")
  const [showTechnical, setShowTechnical] = useState(false)

  const groupedArtifacts = useMemo(() => {
    const items = artifacts.data?.items ?? []
    return {
      results: items.filter((item) => !isInternalManifest(item)),
      technical: items.filter(isInternalManifest),
    }
  }, [artifacts.data?.items])

  const visibleArtifacts = showTechnical
    ? [...groupedArtifacts.results, ...groupedArtifacts.technical]
    : groupedArtifacts.results

  useEffect(() => {
    if (
      artifacts.data !== undefined &&
      !visibleArtifacts.some((item) => item.manifest_handle === selected)
    ) {
      setSelected(defaultArtifactHandle(visibleArtifacts))
    }
  }, [artifacts.data, selected, visibleArtifacts])

  if (artifacts.isPending) return <PageLoading label="Carregando artifacts" />
  if (artifacts.isError) {
    return <PageError error={artifacts.error} retry={() => void artifacts.refetch()} />
  }
  if (artifacts.data.items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nenhum artifact exposto pelo reader.</p>
  }
  const selectedArtifact = visibleArtifacts.find(
    (artifact) => artifact.manifest_handle === selected,
  )
  const unavailable =
    selectedArtifact === undefined
      ? undefined
      : unavailableArtifactCopy(selectedArtifact)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-heading text-sm font-medium">Resultados da execução</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {groupedArtifacts.results.length} resultado{groupedArtifacts.results.length === 1 ? " final" : "s finais"}
            {groupedArtifacts.technical.length > 0 && ` · ${groupedArtifacts.technical.length} manifest${groupedArtifacts.technical.length === 1 ? "" : "s"} técnico${groupedArtifacts.technical.length === 1 ? "" : "s"} oculto${groupedArtifacts.technical.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {groupedArtifacts.technical.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowTechnical((current) => !current)}
            aria-pressed={showTechnical}
          >
            <Settings2Icon aria-hidden="true" /> {showTechnical ? "Ocultar técnicos" : "Mostrar técnicos"}
          </Button>
        )}
      </div>
      {visibleArtifacts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nenhum resultado final disponível</p>
          <p className="mt-1 text-xs text-muted-foreground">A execução só expôs manifests técnicos.</p>
          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setShowTechnical(true)}>
            <Settings2Icon aria-hidden="true" /> Mostrar manifests técnicos
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="space-y-2 pr-2" aria-label="Resultados da execução">
            {visibleArtifacts.map((artifact) => (
          <button
            key={artifact.manifest_handle}
            type="button"
            aria-pressed={selected === artifact.manifest_handle}
            title={artifact.name}
            className="w-full rounded-lg border p-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:border-primary"
            data-selected={selected === artifact.manifest_handle}
            onClick={() => setSelected(artifact.manifest_handle)}
          >
            <span className="flex items-center justify-between gap-2 font-medium"><span className="flex min-w-0 items-center gap-2"><FileTextIcon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{artifactDisplayName(artifact)}</span>{isInternalManifest(artifact) && <span className="sr-only">{artifact.name}</span>}</span><span className="flex shrink-0 items-center gap-1"><Badge variant={isInternalManifest(artifact) ? "secondary" : artifact.status === "failed" ? "destructive" : "outline"}>{isInternalManifest(artifact) ? "técnico" : artifactStatusLabel(artifact.status)}</Badge></span></span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {artifact.media_type} · tentativa {artifact.attempt}
            </span>
            {artifact.source_node_id !== undefined && (
              <span className="mt-1 block break-all text-xs text-muted-foreground">
                etapa: {humanizeTechnicalId(artifact.source_node_id)}
              </span>
            )}
            {artifact.semantic_type !== undefined && (
              <span className="mt-1 block break-all text-xs text-muted-foreground">
                {artifact.semantic_type}
              </span>
            )}
            <span className="mt-1 block text-xs text-muted-foreground">{formatDateTime(artifact.created_at)}</span>
          </button>
            ))}
          </div>
          <Card>
        <CardHeader>
          <CardTitle>Preview seguro</CardTitle>
          <CardDescription>
            View tipada quando o semantic_type é conhecido; fallback em texto puro ou
            JSON estruturado. HTML/SVG nunca é injetado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {selectedArtifact?.preview_capability === "unavailable" && unavailable !== undefined ? (
            <Alert variant={selectedArtifact.status === "failed" ? "destructive" : "default"}>
              <ShieldAlertIcon aria-hidden="true" />
              <AlertTitle>{unavailable.title}</AlertTitle>
              <AlertDescription>{unavailable.description}</AlertDescription>
            </Alert>
          ) : selectedArtifact !== undefined ? (
            <ArtifactPreviewBody
              runId={runId}
              handle={selectedArtifact.manifest_handle}
            />
          ) : null}
        </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
