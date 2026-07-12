import { Handle, Position } from "@xyflow/react"

import {
  WORKFLOW_DATA_INPUT_HANDLE,
  WORKFLOW_DATA_OUTPUT_HANDLE,
} from "@/features/workflows/workflow-data-edge"

export function WorkflowNodeDataPorts({
  inputCount = 0,
  outputCount = 0,
  nodeTitle,
}: {
  inputCount?: number
  outputCount?: number
  nodeTitle: string
}) {
  if (inputCount === 0 && outputCount === 0) return null
  return (
    <div className="relative mt-2 flex min-h-4 items-center justify-between gap-4 border-t border-sky-500/20 pt-1 text-[9px] font-medium text-sky-700 dark:text-sky-300">
      {inputCount > 0 ? <>
        <Handle
          id={WORKFLOW_DATA_INPUT_HANDLE}
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="!size-3 !border-2 !border-background !bg-sky-500"
          aria-label={`${inputCount} ${inputCount === 1 ? "dado recebido" : "dados recebidos"} por ${nodeTitle}`}
        />
        <span>entrada · {inputCount}</span>
      </> : <span />}
      {outputCount > 0 && <>
        <span>saída · {outputCount}</span>
        <Handle
          id={WORKFLOW_DATA_OUTPUT_HANDLE}
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="!size-3 !border-2 !border-background !bg-sky-500"
          aria-label={`${outputCount} ${outputCount === 1 ? "dado utilizado" : "dados utilizados"} de ${nodeTitle}`}
        />
      </>}
    </div>
  )
}
