import { useMemo, useState, useSyncExternalStore } from "react"

import { studioApi } from "@/api/client"
import type { BootstrapState } from "@/api/types"
import { EditorStateContext, SessionContext } from "@/app/studio-context"

export function SessionProvider({
  bootstrap,
  children,
}: {
  bootstrap: BootstrapState
  children: React.ReactNode
}) {
  const current = useSyncExternalStore(
    studioApi.subscribeSession,
    studioApi.sessionSnapshot,
    () => bootstrap,
  )
  const value = useMemo(
    () => ({ bootstrap: current, canMutate: current.mode === "full" }),
    [current],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function EditorStateProvider({ children }: { children: React.ReactNode }) {
  const [hasLocalChanges, setHasLocalChanges] = useState(false)
  const value = useMemo(
    () => ({ hasLocalChanges, setHasLocalChanges }),
    [hasLocalChanges],
  )
  return (
    <EditorStateContext.Provider value={value}>
      {children}
    </EditorStateContext.Provider>
  )
}
