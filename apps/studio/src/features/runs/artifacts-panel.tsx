import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, DownloadIcon, FileTextIcon, ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { artifactPreviewQuery, artifactsQuery } from "@/api/queries"
import type { ArtifactPreview, ArtifactSummary } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  redactPhysicalPaths,
  redactPhysicalPathsInJson,
} from "@/features/runs/artifact-views/common"
import { SpecializedArtifactView } from "@/features/runs/artifact-views/specialized-artifact-view"
import { formatDateTime } from "@/lib/format"

function GenericArtifactPreview({ preview }: { preview: ArtifactPreview }) {
  if (preview.kind === "json") {
    return (
      <ScrollArea className="max-h-96 rounded-lg border bg-muted/40">
        <pre className="p-3 text-xs">
          {JSON.stringify(redactPhysicalPathsInJson(preview.value), null, 2)}
        </pre>
      </ScrollArea>
    )
  }

  if (preview.kind === "text") {
    return (
      <ScrollArea className="max-h-96 rounded-lg border bg-muted/40">
        <pre className="p-3 text-xs whitespace-pre-wrap">
          {redactPhysicalPaths(preview.text)}
        </pre>
      </ScrollArea>
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

  useEffect(() => {
    if (
      artifacts.data !== undefined &&
      !artifacts.data.items.some((item) => item.manifest_handle === selected)
    ) {
      setSelected(defaultArtifactHandle(artifacts.data.items))
    }
  }, [artifacts.data, selected])

  if (artifacts.isPending) return <PageLoading label="Carregando artifacts" />
  if (artifacts.isError) {
    return <PageError error={artifacts.error} retry={() => void artifacts.refetch()} />
  }
  if (artifacts.data.items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nenhum artifact exposto pelo reader.</p>
  }
  const selectedArtifact = artifacts.data.items.find(
    (artifact) => artifact.manifest_handle === selected,
  )
  const unavailable =
    selectedArtifact === undefined
      ? undefined
      : unavailableArtifactCopy(selectedArtifact)

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-2" aria-label="Artifacts da run">
        {artifacts.data.items.map((artifact) => (
          <button
            key={artifact.manifest_handle}
            type="button"
            aria-pressed={selected === artifact.manifest_handle}
            className="w-full rounded-lg border p-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:border-primary"
            data-selected={selected === artifact.manifest_handle}
            onClick={() => setSelected(artifact.manifest_handle)}
          >
            <span className="flex items-center justify-between gap-2 font-medium"><span className="flex min-w-0 items-center gap-2"><FileTextIcon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{artifact.name}</span></span><Badge variant={artifact.status === "failed" ? "destructive" : "outline"}>{artifact.status}</Badge></span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {artifact.media_type} · tentativa {artifact.attempt}
            </span>
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
  )
}
