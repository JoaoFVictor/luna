import type { DraftFile, DraftItem } from "@/api/types"
import { pathLabel } from "@/lib/format"

export type DraftFileContents = Record<string, string>

export type DraftFileSessionState = {
  draftId?: string
  serverRevision: number
  serverEtag?: string
  files: DraftFile[]
  baseContents: DraftFileContents
  workingContents: DraftFileContents
  selectedFileKey?: string
}

export type DraftFileSessionSnapshot = {
  draftId: string
  serverRevision: number
  serverEtag: string
  files: DraftFile[]
  baseContents: DraftFileContents
  workingContents: DraftFileContents
}

export type DraftFileWriteEdit = {
  action: "write"
  file: DraftFile["file"]
  content: string
}

export type DraftFileSessionAction =
  | {
      type: "server-received"
      draft: DraftItem
      operationSnapshot?: DraftFileSessionSnapshot
    }
  | { type: "content-edited"; draftId: string; key: string; content: string }
  | { type: "file-selected"; draftId: string; key: string }

export const emptyDraftFileSessionState: DraftFileSessionState = {
  serverRevision: -1,
  files: [],
  baseContents: {},
  workingContents: {},
}

function hasOwn(contents: DraftFileContents, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(contents, key)
}

function contentsEqual(left: DraftFileContents, right: DraftFileContents): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => hasOwn(right, key) && left[key] === right[key])
  )
}

export function draftFileKey(file: DraftFile): string {
  return pathLabel(file.file)
}

function presentFiles(draft: DraftItem): DraftFile[] {
  return draft.files.filter((file) => file.state === "present")
}

function contentsFromFiles(files: DraftFile[]): DraftFileContents {
  return Object.fromEntries(
    files.map((file) => [draftFileKey(file), file.content ?? ""]),
  )
}

function preferredFileKey(files: DraftFile[]): string | undefined {
  const workflowFile = files.find((file) => file.file.path.endsWith("workflow.yaml"))
  return workflowFile === undefined ? files[0] && draftFileKey(files[0]) : draftFileKey(workflowFile)
}

function selectAvailableFile(
  selectedFileKey: string | undefined,
  files: DraftFile[],
): string | undefined {
  if (
    selectedFileKey !== undefined &&
    files.some((file) => draftFileKey(file) === selectedFileKey)
  ) {
    return selectedFileKey
  }
  return preferredFileKey(files)
}

function initializeFromDraft(draft: DraftItem): DraftFileSessionState {
  const files = presentFiles(draft)
  const contents = contentsFromFiles(files)
  return {
    draftId: draft.draft_id,
    serverRevision: draft.record_revision,
    serverEtag: draft.etag,
    files,
    baseContents: contents,
    workingContents: contents,
    selectedFileKey: preferredFileKey(files),
  }
}

function reconcileWorkingContents(
  current: DraftFileSessionState,
  nextBaseContents: DraftFileContents,
  operationSnapshot: DraftFileSessionSnapshot | undefined,
): DraftFileContents {
  const referenceContents =
    operationSnapshot !== undefined && operationSnapshot.draftId === current.draftId
      ? operationSnapshot.workingContents
      : current.baseContents
  const nextWorkingContents = { ...nextBaseContents }

  for (const [key, content] of Object.entries(current.workingContents)) {
    const changedAfterReference =
      !hasOwn(referenceContents, key) || referenceContents[key] !== content
    if (changedAfterReference) nextWorkingContents[key] = content
  }

  return nextWorkingContents
}

function retainLocallyEditedFiles(
  current: DraftFileSessionState,
  nextFiles: DraftFile[],
  nextWorkingContents: DraftFileContents,
): DraftFile[] {
  const nextKeys = new Set(nextFiles.map(draftFileKey))
  const locallyRetained = current.files.filter((file) => {
    const key = draftFileKey(file)
    return !nextKeys.has(key) && hasOwn(nextWorkingContents, key)
  })
  return [...nextFiles, ...locallyRetained]
}

export function draftFileSessionReducer(
  state: DraftFileSessionState,
  action: DraftFileSessionAction,
): DraftFileSessionState {
  if (action.type === "content-edited") {
    if (state.draftId !== action.draftId) return state
    return {
      ...state,
      workingContents: {
        ...state.workingContents,
        [action.key]: action.content,
      },
    }
  }

  if (action.type === "file-selected") {
    if (
      state.draftId !== action.draftId ||
      !state.files.some((file) => draftFileKey(file) === action.key)
    ) {
      return state
    }
    return { ...state, selectedFileKey: action.key }
  }

  if (state.draftId !== action.draft.draft_id) {
    return initializeFromDraft(action.draft)
  }
  if (action.draft.record_revision < state.serverRevision) return state

  const nextFiles = presentFiles(action.draft)
  const nextBaseContents = contentsFromFiles(nextFiles)
  const nextWorkingContents = reconcileWorkingContents(
    state,
    nextBaseContents,
    action.operationSnapshot,
  )
  const reconciledFiles = retainLocallyEditedFiles(
    state,
    nextFiles,
    nextWorkingContents,
  )

  return {
    draftId: action.draft.draft_id,
    serverRevision: action.draft.record_revision,
    serverEtag: action.draft.etag,
    files: reconciledFiles,
    baseContents: nextBaseContents,
    workingContents: nextWorkingContents,
    selectedFileKey: selectAvailableFile(state.selectedFileKey, reconciledFiles),
  }
}

export function draftFileIsDirty(
  state: Pick<DraftFileSessionState, "baseContents" | "workingContents">,
  key: string,
): boolean {
  return (
    !hasOwn(state.baseContents, key) ||
    !hasOwn(state.workingContents, key) ||
    state.baseContents[key] !== state.workingContents[key]
  )
}

export function dirtyDraftFiles(
  state: Pick<DraftFileSessionState, "files" | "baseContents" | "workingContents">,
): DraftFile[] {
  return state.files.filter((file) => draftFileIsDirty(state, draftFileKey(file)))
}

export function snapshotDraftFileSession(
  state: DraftFileSessionState,
): DraftFileSessionSnapshot | undefined {
  if (state.draftId === undefined || state.serverEtag === undefined) return undefined
  return {
    draftId: state.draftId,
    serverRevision: state.serverRevision,
    serverEtag: state.serverEtag,
    files: [...state.files],
    baseContents: { ...state.baseContents },
    workingContents: { ...state.workingContents },
  }
}

export function draftFileWriteEdits(
  snapshot: DraftFileSessionSnapshot,
): DraftFileWriteEdit[] {
  return dirtyDraftFiles(snapshot).map((file) => {
    const key = draftFileKey(file)
    return {
      action: "write",
      file: file.file,
      content: snapshot.workingContents[key] ?? "",
    }
  })
}

export function draftOperationResponseIsCurrent(
  state: DraftFileSessionState,
  responseDraft: DraftItem,
  operationSnapshot: DraftFileSessionSnapshot,
): boolean {
  return (
    state.draftId === responseDraft.draft_id &&
    responseDraft.record_revision >= state.serverRevision &&
    operationSnapshot.draftId === state.draftId &&
    contentsEqual(state.workingContents, operationSnapshot.workingContents)
  )
}
