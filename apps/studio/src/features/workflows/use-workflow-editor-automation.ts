import { useEffect, useRef } from "react"

export function useWorkflowEditorAutomation({
  canMutate,
  hasLocalChanges,
  contentRevision,
  saving,
  editing,
  compiling,
  save,
  compile,
  undo,
  redo,
}: {
  canMutate: boolean
  hasLocalChanges: boolean
  contentRevision: number | undefined
  saving: boolean
  editing: boolean
  compiling: boolean
  save: () => void
  compile: (background: boolean) => void
  undo: () => void
  redo: () => void
}) {
  useEffect(() => {
    if (!canMutate || !hasLocalChanges || saving || editing) return
    const timeout = window.setTimeout(save, 800)
    return () => window.clearTimeout(timeout)
  }, [canMutate, editing, hasLocalChanges, save, saving])

  const observedRevision = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (contentRevision === undefined || observedRevision.current === contentRevision) return
    if (!canMutate || hasLocalChanges || compiling || editing || saving) return
    const timeout = window.setTimeout(() => {
      observedRevision.current = contentRevision
      compile(true)
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [canMutate, compile, compiling, contentRevision, editing, hasLocalChanges, saving])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target
      const editingText = target instanceof HTMLElement && (
        target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      )
      const key = event.key.toLocaleLowerCase()
      if (!editingText && key === "z") {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (!editingText && key === "y") {
        event.preventDefault()
        redo()
      } else if (key === "s") {
        event.preventDefault()
        if (canMutate && hasLocalChanges && !saving) save()
      } else if (event.key === "Enter") {
        event.preventDefault()
        if (canMutate && !hasLocalChanges && !compiling) compile(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [canMutate, compile, compiling, hasLocalChanges, redo, save, saving, undo])
}
