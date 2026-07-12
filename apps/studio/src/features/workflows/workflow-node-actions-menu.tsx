import { useRef, useState } from "react"
import { ClipboardPasteIcon, CopyIcon, FastForwardIcon, FilesIcon, FocusIcon, MoreHorizontalIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
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

export function WorkflowNodeActionsMenu({
  pinned,
  canMutate,
  canPaste,
  onCopy,
  onDuplicate,
  onTogglePin,
  onPaste,
  onDelete,
  onTestIsolated,
  onTestFromHere,
  isolatedTestUnavailableReason,
  fromHereTestUnavailableReason,
  deleteUnavailableReason,
}: {
  pinned: boolean
  canMutate: boolean
  canPaste: boolean
  onCopy: () => void
  onDuplicate: () => void
  onTogglePin: () => void
  onPaste: () => void
  onDelete: () => void
  onTestIsolated: () => void
  onTestFromHere: () => void
  isolatedTestUnavailableReason?: string
  fromHereTestUnavailableReason?: string
  deleteUnavailableReason?: string
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const run = (action: () => void) => {
    action()
    details.current?.removeAttribute("open")
  }

  return <>
    <details ref={details} className="relative z-20">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium hover:bg-muted">
        <MoreHorizontalIcon className="size-4" aria-hidden="true" /> Ações
      </summary>
      <div className="absolute top-10 right-0 grid min-w-48 gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg">
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          disabled={isolatedTestUnavailableReason !== undefined}
          title={isolatedTestUnavailableReason}
          onClick={() => run(onTestIsolated)}
        >
          <FocusIcon aria-hidden="true" /> Executar somente este
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          disabled={fromHereTestUnavailableReason !== undefined}
          title={fromHereTestUnavailableReason}
          onClick={() => run(onTestFromHere)}
        >
          <FastForwardIcon aria-hidden="true" /> Executar daqui em diante
        </Button>
        <div className="my-1 border-t" />
        <Button size="sm" variant="ghost" className="justify-start" onClick={() => run(onCopy)}>
          <CopyIcon aria-hidden="true" /> Copiar passo
        </Button>
        <Button size="sm" variant="ghost" className="justify-start" disabled={!canMutate} onClick={() => run(onDuplicate)}>
          <FilesIcon aria-hidden="true" /> Duplicar passo
        </Button>
        <Button size="sm" variant="ghost" className="justify-start" disabled={!canMutate} onClick={() => run(onTogglePin)}>
          {pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
          {pinned ? "Liberar posição" : "Fixar posição"}
        </Button>
        <Button size="sm" variant="ghost" className="justify-start" disabled={!canMutate || !canPaste} onClick={() => run(onPaste)}>
          <ClipboardPasteIcon aria-hidden="true" /> Colar depois
        </Button>
        <div className="my-1 border-t" />
        <Button
          size="sm"
          variant="ghost"
          className="justify-start text-destructive hover:text-destructive"
          disabled={!canMutate || deleteUnavailableReason !== undefined}
          title={deleteUnavailableReason}
          onClick={() => {
            details.current?.removeAttribute("open")
            setDeleteOpen(true)
          }}
        >
          <Trash2Icon aria-hidden="true" /> Excluir passo
        </Button>
        {deleteUnavailableReason !== undefined && (
          <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300" role="status">
            {deleteUnavailableReason}
          </p>
        )}
      </div>
    </details>
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir este passo?</AlertDialogTitle>
          <AlertDialogDescription>
            O passo e as conexões que chegam aos próximos passos serão removidos do draft. Você poderá desfazer pelo histórico do editor.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>Excluir passo</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
