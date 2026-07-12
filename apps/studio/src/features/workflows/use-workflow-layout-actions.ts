import { useCallback } from "react"

import type { DraftItem, JsonValue } from "@/api/types"
import { withoutWorkflowExpressionFixture, withWorkflowExpressionFixture } from "./workflow-expression-fixtures"
import { withWorkflowCanvasLayout, withWorkflowNodeNote, type WorkflowCanvasLayout } from "./workflow-layout"

export function useWorkflowLayoutActions(draft: DraftItem | undefined, persist: (layout: JsonValue, message: string) => void) {
  const saveCanvasLayout = useCallback((canvas: WorkflowCanvasLayout) => {
    if (draft === undefined) return
    persist(withWorkflowCanvasLayout(draft.layout, canvas), "Layout salvo")
  }, [draft, persist])
  const saveNodeNote = useCallback((nodeId: string, note: string) => {
    if (draft === undefined) return
    persist(withWorkflowNodeNote(draft.layout, nodeId, note), note.trim().length === 0 ? "Comentário removido" : "Comentário salvo")
  }, [draft, persist])
  const saveExpressionFixture = useCallback((name: string, value: JsonValue) => {
    if (draft === undefined) return
    persist(withWorkflowExpressionFixture(draft.layout, name, value), `Dados de teste “${name}” salvos`)
  }, [draft, persist])
  const removeExpressionFixture = useCallback((name: string) => {
    if (draft === undefined) return
    persist(withoutWorkflowExpressionFixture(draft.layout, name), `Dados de teste “${name}” removidos`)
  }, [draft, persist])
  return { saveCanvasLayout, saveNodeNote, saveExpressionFixture, removeExpressionFixture }
}
