import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  Clock3Icon,
} from "lucide-react"

import type { DraftStatus, RunStatus } from "@/api/types"
import { Badge } from "@/components/ui/badge"

const RUN_LABELS: Record<RunStatus, string> = {
  queued: "Na fila",
  preparing: "Preparando",
  started: "Iniciada",
  rejected: "Rejeitada",
  historical_unknown: "Histórica · status indisponível",
  running: "Executando",
  waiting_for_input: "Aguardando entrada",
  waiting_for_retry: "Aguardando retry",
  resuming: "Retomando",
  succeeded: "Concluída",
  failed: "Falhou",
  outcome_unknown: "Resultado incerto · ação manual",
  timed_out: "Expirou",
  cancelled: "Cancelada",
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const terminalSuccess = status === "succeeded"
  const terminalFailure = ["failed", "timed_out", "cancelled", "rejected"].includes(
    status,
  )
  const outcomeUnknown = status === "outcome_unknown"
  const Icon = terminalSuccess
    ? CircleCheckIcon
    : terminalFailure
      ? CircleXIcon
      : outcomeUnknown
        ? CircleAlertIcon
      : status.startsWith("waiting")
        ? Clock3Icon
        : CircleDashedIcon
  return (
    <Badge
      variant={terminalFailure ? "destructive" : terminalSuccess ? "secondary" : "outline"}
    >
      <Icon aria-hidden="true" />
      {RUN_LABELS[status]}
    </Badge>
  )
}

const DRAFT_LABELS: Record<DraftStatus, string> = {
  dirty: "Não validado",
  invalid: "Inválido",
  valid: "Válido",
  conflicted: "Conflito externo",
}

export function DraftStatusBadge({ status }: { status: DraftStatus }) {
  const Icon =
    status === "valid"
      ? CircleCheckIcon
      : status === "dirty"
        ? CircleDashedIcon
        : CircleAlertIcon
  return (
    <Badge
      variant={
        status === "invalid" || status === "conflicted"
          ? "destructive"
          : status === "valid"
            ? "secondary"
            : "outline"
      }
    >
      <Icon aria-hidden="true" />
      {DRAFT_LABELS[status]}
    </Badge>
  )
}

export function ModeBadge({ mode }: { mode: "read_only" | "trusted_local_write" }) {
  return (
    <Badge variant={mode === "trusted_local_write" ? "destructive" : "outline"}>
      {mode === "trusted_local_write" ? "Escrita local confiável" : "Somente leitura"}
    </Badge>
  )
}
