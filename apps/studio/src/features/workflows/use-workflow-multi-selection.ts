import { useState } from "react"

import type { YamlSourceOperation } from "@/api/types"
import {
  removeWorkflowNodeOperations,
  removeWorkflowNodesOperations,
  STUDIO_YAML_SOURCE_OPERATION_LIMIT,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

export function useWorkflowMultiSelection({
  nodes,
  selectedNodeId,
  canMutate,
  pending,
  onOperations,
  onSelectNode,
}: {
  nodes: readonly WorkflowSourceNode[]
  selectedNodeId?: string
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  onSelectNode: (nodeId: string | undefined) => void
}) {
  const [selectedNodeIds, setSelectedNodeIds] = useState<readonly string[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const knownIds = new Set(nodes.map((node) => node.id))
  const validNodeIds = selectedNodeIds.filter((nodeId) => knownIds.has(nodeId))
  const multipleOperations = removeWorkflowNodesOperations(nodes, validNodeIds)
  const deleteUnavailableReason = multipleOperations.length > STUDIO_YAML_SOURCE_OPERATION_LIMIT
    ? `Esta seleção exige ${multipleOperations.length} operações, acima do limite de ${STUDIO_YAML_SOURCE_OPERATION_LIMIT}. Selecione menos passos.`
    : undefined
  const singleOperations = selectedNodeId === undefined
    ? []
    : removeWorkflowNodeOperations(nodes, selectedNodeId)
  const singleDeleteUnavailableReason = singleOperations.length > STUDIO_YAML_SOURCE_OPERATION_LIMIT
    ? `Este passo possui dependências demais para exclusão única (${singleOperations.length} operações; limite de ${STUDIO_YAML_SOURCE_OPERATION_LIMIT}). Remova algumas conexões primeiro.`
    : undefined

  const clear = () => {
    setSelectedNodeIds([])
    setDeleteOpen(false)
    onSelectNode(undefined)
  }
  const select = (nodeId: string, additive = false) => {
    if (!additive) {
      setSelectedNodeIds([])
      onSelectNode(nodeId)
      return
    }
    const next = new Set(validNodeIds)
    if (next.size === 0 && selectedNodeId !== undefined && knownIds.has(selectedNodeId)) {
      next.add(selectedNodeId)
    }
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    const ids = [...next]
    setSelectedNodeIds(ids.length > 1 ? ids : [])
    onSelectNode(ids.length === 0 ? undefined : ids.includes(nodeId) ? nodeId : ids.at(-1))
  }
  const remove = (operations: readonly YamlSourceOperation[]) => {
    onOperations(operations)
    clear()
  }
  const deleteMultiple = () => {
    if (multipleOperations.length === 0 || deleteUnavailableReason !== undefined) return
    remove(multipleOperations)
  }
  const deleteSingle = () => {
    if (selectedNodeId === undefined || singleOperations.length === 0 || singleDeleteUnavailableReason !== undefined) return
    remove(singleOperations)
  }

  return {
    selectedNodeIds: validNodeIds,
    hasMultiple: validNodeIds.length > 1,
    deleteOpen,
    setDeleteOpen,
    canDeleteMultiple: canMutate && !pending && deleteUnavailableReason === undefined,
    deleteUnavailableReason,
    singleDeleteUnavailableReason,
    select,
    clear,
    deleteMultiple,
    deleteSingle,
  }
}
