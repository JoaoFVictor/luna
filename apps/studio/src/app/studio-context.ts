import { createContext, useContext } from "react"

import type { BootstrapState } from "@/api/types"

export type SessionContextValue = {
  bootstrap: BootstrapState
  canMutate: boolean
}

export const SessionContext = createContext<SessionContextValue | undefined>(
  undefined,
)

export function useStudioSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (value === undefined) {
    throw new Error("useStudioSession must be used within SessionProvider")
  }
  return value
}

export type EditorStateContextValue = {
  hasLocalChanges: boolean
  setHasLocalChanges: (dirty: boolean) => void
}

export const EditorStateContext = createContext<EditorStateContextValue | undefined>(
  undefined,
)

export function useEditorState(): EditorStateContextValue {
  const value = useContext(EditorStateContext)
  if (value === undefined) {
    throw new Error("useEditorState must be used within EditorStateProvider")
  }
  return value
}
