import { Badge } from "@/components/ui/badge"
import { focusWorkflowOutlineSibling } from "@/features/workflows/workflow-outline-keyboard"
import type { WorkflowSourceOutlineEntry } from "@/features/workflows/workflow-source-model"
import { cn } from "@/lib/utils"

export function WorkflowSourceOutline({
  entries,
  selectedEntryId,
  onSelectEntry,
}: {
  entries: readonly WorkflowSourceOutlineEntry[]
  selectedEntryId?: string
  onSelectEntry: (entryId: string) => void
}) {
  return (
    <ol className="space-y-1" aria-label="Outline navegável da fonte do workflow">
      {entries.map((entry, index) => (
        <li key={entry.selectionId}>
          <button
            type="button"
            data-outline-node={entry.selectionId}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
              selectedEntryId === entry.selectionId && "border-primary bg-primary/5",
              entry.problems.length > 0 && "border-destructive/50",
            )}
            aria-pressed={selectedEntryId === entry.selectionId}
            aria-label={`${entry.label}, ${entry.typeLabel}, ${entry.registrationLabel}${entry.problems.length === 0 ? "" : `, inválido: ${entry.problems.join(" ")}`}`}
            onClick={() => onSelectEntry(entry.selectionId)}
            onKeyDown={(event) => focusWorkflowOutlineSibling(event, index)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{entry.label}</span>
              <span className="block truncate font-mono text-[11px] text-foreground">{entry.registrationLabel}</span>
              {entry.problems.length > 0 && (
                <span className="mt-1 block text-[11px] text-destructive">{entry.problems[0]}</span>
              )}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <Badge variant="outline">{entry.typeLabel}</Badge>
              {entry.problems.length > 0 && <Badge variant="destructive">inválido</Badge>}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}
