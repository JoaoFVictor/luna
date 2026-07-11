import { useEffect, useRef } from "react"

export function useAgentEditorAutomation({ canMutate, hasFileChanges, hasLocalChanges, contentRevision, saving, editing, writing, validating, save, validate }: {
  canMutate: boolean
  hasFileChanges: boolean
  hasLocalChanges: boolean
  contentRevision: number | undefined
  saving: boolean
  editing: boolean
  writing: boolean
  validating: boolean
  save: () => void
  validate: () => void
}) {
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "s") return
      event.preventDefault()
      if (canMutate && hasFileChanges && !saving) save()
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [canMutate, hasFileChanges, save, saving])

  useEffect(() => {
    if (!canMutate || !hasFileChanges || saving || editing || writing) return
    const timeout = window.setTimeout(save, 800)
    return () => window.clearTimeout(timeout)
  }, [canMutate, editing, hasFileChanges, save, saving, writing])

  const observedRevision = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (contentRevision === undefined || observedRevision.current === contentRevision || !canMutate || hasLocalChanges || saving || validating || editing || writing) return
    const timeout = window.setTimeout(() => {
      observedRevision.current = contentRevision
      validate()
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [canMutate, contentRevision, editing, hasLocalChanges, save, saving, validate, validating, writing])
}
