import type { ResourceHistoryRevision } from "@/api/types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { shortDigest } from "@/lib/format"

export function ResourceHistoryRestoreDialog({
  open,
  pending,
  revision,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  pending: boolean
  revision: ResourceHistoryRevision | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Criar draft da revisão histórica?</AlertDialogTitle>
          <AlertDialogDescription>
            A revisão {shortDigest(revision?.revision_id, 12)} será copiada para um
            novo draft isolado. O projeto, o branch e o histórico Git não serão
            alterados. Depois você ainda precisa validar, revisar o diff e confirmar
            o apply normal.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || revision === undefined}
            onClick={onConfirm}
          >
            {pending ? "Criando draft…" : "Criar novo draft"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
