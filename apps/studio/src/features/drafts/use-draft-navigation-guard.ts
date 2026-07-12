import { useEffect } from "react"
import { useBlocker } from "react-router-dom"

import { useEditorState } from "@/app/studio-context"

export function useDraftNavigationGuard(hasLocalChanges: boolean) {
  const { setHasLocalChanges } = useEditorState()
  const blocker = useBlocker(hasLocalChanges)

  useEffect(() => {
    setHasLocalChanges(hasLocalChanges)
    return () => setHasLocalChanges(false)
  }, [hasLocalChanges, setHasLocalChanges])

  useEffect(() => {
    if (!hasLocalChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warnBeforeUnload)
    return () => window.removeEventListener("beforeunload", warnBeforeUnload)
  }, [hasLocalChanges])

  return blocker
}
