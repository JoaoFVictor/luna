import { useEffect, useState } from "react"
import { MessageSquareTextIcon, SaveIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"

export function WorkflowNodeNoteEditor({
  nodeId,
  note,
  disabled,
  onSave,
}: {
  nodeId: string
  note: string
  disabled: boolean
  onSave: (note: string) => void
}) {
  const [value, setValue] = useState(note)
  useEffect(() => setValue(note), [nodeId, note])
  const dirty = value.trim() !== note.trim()
  return (
    <Field>
      <FieldLabel htmlFor="workflow-node-note"><MessageSquareTextIcon aria-hidden="true" /> Comentário</FieldLabel>
      <Textarea
        id="workflow-node-note"
        value={value}
        maxLength={2_000}
        disabled={disabled}
        placeholder="Explique a intenção deste passo para quem editar o workflow depois."
        onChange={(event) => setValue(event.target.value)}
      />
      <FieldDescription>Fica no layout do draft e não altera a execução.</FieldDescription>
      {dirty && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onSave(value)}><SaveIcon aria-hidden="true" /> Salvar comentário</Button>}
    </Field>
  )
}
