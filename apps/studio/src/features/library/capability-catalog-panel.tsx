import { useMemo, useState } from "react"
import { BookOpenIcon, BoxesIcon, ExternalLinkIcon } from "lucide-react"

import type {
  CapabilityCatalog,
  CapabilityRegistration,
  CapabilitySummary,
} from "@/api/types"
import { PageEmpty } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { presentationTitle } from "@/lib/presentation"
import { capabilityCategory } from "./library-presentation"

const reExportLabels: Record<keyof CapabilitySummary["re_exports"], string> = {
  built_ins: "Built-ins",
  patterns: "Patterns",
  tools: "Tools",
  gates: "Gates",
  policies: "Policies",
  ports: "Ports",
  artifact_publishers: "Publishers",
}

function searchableCapability(capability: CapabilitySummary): string {
  return [
    capability.id,
    capability.version,
    capability.kind,
    capability.presentation.title,
    capability.presentation.summary ?? "",
    capability.presentation.category ?? "",
    ...(capability.presentation.tags ?? []),
    ...capability.depends_on,
    ...Object.keys(capability.presets),
    ...Object.values(capability.presets).flat(),
    ...Object.values(capability.re_exports).flat(),
    ...capability.docs.flatMap((doc) => [doc.title, doc.path ?? "", doc.url ?? ""]),
  ].join("\n").toLocaleLowerCase()
}

function ValueBadges({ values, empty = "Nenhum" }: {
  values: readonly string[]
  empty?: string
}) {
  return values.length === 0
    ? <span className="text-xs text-muted-foreground">{empty}</span>
    : (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => <Badge key={value} variant="outline" className="break-all">{value}</Badge>)}
        </div>
      )
}

function CapabilityDetails({
  capability,
  registrations,
  consumers,
}: {
  capability: CapabilitySummary
  registrations: readonly CapabilityRegistration[]
  consumers?: CapabilityCatalog["consumers"]
}) {
  const ownedRegistrations = registrations.filter(
    (registration) => registration.owner.capability_id === capability.id,
  )
  const reExports = Object.entries(capability.re_exports).filter(([, values]) => values.length > 0) as [
    keyof CapabilitySummary["re_exports"],
    string[],
  ][]
  const presets = Object.entries(capability.presets)
  const usage = consumers?.capabilities[capability.id]

  return (
    <>
      <SheetHeader>
        <SheetTitle>{presentationTitle(capability.id, capability.presentation.title)}</SheetTitle>
        <SheetDescription>{capability.presentation.summary ?? capability.id}</SheetDescription>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{capabilityCategory(capability.id, capability.presentation.category)}</Badge>
            <Badge variant="outline">{ownedRegistrations.length} blocos</Badge>
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Usado atualmente em</h2>
            {consumers === undefined ? (
              <p className="text-xs text-muted-foreground">Índice de consumidores indisponível nesta resposta.</p>
            ) : (
              <div className="space-y-3">
                {consumers.status === "partial" && (
                  <p className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-muted-foreground">
                    Índice parcial: {consumers.incomplete_sources.join(" e ")}. Entradas inválidas podem estar ausentes.
                  </p>
                )}
                <div><p className="mb-1 text-xs text-muted-foreground">Workflows</p><ValueBadges values={usage?.workflows ?? []} /></div>
                <div><p className="mb-1 text-xs text-muted-foreground">Agents</p><ValueBadges values={usage?.agents ?? []} /></div>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Blocos disponíveis</h2>
            {ownedRegistrations.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum bloco disponível.</p>
            ) : (
              <ul className="space-y-1">
                {ownedRegistrations.map((registration) => (
                  <li key={`${registration.registration_kind}:${registration.id}`} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                    <span><span className="block font-medium">{presentationTitle(registration.id, registration.presentation.title)}</span><code className="block break-all text-muted-foreground">{registration.id}</code></span>
                    <Badge variant="outline">{registration.registration_kind}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Detalhes técnicos</summary>
            <div className="mt-4 space-y-5">
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Identificação</h2>
            <ValueBadges values={[`${capability.id}@${capability.version}`, capability.kind]} />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Dependências</h2>
            <ValueBadges values={capability.depends_on} />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Presets</h2>
            {presets.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum preset declarado.</p>
            ) : presets.map(([name, values]) => (
              <div key={name} className="rounded-md border p-3">
                <p className="mb-2 font-mono text-xs font-medium">{name}</p>
                <ValueBadges values={values} />
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Re-exports</h2>
            {reExports.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum re-export declarado.</p>
            ) : reExports.map(([kind, values]) => (
              <div key={kind}>
                <p className="mb-1 text-xs text-muted-foreground">{reExportLabels[kind]}</p>
                <ValueBadges values={values} />
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-medium"><BookOpenIcon className="size-4" aria-hidden="true" /> Documentação</h2>
            {capability.docs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma documentação declarada no manifest.</p>
            ) : (
              <ul className="space-y-2">
                {capability.docs.map((doc, index) => (
                  <li key={`${index}:${doc.title}`} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">{doc.title}</p>
                    {doc.path !== undefined && <code className="mt-1 block break-all text-xs text-muted-foreground">{doc.path}</code>}
                    {doc.url !== undefined && (
                      <a className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-4" href={doc.url} target="_blank" rel="noreferrer">
                        Abrir documentação <ExternalLinkIcon className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(capability.presentation.tags?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Tags</h2>
              <ValueBadges values={capability.presentation.tags ?? []} />
            </section>
          )}

          {(capability.presentation.examples?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Exemplos declarados</h2>
              {capability.presentation.examples?.map((example, index) => (
                <div key={`${index}:${example.title}`} className="rounded-md border p-3">
                  <p className="text-sm font-medium">{example.title}</p>
                  {example.description !== undefined && <p className="mt-1 text-xs text-muted-foreground">{example.description}</p>}
                  <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(example.value, null, 2)}</pre>
                </div>
              ))}
            </section>
          )}
            </div>
          </details>
        </div>
      </ScrollArea>
    </>
  )
}

export function CapabilityCatalogPanel({
  capabilities,
  registrations,
  search,
  consumers,
}: {
  capabilities: readonly CapabilitySummary[]
  registrations: readonly CapabilityRegistration[]
  search: string
  consumers?: CapabilityCatalog["consumers"]
}) {
  const [selected, setSelected] = useState<CapabilitySummary>()
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return term.length === 0
      ? capabilities
      : capabilities.filter((capability) => searchableCapability(capability).includes(term))
  }, [capabilities, search])

  if (filtered.length === 0) {
    return <PageEmpty title="Nenhuma capability encontrada" description="Ajuste a busca ou confira os manifests carregados pelo servidor." />
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader><TableRow><TableHead>Grupo de blocos</TableHead><TableHead>Categoria</TableHead><TableHead>Blocos</TableHead><TableHead>Em uso</TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.map((capability) => (
              <TableRow key={capability.id}>
                <TableCell>
                  <button type="button" onClick={() => setSelected(capability)} className="flex max-w-md items-start gap-2 text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                    <BoxesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span><span className="block">{presentationTitle(capability.id, capability.presentation.title)}</span><span className="block font-mono text-xs font-normal text-muted-foreground">{capability.id}</span></span>
                  </button>
                </TableCell>
                <TableCell><Badge variant="outline">{capabilityCategory(capability.id, capability.presentation.category)}</Badge></TableCell>
                <TableCell>{registrations.filter((registration) => registration.owner.capability_id === capability.id).length}</TableCell>
                <TableCell>{(consumers?.capabilities[capability.id]?.workflows.length ?? 0) + (consumers?.capabilities[capability.id]?.agents.length ?? 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Sheet open={selected !== undefined} onOpenChange={(open) => { if (!open) setSelected(undefined) }}>
        <SheetContent className="w-full sm:max-w-xl">
          {selected !== undefined && <CapabilityDetails capability={selected} registrations={registrations} consumers={consumers} />}
        </SheetContent>
      </Sheet>
    </>
  )
}
