import type { ApplyPlan } from "@/api/types"
import type { WorkflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ApplyPlanPreview } from "@/features/workflows/apply-plan-preview"

export function ApplyPlanDialog({
  plan,
  open,
  applying,
  sideEffects,
  onOpenChange,
  onApply,
}: {
  plan: ApplyPlan | undefined
  open: boolean
  applying: boolean
  sideEffects: readonly WorkflowSideEffectPreview[]
  onOpenChange: (open: boolean) => void
  onApply: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Plano de apply</DialogTitle>
          <DialogDescription>
            Revise todos os arquivos. Apply escreve o change set no projeto; não faz commit, push nem executa o workflow.
          </DialogDescription>
        </DialogHeader>
        {plan === undefined && open
          ? <p className="py-8 text-center text-sm text-muted-foreground">Gerando plano autoritativo…</p>
          : <ApplyPlanPreview plan={plan} sideEffects={sideEffects} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          <Button
            onClick={onApply}
            disabled={plan?.status !== "ready" || plan.diff.length === 0 || applying}
          >
            {applying ? "Aplicando…" : "Confirmar apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
