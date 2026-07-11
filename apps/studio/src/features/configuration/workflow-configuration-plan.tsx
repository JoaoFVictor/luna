import { CheckCircle2Icon, ShieldAlertIcon } from "lucide-react"

import type { ConfigurationApplyPlan, JsonValue } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

function fieldPath(path: readonly string[]): string { return path.join(".") }
function projectedValue(present: boolean, value: JsonValue | undefined): string { return present ? JSON.stringify(value) : "ausente" }

export function WorkflowConfigurationPlan({ plan, mutationPending, draftExists, onConfirm }: {
  plan: ConfigurationApplyPlan
  mutationPending: boolean
  draftExists: boolean
  onConfirm: () => void
}) {
  return <Card><CardHeader><CardTitle>Revisão das alterações</CardTitle><CardDescription>Somente valores autorizados aparecem aqui. O conteúdo privado permanece no servidor.</CardDescription></CardHeader><CardContent className="space-y-4">
    {plan.status === "conflicted" ? <Alert variant="destructive"><ShieldAlertIcon aria-hidden="true" /><AlertTitle>A fonte mudou depois da criação do draft</AlertTitle><AlertDescription>Recrie o draft antes de aplicar. {plan.conflicts.length} conflito(s) detectado(s).</AlertDescription></Alert>
      : plan.changes.length === 0 ? <Alert><AlertTitle>Nenhuma mudança</AlertTitle><AlertDescription>O draft não altera valores expostos pelo Studio.</AlertDescription></Alert>
      : <div className="space-y-3">{plan.changes.map((change) => <div key={fieldPath(change.path)} className="rounded-lg border p-3 text-sm"><p className="font-medium">{change.path.at(-1)}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Comparar valores</summary><div className="mt-2 grid gap-2 sm:grid-cols-2"><div className="rounded bg-muted p-2"><span className="text-xs text-muted-foreground">Antes</span><pre className="mt-1 overflow-x-auto text-xs">{projectedValue(change.before_present, change.before)}</pre></div><div className="rounded bg-muted p-2"><span className="text-xs text-muted-foreground">Depois</span><pre className="mt-1 overflow-x-auto text-xs">{projectedValue(change.after_present, change.after)}</pre></div></div></details></div>)}</div>}
    {plan.status === "ready" && plan.changes.length > 0 && <><Separator /><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Revisão válida até {new Date(plan.expires_at).toLocaleString("pt-BR")}.</p><Button disabled={mutationPending || !draftExists} onClick={onConfirm}><CheckCircle2Icon aria-hidden="true" />Confirmar aplicação</Button></div></>}
  </CardContent></Card>
}
