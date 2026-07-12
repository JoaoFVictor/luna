import type { ResourceHistoryCompare } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { pathLabel, shortDigest } from "@/lib/format"

const DIFF_KIND_LABELS = {
  created: "Criado",
  modified: "Alterado",
  deleted: "Removido",
} as const

export function ResourceHistoryDiff({
  comparison,
}: {
  comparison: ResourceHistoryCompare
}) {
  if (comparison.diff.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nenhuma diferença</CardTitle>
          <CardDescription>
            As duas revisões selecionadas têm o mesmo conteúdo para este recurso.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-4" aria-label="Diferenças entre revisões">
      {comparison.diff.map((change) => (
        <Card key={`${change.file.root}:${change.file.path}`}>
          <CardHeader className="gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="break-all font-mono text-sm">
                {pathLabel(change.file)}
              </CardTitle>
              <Badge variant="outline">{DIFF_KIND_LABELS[change.kind]}</Badge>
              <Badge variant="secondary">Conteúdo sensível redigido</Badge>
            </div>
            <CardDescription className="font-mono text-xs">
              {shortDigest(change.before_sha256 ?? undefined)} →{" "}
              {shortDigest(change.after_sha256 ?? undefined)}
              {change.textual_diff_truncated ? " · diff truncado pelo servidor" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">
              {change.textual_diff.length > 0
                ? change.textual_diff
                : "Alteração binária ou sem projeção textual segura."}
            </pre>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
