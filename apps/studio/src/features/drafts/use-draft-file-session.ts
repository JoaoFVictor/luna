import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"

import type { DraftItem } from "@/api/types"
import {
  dirtyDraftFiles,
  draftOperationResponseIsCurrent,
  draftFileSessionReducer,
  emptyDraftFileSessionState,
  snapshotDraftFileSession,
  type DraftFileSessionSnapshot,
} from "@/features/drafts/draft-file-session"

export function useDraftFileSession(draft: DraftItem | undefined) {
  const [state, dispatch] = useReducer(
    draftFileSessionReducer,
    emptyDraftFileSessionState,
  )
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (draft === undefined) return
    dispatch({ type: "server-received", draft })
  }, [draft])

  const dirtyFiles = useMemo(() => dirtyDraftFiles(state), [state])

  const editContent = useCallback(
    (key: string, content: string) => {
      if (state.draftId === undefined) return
      dispatch({ type: "content-edited", draftId: state.draftId, key, content })
    },
    [state.draftId],
  )

  const selectFile = useCallback(
    (key: string) => {
      if (state.draftId === undefined) return
      dispatch({ type: "file-selected", draftId: state.draftId, key })
    },
    [state.draftId],
  )

  const captureSnapshot = useCallback(
    () => snapshotDraftFileSession(stateRef.current),
    [],
  )

  const acceptServerDraft = useCallback(
    (nextDraft: DraftItem, operationSnapshot?: DraftFileSessionSnapshot) => {
      dispatch({
        type: "server-received",
        draft: nextDraft,
        operationSnapshot,
      })
    },
    [],
  )

  const operationResponseIsCurrent = useCallback(
    (responseDraft: DraftItem, operationSnapshot: DraftFileSessionSnapshot) =>
      draftOperationResponseIsCurrent(
        stateRef.current,
        responseDraft,
        operationSnapshot,
      ),
    [],
  )

  return {
    files: state.files,
    baseContents: state.baseContents,
    workingContents: state.workingContents,
    selectedFileKey: state.selectedFileKey,
    dirtyFiles,
    hasLocalChanges: dirtyFiles.length > 0,
    editContent,
    selectFile,
    captureSnapshot,
    acceptServerDraft,
    operationResponseIsCurrent,
  }
}
