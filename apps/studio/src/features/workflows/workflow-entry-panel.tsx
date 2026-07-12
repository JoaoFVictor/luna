import { CableIcon, ExternalLinkIcon, RouteIcon } from "lucide-react"
import { Link } from "react-router-dom"

import type { InputAdapterCatalog, RouterDefinition } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  launchAdapterDescription,
  launchAdapterLabel,
  launchEffectLabel,
} from "@/features/launch/launch-presentation"
import { workflowEntrySources } from "@/features/workflows/workflow-entry-sources"

export function WorkflowEntryPanel({
  workflowId,
  adapters,
  routing,
}: {
  workflowId: string
  adapters?: InputAdapterCatalog
  routing?: RouterDefinition
}) {
  const entries = adapters === undefined || routing === undefined
    ? []
    : workflowEntrySources(adapters.adapters, routing, workflowId)
  const title = entries.length === 0
    ? "Entrada manual ou por destino explícito"
    : entries.length === 1
      ? launchAdapterLabel(entries[0]!.adapter.id, entries[0]!.adapter.source)
      : `${entries.length} entradas roteadas`

  return (
    <Sheet>
      <SheetTrigger render={<Button size="sm" variant="outline" title={`Como começa: ${title}`} />}>
          <CableIcon aria-hidden="true" />
          <span>Entrada</span>
          {entries.length > 0 && <Badge variant="secondary">{entries.length}</Badge>}
      </SheetTrigger>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Como este workflow começa</SheetTitle>
          <SheetDescription>
            As regras determinísticas escolhem o workflow depois que uma entrada é carregada. Esta projeção não grava o adapter no YAML.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {adapters === undefined || routing === undefined ? (
            <p className="text-sm text-muted-foreground">Carregando entradas e regras…</p>
          ) : entries.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4">
              <p className="font-medium">Nenhuma entrada aponta diretamente para este workflow.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Ele ainda pode ser executado manualmente ou por uma invocação que declara o destino.
              </p>
            </div>
          ) : entries.map(({ adapter, ruleIds }) => (
            <article key={adapter.id} className="rounded-xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{launchAdapterLabel(adapter.id, adapter.source)}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {launchAdapterDescription(adapter.id, adapter.source, adapter.description)}
                  </p>
                </div>
                <Badge variant="secondary"><RouteIcon aria-hidden="true" /> Roteada</Badge>
              </div>
              {adapter.preview.enabled && adapter.preview.effects.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {adapter.preview.effects.map((effect) => (
                    <Badge key={effect} variant="outline">{launchEffectLabel(effect)}</Badge>
                  ))}
                </div>
              )}
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer">Detalhes técnicos</summary>
                <p className="mt-2">Adapter: <code>{adapter.id}</code></p>
                <p>Regra{ruleIds.length === 1 ? "" : "s"}: {ruleIds.join(", ")}</p>
              </details>
            </article>
          ))}
          <div className="flex flex-wrap gap-2">
            <Link className={buttonVariants()} to={`/launch?workflow=${encodeURIComponent(workflowId)}`}>
              Testar com uma entrada <ExternalLinkIcon aria-hidden="true" />
            </Link>
            <Link className={buttonVariants({ variant: "outline" })} to="/configuration?tab=routing">
              Ver regras
            </Link>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
