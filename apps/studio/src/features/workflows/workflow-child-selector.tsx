import type { WorkflowSummary } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { presentationTitle } from "@/lib/presentation"

export function WorkflowChildSelector({
  workflowId,
  workflows,
  disabled,
  issue,
  onSelect,
}: {
  workflowId: string
  workflows: readonly WorkflowSummary[]
  disabled: boolean
  issue?: string
  onSelect: (workflowId: string) => void
}) {
  const selected = workflows.find((workflow) => workflow.id === workflowId)

  return (
    <Field>
      <FieldLabel htmlFor="workflow-node-registration">Workflow filho</FieldLabel>
      <NativeSelect
        id="workflow-node-registration"
        className="w-full"
        value={workflowId}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
      >
        {workflows.map((workflow) => (
          <NativeSelectOption key={workflow.id} value={workflow.id}>
            {presentationTitle(workflow.id, workflow.id)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {selected !== undefined && (
        <FieldDescription>
          Revision {selected.revision.slice(0, 15)} · {Object.values(selected.node_counts).reduce((total, count) => total + count, 0)} passos
        </FieldDescription>
      )}
      {issue !== undefined && (
        <FieldDescription className="text-destructive">{issue}</FieldDescription>
      )}
      {selected?.requires_repository && (
        <Badge variant="outline">Exige repositório local</Badge>
      )}
    </Field>
  )
}
