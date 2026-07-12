import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BoxesIcon, SearchIcon } from "lucide-react"

import { libraryQuery } from "@/api/queries"
import type { CapabilityRegistration, RegistrationKind } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { CapabilityCatalogPanel } from "@/features/library/capability-catalog-panel"
import { presentationTitle } from "@/lib/presentation"

const kindLabels: Record<RegistrationKind, string> = {
  built_in: "Built-in",
  pattern: "Pattern",
  tool: "Tool",
  gate: "Gate",
  policy: "Policy",
  port: "Port",
  artifact_publisher: "Publisher",
  schema: "Schema",
}

function safeRegistrationProjection(registration: CapabilityRegistration) {
  const { presentation: _presentation, owner: _owner, ...technical } = registration
  return technical
}

export function LibraryPage() {
  const library = useQuery(libraryQuery)
  const [search, setSearch] = useState("")
  const [kind, setKind] = useState<RegistrationKind | "all">("all")
  const [selected, setSelected] = useState<CapabilityRegistration | undefined>()

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (library.data?.registrations ?? []).filter(
      (registration) =>
        (kind === "all" || registration.registration_kind === kind) &&
        (term.length === 0 ||
          registration.id.toLocaleLowerCase().includes(term) ||
          registration.presentation.title.toLocaleLowerCase().includes(term) ||
          registration.owner.capability_id.toLocaleLowerCase().includes(term)),
    )
  }, [kind, library.data, search])

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Peças reutilizáveis"
        title="Blocos"
        description="Veja o que você pode usar para montar workflows e agents. Abra um bloco para entender sua função e onde ele já é usado."
      />
      {library.data !== undefined && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{library.data.capabilities.length} grupos</span><span aria-hidden="true">·</span>
          <span>{library.data.registrations.length} blocos disponíveis</span>
        </div>
      )}
      <div className="relative w-full max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Buscar por nome, função ou categoria" aria-label="Buscar blocos" />
      </div>

      {library.isPending ? (
        <PageLoading label="Carregando blocos" />
      ) : library.isError ? (
        <PageError error={library.error} retry={() => void library.refetch()} />
      ) : (
        <Tabs defaultValue="capabilities" className="gap-4">
          <TabsList>
            <TabsTrigger value="capabilities">Catálogo</TabsTrigger>
            <TabsTrigger value="registrations">Registry técnico</TabsTrigger>
          </TabsList>
          <TabsContent value="capabilities">
            <CapabilityCatalogPanel capabilities={library.data.capabilities} registrations={library.data.registrations} consumers={library.data.consumers} search={search} />
          </TabsContent>
          <TabsContent value="registrations" className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <NativeSelect value={kind} onChange={(event) => setKind(event.target.value as RegistrationKind | "all")} aria-label="Filtrar tipo técnico">
                <NativeSelectOption value="all">Todos os tipos</NativeSelectOption>
                {Object.entries(kindLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
              </NativeSelect>
            </div>

            {filtered.length === 0 ? (
              <PageEmpty title="Nenhum registro encontrado" description="Ajuste os filtros ou confira os manifests carregados pelo servidor." />
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader><TableRow><TableHead>Registration</TableHead><TableHead>Kind</TableHead><TableHead>Capability</TableHead><TableHead>Resumo</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {filtered.map((registration) => (
                      <TableRow key={`${registration.registration_kind}:${registration.id}`}>
                        <TableCell>
                          <button type="button" onClick={() => setSelected(registration)} className="flex items-center gap-2 font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                            <BoxesIcon className="size-4 text-muted-foreground" aria-hidden="true" /> {registration.id}
                          </button>
                        </TableCell>
                        <TableCell><Badge variant="outline">{kindLabels[registration.registration_kind]}</Badge></TableCell>
                        <TableCell>{registration.owner.capability_id} <span className="text-xs text-muted-foreground">v{registration.owner.capability_version}</span></TableCell>
                        <TableCell className="max-w-sm truncate text-muted-foreground">{registration.presentation.summary ?? "Não declarado"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <Sheet open={selected !== undefined} onOpenChange={(open) => { if (!open) setSelected(undefined) }}>
        <SheetContent className="w-full sm:max-w-xl">
          {selected !== undefined && (
            <>
              <SheetHeader>
                <SheetTitle>{presentationTitle(selected.id, selected.presentation.title)}</SheetTitle>
                <SheetDescription>{selected.presentation.summary ?? selected.id}</SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
                <div className="space-y-5">
                  <div className="flex flex-wrap gap-2"><Badge>{kindLabels[selected.registration_kind]}</Badge><Badge variant="outline">{selected.id}</Badge><Badge variant="outline">{selected.owner.capability_id}@{selected.owner.capability_version}</Badge></div>
                  {selected.presentation.tags !== undefined && <div className="flex flex-wrap gap-1">{selected.presentation.tags.map((tag) => <Badge variant="secondary" key={tag}>{tag}</Badge>)}</div>}
                  <section>
                    <h2 className="mb-2 text-sm font-medium">Contrato técnico declarado</h2>
                    <pre className="max-h-[55vh] overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(safeRegistrationProjection(selected), null, 2)}</pre>
                  </section>
                  {selected.presentation.examples !== undefined && selected.presentation.examples.length > 0 && (
                    <section className="space-y-2">
                      <h2 className="text-sm font-medium">Exemplos declarados</h2>
                      {selected.presentation.examples.map((example, index) => (
                        <div key={`${index}:${example.title}`} className="rounded-lg border p-3">
                          <p className="text-sm font-medium">{example.title}</p>
                          {example.description !== undefined && <p className="mt-1 text-xs text-muted-foreground">{example.description}</p>}
                          <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(example.value, null, 2)}</pre>
                        </div>
                      ))}
                    </section>
                  )}
                  {selected.presentation.field_hints !== undefined && (
                    <section>
                      <h2 className="mb-2 text-sm font-medium">Field hints</h2>
                      <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(selected.presentation.field_hints, null, 2)}</pre>
                    </section>
                  )}
                  <section className="space-y-2">
                    <h2 className="text-sm font-medium">Consumidores ativos</h2>
                    {library.data?.consumers === undefined ? (
                      <p className="text-xs text-muted-foreground">Índice de consumidores indisponível nesta resposta.</p>
                    ) : (
                      <div className="space-y-3">
                        {library.data.consumers.status === "partial" && (
                          <p className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-muted-foreground">Índice parcial: {library.data.consumers.incomplete_sources.join(" e ")}. Entradas inválidas podem estar ausentes.</p>
                        )}
                        <div><p className="mb-1 text-xs text-muted-foreground">Workflows</p><div className="flex flex-wrap gap-1">{(library.data.consumers.registrations[selected.id]?.workflows ?? []).map((id) => <Badge key={id} variant="outline">{id}</Badge>)}{(library.data.consumers.registrations[selected.id]?.workflows.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">Nenhum</span>}</div></div>
                        <div><p className="mb-1 text-xs text-muted-foreground">Agents</p><div className="flex flex-wrap gap-1">{(library.data.consumers.registrations[selected.id]?.agents ?? []).map((id) => <Badge key={id} variant="outline">{id}</Badge>)}{(library.data.consumers.registrations[selected.id]?.agents.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">Nenhum</span>}</div></div>
                      </div>
                    )}
                  </section>
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
