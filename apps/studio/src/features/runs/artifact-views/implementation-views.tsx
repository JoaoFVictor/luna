import type { z } from "zod"

import { Badge } from "@/components/ui/badge"

import { abbreviatedRevision } from "./common"
import {
  ImplementationChangeRequestViewSchema,
  ImplementationCommitViewSchema,
  ImplementationDiffViewSchema,
  ImplementationGatesViewSchema,
  ImplementationPlanViewSchema,
  ImplementationPushViewSchema,
  ImplementationValidationViewSchema,
  ImplementationWorktreeViewSchema,
} from "./implementation-schemas"
import {
  ArtifactMetrics,
  ArtifactStringList,
  ArtifactViewFrame,
  SafeArtifactText,
} from "./view-primitives"

export function ImplementationPlanView({
  value,
}: {
  value: z.infer<typeof ImplementationPlanViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Plano de implementação">
      <p className="text-sm">
        <SafeArtifactText>{value.summary}</SafeArtifactText>
      </p>
      <ArtifactStringList title="Passos" items={value.steps} />
      <ArtifactStringList title="Arquivos previstos" items={value.files ?? []} />
      <ArtifactStringList title="Validação prevista" items={value.validation ?? []} />
      <ArtifactStringList title="Riscos" items={value.risks} />
    </ArtifactViewFrame>
  )
}

export function ImplementationValidationView({
  value,
}: {
  value: z.infer<typeof ImplementationValidationViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Validação" status={value.passed ? "aprovada" : "falhou"}>
      <ArtifactMetrics items={[{ label: "Comandos executados", value: value.commands.length }]} />
      {value.commands.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum resultado de comando registrado.</p>
      ) : (
        <ol className="space-y-2">
          {value.commands.map((command) => (
            <li key={command.ordinal} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Comando {command.ordinal}</span>
                <Badge variant="outline">
                  {command.timed_out
                    ? "timeout"
                    : command.exit_code === 0
                      ? "exit 0"
                      : `exit ${command.exit_code ?? "indisponível"}`}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {command.duration_ms} ms
                {(command.stdout_truncated || command.stderr_truncated) && " · saída truncada"}
              </p>
            </li>
          ))}
        </ol>
      )}
    </ArtifactViewFrame>
  )
}

export function ImplementationDiffView({
  value,
}: {
  value: z.infer<typeof ImplementationDiffViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Resumo do diff">
      <ArtifactMetrics
        items={[
          { label: "Arquivos", value: value.files.length },
          { label: "Não rastreados", value: value.untracked_file_count },
          {
            label: "Diff staged",
            value: value.staged_diff_truncated ? "truncado" : "completo",
          },
          {
            label: "Diff unstaged",
            value: value.unstaged_diff_truncated ? "truncado" : "completo",
          },
        ]}
      />
      {value.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma alteração detectada.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {value.files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <code className="break-all text-xs">{file.path}</code>
              <span className="flex flex-wrap gap-2">
                <Badge variant="outline">{file.status}</Badge>
                {file.binary && <Badge variant="secondary">binário</Badge>}
                {file.submodule && <Badge variant="secondary">submodule</Badge>}
                {file.large && <Badge variant="secondary">grande</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ArtifactViewFrame>
  )
}

export function ImplementationGatesView({
  value,
}: {
  value: z.infer<typeof ImplementationGatesViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Loop de implementação e gates" status={value.status}>
      <ArtifactMetrics
        items={[
          { label: "Tentativas", value: value.attempt_count },
          { label: "Tentativas esgotadas", value: value.attempts_exhausted ? "sim" : "não" },
          { label: "Validação final", value: value.final_validation_passed ? "passou" : "falhou" },
          { label: "Gates", value: value.gates.length },
        ]}
      />
      <ul className="space-y-2 text-sm">
        {value.gates.map((gate) => (
          <li key={gate.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <span>
              <SafeArtifactText>{gate.id}</SafeArtifactText>
              <span className="ml-2 text-xs text-muted-foreground">
                <SafeArtifactText>{gate.type}</SafeArtifactText>
              </span>
            </span>
            <Badge variant="outline">{gate.passed ? "passou" : "falhou"}</Badge>
          </li>
        ))}
      </ul>
    </ArtifactViewFrame>
  )
}

export function ImplementationWorktreeView({
  value,
}: {
  value: z.infer<typeof ImplementationWorktreeViewSchema>
}) {
  return (
    <ArtifactViewFrame title="Worktree" status={value.lifecycle}>
      <ArtifactMetrics
        items={[
          { label: "Repositório", value: value.repository_id },
          { label: "Remote", value: value.remote },
          { label: "Base", value: value.base_ref },
          { label: "Base SHA", value: abbreviatedRevision(value.base_sha) },
        ]}
      />
      <p className="text-sm">
        Branch: <SafeArtifactText>{value.branch}</SafeArtifactText>
      </p>
      <p className="text-xs text-muted-foreground">
        {value.preserved ? "Worktree preservado" : "Worktree não preservado"} ·{" "}
        <SafeArtifactText>{value.reason}</SafeArtifactText>
      </p>
    </ArtifactViewFrame>
  )
}

export function ImplementationCommitView({
  value,
}: {
  value: z.infer<typeof ImplementationCommitViewSchema>
}) {
  if (value.status === "skipped") {
    return (
      <ArtifactViewFrame title="Commit" status="ignorado">
        <ArtifactMetrics items={[{ label: "Habilitado", value: value.enabled ? "sim" : "não" }]} />
        <p className="text-sm text-muted-foreground">
          <SafeArtifactText>{value.reason}</SafeArtifactText>
        </p>
      </ArtifactViewFrame>
    )
  }
  return (
    <ArtifactViewFrame title="Commit" status="criado">
      <ArtifactMetrics
        items={[
          { label: "Branch", value: value.branch },
          { label: "Commit", value: abbreviatedRevision(value.commit_sha) },
          {
            label: "Adotado",
            value: value.adopted === undefined ? "não informado" : value.adopted ? "sim" : "não",
          },
        ]}
      />
    </ArtifactViewFrame>
  )
}

export function ImplementationPushView({
  value,
}: {
  value: z.infer<typeof ImplementationPushViewSchema>
}) {
  if (value.status === "skipped") {
    return (
      <ArtifactViewFrame title="Push" status="ignorado">
        <ArtifactMetrics items={[{ label: "Habilitado", value: value.enabled ? "sim" : "não" }]} />
        <p className="text-sm text-muted-foreground">
          <SafeArtifactText>{value.reason}</SafeArtifactText>
        </p>
      </ArtifactViewFrame>
    )
  }
  return (
    <ArtifactViewFrame title="Push" status={value.status === "pushed" ? "enviado" : "não enviado"}>
      <ArtifactMetrics
        items={[
          { label: "Remote", value: value.remote },
          { label: "Branch", value: value.branch },
          {
            label: "Commit",
            value: value.commit_sha === undefined ? "não informado" : abbreviatedRevision(value.commit_sha),
          },
        ]}
      />
    </ArtifactViewFrame>
  )
}

export function ImplementationChangeRequestView({
  value,
}: {
  value: z.infer<typeof ImplementationChangeRequestViewSchema>
}) {
  if (value.status === "skipped") {
    return (
      <ArtifactViewFrame title="Change request" status="não criada">
        <ArtifactMetrics items={[{ label: "Habilitada", value: value.enabled ? "sim" : "não" }]} />
        <p className="text-sm text-muted-foreground">
          <SafeArtifactText>{value.reason}</SafeArtifactText>
        </p>
      </ArtifactViewFrame>
    )
  }
  return (
    <ArtifactViewFrame title="Change request" status="criada">
      <p className="font-medium">
        <SafeArtifactText>{value.title}</SafeArtifactText>
      </p>
      <ArtifactMetrics
        items={[
          { label: "Provider", value: value.provider },
          { label: "Origem", value: value.source_branch },
          { label: "Destino", value: value.target_branch },
          { label: "Adotada", value: value.adopted ? "sim" : "não" },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Referência externa: <SafeArtifactText>{value.external_id}</SafeArtifactText>
      </p>
    </ArtifactViewFrame>
  )
}
