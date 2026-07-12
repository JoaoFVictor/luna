import { Trash2Icon } from "lucide-react"

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
import { Button } from "@/components/ui/button"

export function WorkflowDraftDeleteControl({
  open,
  canDelete,
  deleting,
  onOpenChange,
  onDelete,
}: {
  open: boolean
  canDelete: boolean
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
}) {
  return (
    <>
      <div className="relative z-20 shrink-0 border-t bg-background px-4 py-3">
        <Button
          className="border-destructive/40 text-foreground"
          variant="destructive"
          size="sm"
          disabled={!canDelete}
          onClick={() => onOpenChange(true)}
        >
          <Trash2Icon aria-hidden="true" /> Remover draft
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover este draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Somente o change set isolado será removido. Arquivos já aplicados no projeto não são apagados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? "Removendo…" : "Remover draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function UnsavedWorkflowNavigationDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onKeepEditing()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Descartar alterações não salvas?</AlertDialogTitle>
          <AlertDialogDescription>
            O draft persistido continuará existindo, mas o texto alterado apenas nesta aba será perdido.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Continuar editando</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDiscard}>
            Descartar e sair
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
