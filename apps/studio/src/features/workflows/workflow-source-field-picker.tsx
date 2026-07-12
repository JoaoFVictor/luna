import { useMemo, useState } from "react"
import { DatabaseIcon, GripVerticalIcon, SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  WORKFLOW_FIELD_DRAG_MIME,
  workflowFieldDragPayload,
} from "@/features/workflows/workflow-field-drag"

export interface WorkflowSourceFieldSuggestion {
  value: string
  label: string
  valueType: string
  compatible: boolean
}

function matchesSuggestion(suggestion: WorkflowSourceFieldSuggestion, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return true
  return `${suggestion.label} ${suggestion.value} ${suggestion.valueType}`
    .toLocaleLowerCase()
    .includes(normalized)
}

export function WorkflowSourceFieldPicker({
  suggestions,
  selectedValue,
  disabled,
  onSelect,
}: {
  suggestions: readonly WorkflowSourceFieldSuggestion[]
  selectedValue: string
  disabled: boolean
  onSelect: (value: string) => void
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(
    () => suggestions.filter((suggestion) => matchesSuggestion(suggestion, query)),
    [query, suggestions],
  )

  return (
    <section className="overflow-hidden rounded-lg border bg-background" aria-label="Dados disponíveis">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <DatabaseIcon className="size-4 text-primary" aria-hidden="true" />
        <p className="text-xs font-medium">Dados disponíveis</p>
        <Badge className="ml-auto" variant="outline">{filtered.length}</Badge>
      </div>
      <div className="relative border-b p-2">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar dados anteriores"
          aria-label="Buscar dados anteriores"
          className="h-8 pl-8 text-xs"
        />
      </div>
      <ScrollArea className="h-52">
        <div className="space-y-1 p-2">
          {filtered.map((suggestion) => (
            <Button
              key={suggestion.value}
              type="button"
              size="sm"
              variant={selectedValue === suggestion.value ? "secondary" : "ghost"}
              className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
              draggable={suggestion.compatible && !disabled}
              disabled={disabled || !suggestion.compatible}
              title={suggestion.compatible ? "Clique ou arraste para o campo de destino" : "Tipo incompatível com este campo"}
              aria-label={`Usar ${suggestion.label}`}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  WORKFLOW_FIELD_DRAG_MIME,
                  workflowFieldDragPayload(suggestion.value),
                )
                event.dataTransfer.setData("text/plain", suggestion.value)
                event.dataTransfer.effectAllowed = "copy"
              }}
              onClick={() => onSelect(suggestion.value)}
            >
              <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{suggestion.label}</span>
                <code className="block truncate text-[10px] font-normal text-muted-foreground">{suggestion.value}</code>
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">{suggestion.valueType}</Badge>
            </Button>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              Nenhum dado encontrado.
            </p>
          )}
        </div>
      </ScrollArea>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Clique para mapear agora ou arraste até qualquer parâmetro compatível.
      </p>
    </section>
  )
}
