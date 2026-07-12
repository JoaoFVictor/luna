import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { routingEditorQuery, studioKeys } from "@/api/queries"
import type { RouterDefinition } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

function moveRule(
  definition: RouterDefinition,
  index: number,
  offset: -1 | 1,
): RouterDefinition {
  const rules = [...definition.rules]
  const target = index + offset
  if (target < 0 || target >= rules.length) return definition
  const current = rules[index]
  const replacement = rules[target]
  if (current === undefined || replacement === undefined) return definition
  rules[index] = replacement
  rules[target] = current
  return { ...definition, rules }
}

export function RoutingEditor({ workflowIds }: { workflowIds: readonly string[] }) {
  const queryClient = useQueryClient()
  const editor = useQuery(routingEditorQuery)
  const [definition, setDefinition] = useState<RouterDefinition>()
  const [revision, setRevision] = useState("")

  useEffect(() => {
    if (editor.data === undefined) return
    setDefinition(editor.data.definition)
    setRevision(editor.data.revision)
  }, [editor.data])

  const save = useMutation({
    mutationFn: async () => {
      if (definition === undefined) throw new Error("Routing ainda não foi carregado")
      return await studioApi.saveRouting({
        expected_revision: revision,
        definition,
      })
    },
    onSuccess: async (result) => {
      const next = result.status === "saved" ? result.editor : result.current
      setDefinition(next.definition)
      setRevision(next.revision)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: studioKeys.routing }),
        queryClient.invalidateQueries({ queryKey: studioKeys.routingEditor }),
      ])
      if (result.status === "conflict") {
        toast.error("As regras mudaram em outro processo. A versão atual foi recarregada.")
      } else {
        toast.success("Regras de entrada salvas")
      }
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Não foi possível salvar o routing",
    ),
  })

  if (editor.isPending || definition === undefined) {
    return <PageLoading label="Carregando editor de routing" />
  }
  if (editor.isError) {
    return <PageError error={editor.error} retry={() => void editor.refetch()} />
  }

  const updateRule = (index: number, patch: Partial<RouterDefinition["rules"][number]>) => {
    setDefinition((current) => current === undefined ? current : {
      ...current,
      rules: current.rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Editar ordem e destino</CardTitle>
        <CardDescription>
          A primeira condição verdadeira vence. O servidor valida JSONata e impede sobrescrita concorrente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>Mudança ativa imediatamente após salvar</AlertTitle>
          <AlertDescription>
            Teste uma entrada depois de salvar; runs já planejadas continuam presas ao snapshot aceito.
          </AlertDescription>
        </Alert>
        {definition.rules.map((rule, index) => (
          <div key={`${rule.id}:${index}`} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{index + 1}. {rule.id}</p>
              <div className="flex gap-1">
                <Button type="button" size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => setDefinition(moveRule(definition, index, -1))}>
                  <ArrowUpIcon aria-hidden="true" /><span className="sr-only">Mover {rule.id} para cima</span>
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" disabled={index === definition.rules.length - 1} onClick={() => setDefinition(moveRule(definition, index, 1))}>
                  <ArrowDownIcon aria-hidden="true" /><span className="sr-only">Mover {rule.id} para baixo</span>
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" className="text-destructive" disabled={definition.rules.length === 1} onClick={() => setDefinition({ ...definition, rules: definition.rules.filter((_, ruleIndex) => ruleIndex !== index) })}>
                  <Trash2Icon aria-hidden="true" /><span className="sr-only">Excluir {rule.id}</span>
                </Button>
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`routing-id-${index}`}>Nome da regra</FieldLabel>
                <Input id={`routing-id-${index}`} value={rule.id} onChange={(event) => updateRule(index, { id: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`routing-target-${index}`}>Enviar para</FieldLabel>
                <NativeSelect id={`routing-target-${index}`} value={rule.target} onChange={(event) => updateRule(index, { target: event.target.value as typeof rule.target })}>
                  <NativeSelectOption value="$.invocation.target">Workflow indicado pela entrada</NativeSelectOption>
                  {workflowIds.map((workflowId) => (
                    <NativeSelectOption key={workflowId} value={`workflow:${workflowId}`}>{workflowId}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`routing-expression-${index}`}>Condição</FieldLabel>
              <Input id={`routing-expression-${index}`} className="font-mono text-xs" value={rule.when.expression} onChange={(event) => updateRule(index, { when: { expression: event.target.value } })} />
              <FieldDescription>Expressão JSONata avaliada contra a invocation.</FieldDescription>
            </Field>
          </div>
        ))}
        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" variant="outline" onClick={() => setDefinition({
            ...definition,
            rules: [...definition.rules, {
              id: `regra-${definition.rules.length + 1}`,
              when: { expression: "false" },
              target: workflowIds[0] === undefined ? "$.invocation.target" : `workflow:${workflowIds[0]}`,
            }],
          })}>
            <PlusIcon aria-hidden="true" /> Adicionar regra
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            <SaveIcon aria-hidden="true" /> {save.isPending ? "Validando…" : "Validar e salvar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
