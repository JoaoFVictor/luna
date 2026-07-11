import { FileDiffIcon } from "lucide-react"

import type { ApplyPlan, DraftFile } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { draftFileIsDirty, draftFileKey, type DraftFileContents } from "@/features/drafts/draft-file-session"
import { ApplyPlanPreview } from "@/features/workflows/apply-plan-preview"
import type { WorkflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"
import { pathLabel } from "@/lib/format"

export function DraftDiffView({
  files,
  baseContents,
  workingContents,
  plan,
  sideEffects,
  canPlan,
  planning,
  onPlan,
}: {
  files: DraftFile[]
  baseContents: DraftFileContents
  workingContents: DraftFileContents
  plan: ApplyPlan | undefined
  sideEffects: readonly WorkflowSideEffectPreview[]
  canPlan: boolean
  planning: boolean
  onPlan: () => void
}) {
  const changed = files.filter((file) =>
    draftFileIsDirty({ baseContents, workingContents }, draftFileKey(file)),
  )
  return (
    <div className="min-h-[calc(100vh-15rem)] space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Diff multi-file</h2>
          <p className="text-xs text-muted-foreground">
            Alterações locais aparecem abaixo; o plano autoritativo recalcula hashes e todos os arquivos no servidor.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={!canPlan || planning} onClick={onPlan}>
          <FileDiffIcon aria-hidden="true" />
          {planning ? "Recalculando…" : "Gerar diff autoritativo"}
        </Button>
      </div>
      {changed.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          Nenhuma alteração local não salva. Alterações estruturadas já persistidas aparecem no plano de apply.
        </p>
      ) : changed.map((file) => {
        const key = draftFileKey(file)
        return (
          <section key={key} className="overflow-hidden rounded-lg border">
            <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
              <FileDiffIcon className="size-4" aria-hidden="true" />
              <code className="min-w-0 flex-1 truncate text-xs">{pathLabel(file.file)}</code>
              <Badge variant="secondary">alterado localmente</Badge>
            </header>
            <div className="grid md:grid-cols-2">
              <div className="min-w-0 border-b md:border-r md:border-b-0">
                <p className="border-b px-3 py-1 text-[11px] font-medium text-muted-foreground">Base</p>
                <pre className="max-h-[55vh] overflow-auto p-3 text-xs">{baseContents[key] ?? ""}</pre>
              </div>
              <div className="min-w-0">
                <p className="border-b px-3 py-1 text-[11px] font-medium text-muted-foreground">Nesta aba</p>
                <pre className="max-h-[55vh] overflow-auto p-3 text-xs">{workingContents[key] ?? ""}</pre>
              </div>
            </div>
          </section>
        )
      })}
      <section className="space-y-3 border-t pt-4" aria-label="Plano autoritativo de apply">
        <div>
          <h2 className="text-sm font-medium">Plano autoritativo do servidor</h2>
          <p className="text-xs text-muted-foreground">Redigido, com detecção de colisões e side effects antes de qualquer escrita no projeto.</p>
        </div>
        {planning
          ? <p className="py-8 text-center text-sm text-muted-foreground">Gerando plano autoritativo…</p>
          : <ApplyPlanPreview plan={plan} sideEffects={sideEffects} />}
      </section>
    </div>
  )
}
