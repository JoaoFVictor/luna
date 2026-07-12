import { useEffect, useState } from "react"
import { LayersIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import type { WorkflowCanvasGroup } from "./workflow-layout"

type WorkflowGroupNodeOption = { readonly id: string; readonly title: string }

function nextGroupId(groups: readonly WorkflowCanvasGroup[]): string {
  const ids = new Set(groups.map((group) => group.id))
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `group-${suffix}`
    if (!ids.has(candidate)) return candidate
  }
}

export function WorkflowGroupManager({
  groups,
  nodes,
  disabled,
  onChange,
}: {
  groups: readonly WorkflowCanvasGroup[]
  nodes: readonly WorkflowGroupNodeOption[]
  disabled: boolean
  onChange: (groups: readonly WorkflowCanvasGroup[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<readonly WorkflowCanvasGroup[]>(groups)

  useEffect(() => {
    if (!open) setEditing(groups)
  }, [groups, open])

  const updateGroup = (id: string, update: (group: WorkflowCanvasGroup) => WorkflowCanvasGroup) => {
    setEditing((current) => current.map((group) => group.id === id ? update(group) : group))
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) setEditing(groups)
  }

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger render={<Button size="sm" variant="outline" />}>
        <LayersIcon aria-hidden="true" /> Grupos
      </SheetTrigger>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Grupos do canvas</SheetTitle>
          <SheetDescription>Organizam visualmente etapas relacionadas. Não mudam dependências nem a ordem de execução.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {editing.map((group) => (
            <section key={group.id} className="space-y-3 rounded-xl border p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`group-title-${group.id}`}>Nome do grupo</Label>
                  <Input
                    id={`group-title-${group.id}`}
                    value={group.title}
                    disabled={disabled}
                    onChange={(event) => updateGroup(group.id, (current) => ({ ...current, title: event.target.value }))}
                  />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setEditing((current) => current.filter((candidate) => candidate.id !== group.id))}
                >
                  <Trash2Icon aria-hidden="true" /><span className="sr-only">Excluir grupo {group.title}</span>
                </Button>
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium">Etapas dentro do grupo</legend>
                {nodes.map((node) => {
                  const checked = group.nodeIds.includes(node.id)
                  return (
                    <label key={node.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(value) => updateGroup(group.id, (current) => ({
                          ...current,
                          nodeIds: value === true
                            ? [...new Set([...current.nodeIds, node.id])]
                            : current.nodeIds.filter((nodeId) => nodeId !== node.id),
                        }))}
                      />
                      <span className="min-w-0 truncate">{node.title}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{node.id}</span>
                    </label>
                  )
                })}
                {nodes.length === 0 && <p className="text-xs text-muted-foreground">Adicione etapas antes de criar grupos.</p>}
              </fieldset>
            </section>
          ))}
          {editing.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Nenhum grupo visual.</p>}
          <Button
            variant="outline"
            disabled={disabled || nodes.length === 0}
            onClick={() => setEditing((current) => [
              ...current,
              { id: nextGroupId(current), title: "Novo grupo", nodeIds: [] },
            ])}
          >
            <PlusIcon aria-hidden="true" /> Criar grupo
          </Button>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => changeOpen(false)}>Cancelar</Button>
            <Button
              disabled={disabled}
              onClick={() => {
                onChange(editing)
                setOpen(false)
              }}
            >
              Salvar grupos
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
