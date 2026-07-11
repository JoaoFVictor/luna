import { useEffect, useMemo, useState } from "react"
import { Trash2Icon } from "lucide-react"

import type { YamlSourceOperation } from "@/api/types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  planWorkflowNodeDelete,
  planWorkflowNodeRename,
  type WorkflowNodeMutationPlan,
  type WorkflowNodeReferenceKind,
} from "@/features/workflows/workflow-node-refactor"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

const NODE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

const IMPACT_LABELS: Readonly<Record<WorkflowNodeReferenceKind, string>> = {
  dependency: "after",
  expression: "expression",
  artifact_source: "artifact source",
}

function NodeMutationImpact({
  plan,
  label,
}: {
  plan: WorkflowNodeMutationPlan
  label: string
}) {
  return (
    <div className="space-y-3">
      {plan.impacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma referência ao node foi encontrada.
        </p>
      ) : (
        <ul className="max-h-56 space-y-2 overflow-auto" aria-label={label}>
          {plan.impacts.map((impact) => (
            <li
              key={`${impact.path.join(".")}:${impact.kind}`}
              className="rounded-md border p-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{IMPACT_LABELS[impact.kind]}</Badge>
                {impact.blocking && <Badge variant="destructive">bloqueante</Badge>}
                <span className="font-medium">{impact.ownerNodeId}</span>
              </div>
              <code className="mt-1 block break-all text-muted-foreground">
                {impact.path.join(".")} · {impact.occurrences} ocorrência(s)
              </code>
            </li>
          ))}
        </ul>
      )}
      {plan.blockers.length > 0 && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3"
          role="alert"
        >
          <p className="font-medium">Refactor bloqueado</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
            {plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

type NodeRefactorControlProps = {
  nodes: readonly WorkflowSourceNode[]
  selected: WorkflowSourceNode
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}

export function WorkflowNodeIdentityEditor({
  nodes,
  selected,
  canMutate,
  pending,
  onOperations,
}: NodeRefactorControlProps) {
  const [id, setId] = useState(selected.id)
  const [renameOpen, setRenameOpen] = useState(false)

  useEffect(() => {
    setId(selected.id)
    setRenameOpen(false)
  }, [selected.id])

  const duplicateId = id !== selected.id && nodes.some((node) => node.id === id)
  const idInvalid = !NODE_ID.test(id) || id.length > 128 || duplicateId
  const renamePlan = useMemo(
    () => planWorkflowNodeRename(nodes, selected, id),
    [id, nodes, selected],
  )

  return (
    <>
      <Field data-invalid={idInvalid && id !== selected.id}>
        <FieldLabel htmlFor="workflow-node-id">ID</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="workflow-node-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
            disabled={!canMutate || pending}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canMutate || pending || id === selected.id || idInvalid}
            onClick={() => setRenameOpen(true)}
          >
            Revisar refactor
          </Button>
        </div>
        <FieldDescription>
          O Studio analisa <code>after</code>, expressions e artifact sources antes de montar um único batch YAML.
        </FieldDescription>
        {duplicateId && <FieldError>Este ID já existe.</FieldError>}
      </Field>
      <AlertDialog open={renameOpen} onOpenChange={setRenameOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renomear {selected.id} para {id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Revise todas as referências detectadas. Strings literais JSONata não são reinterpretadas como referências.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <NodeMutationImpact plan={renamePlan} label="Impactos do rename" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={renamePlan.blockers.length > 0 || renamePlan.operations.length === 0}
              onClick={() => {
                setRenameOpen(false)
                onOperations(renamePlan.operations)
              }}
            >
              Aplicar refactor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function WorkflowNodeDeleteControl({
  nodes,
  selected,
  canMutate,
  pending,
  onOperations,
}: NodeRefactorControlProps) {
  const [open, setOpen] = useState(false)
  const plan = useMemo(
    () => planWorkflowNodeDelete(nodes, selected),
    [nodes, selected],
  )

  useEffect(() => setOpen(false), [selected.id])

  return (
    <>
      <Button
        className="border-destructive/40 text-foreground"
        variant="destructive"
        size="sm"
        disabled={!canMutate || pending}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon aria-hidden="true" /> Remover node
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {selected.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              A remoção só é liberada quando outros nodes não dependem nem leem este node. Resolva cada referência bloqueante primeiro.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <NodeMutationImpact plan={plan} label="Impactos da remoção" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="border-destructive/40 text-foreground"
              variant="destructive"
              disabled={plan.blockers.length > 0 || plan.operations.length === 0}
              onClick={() => {
                setOpen(false)
                onOperations(plan.operations)
              }}
            >
              {plan.blockers.length > 0 ? "Resolva as referências" : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
