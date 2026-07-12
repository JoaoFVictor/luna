import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2Icon, CircleAlertIcon, PlugZapIcon } from "lucide-react"

import { studioApi } from "@/api/client"
import { studioKeys } from "@/api/queries"
import type { InputAdapterSummary, ProviderConfiguration } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { launchAdapterLabel } from "@/features/launch/launch-presentation"

type Provider = ProviderConfiguration["providers"][number]

const effectLabels = {
  credential_read: "Lê credencial local",
  network_read: "Consulta somente leitura",
  process_execution: "Executa cliente local",
} as const

export function ProviderConnectionCard({
  provider,
  adapters,
}: {
  readonly provider: Provider
  readonly adapters: readonly InputAdapterSummary[]
}) {
  const queryClient = useQueryClient()
  const probe = useMutation({
    mutationFn: () => studioApi.testProviderConnection(provider.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: studioKeys.configurationProviders })
    },
  })
  const healthy = provider.credential_status === "healthy"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZapIcon className="size-4" />
          {provider.id}
        </CardTitle>
        <CardDescription>
          {adapters.length === 0
            ? "Provider instalado sem adapter de entrada."
            : adapters.map((adapter) => launchAdapterLabel(adapter.id, adapter.source)).join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {healthy ? "Conexão saudável" : "Conexão ainda não testada"}
          </Badge>
          {provider.probe === undefined && <Badge variant="outline">Teste não disponível</Badge>}
        </div>

        {provider.probe !== undefined && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {provider.probe.effects.map((effect) => (
                <Badge key={effect} variant="outline">{effectLabels[effect]}</Badge>
              ))}
              <Badge variant="outline">Limite {Math.round(provider.probe.timeout_ms / 1_000)}s</Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={probe.isPending}
              onClick={() => probe.mutate()}
            >
              {probe.isPending ? "Testando…" : healthy ? "Testar novamente" : "Testar conexão"}
            </Button>
          </>
        )}

        {probe.data !== undefined && probe.data.status !== "unsupported" && (
          <Alert variant={probe.data.status === "healthy" ? "default" : "destructive"}>
            {probe.data.status === "healthy"
              ? <CheckCircle2Icon />
              : <CircleAlertIcon />}
            <AlertTitle>
              {probe.data.status === "healthy" ? "Conexão confirmada" : "Falha na conexão"}
            </AlertTitle>
            <AlertDescription>{probe.data.summary}</AlertDescription>
          </Alert>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Detalhes técnicos</summary>
          <p className="mt-2">
            Provider: <code>{provider.id}</code>
            {provider.checked_probe_id !== undefined && <> · probe: <code>{provider.checked_probe_id}</code></>}
          </p>
        </details>
      </CardContent>
    </Card>
  )
}
