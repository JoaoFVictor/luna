import { Trash2Icon, XIcon } from "lucide-react"

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

export function WorkflowMultiSelectionBar({
  count,
  canDelete,
  deleteUnavailableReason,
  deleteOpen,
  onDeleteOpenChange,
  onClear,
  onDelete,
}: {
  count: number
  canDelete: boolean
  deleteUnavailableReason?: string
  deleteOpen: boolean
  onDeleteOpenChange: (open: boolean) => void
  onClear: () => void
  onDelete: () => void
}) {
  return <>
    <div
      className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-background/95 p-1.5 shadow-lg backdrop-blur"
      role="toolbar"
      aria-label={`Ações para ${count} passos selecionados`}
    >
      <span className="px-2 text-sm font-medium">{count} passos selecionados</span>
      <Button
        size="sm"
        variant="destructive"
        disabled={!canDelete}
        title={deleteUnavailableReason}
        onClick={() => onDeleteOpenChange(true)}
      >
        <Trash2Icon aria-hidden="true" /> Excluir
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onClear}>
        <XIcon aria-hidden="true" /><span className="sr-only">Limpar seleção</span>
      </Button>
    </div>
    {deleteUnavailableReason !== undefined && (
      <p className="absolute top-14 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-amber-500/40 bg-background/95 px-3 py-1.5 text-xs text-amber-700 shadow-sm dark:text-amber-300" role="status">
        {deleteUnavailableReason}
      </p>
    )}
    <AlertDialog open={deleteOpen} onOpenChange={onDeleteOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir {count} passos?</AlertDialogTitle>
          <AlertDialogDescription>
            Os passos selecionados e suas conexões serão removidos juntos do draft. As dependências dos passos restantes serão atualizadas automaticamente. Você poderá desfazer pelo histórico do editor.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>Excluir {count} passos</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
