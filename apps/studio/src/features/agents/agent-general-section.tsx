import { useEffect, useMemo } from "react"
import { LockKeyholeIcon, SaveIcon } from "lucide-react"

import type { ModelConfiguration, YamlSourceOperation } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import {
  agentGeneralOperations,
  type AgentDefinitionView,
  type AgentGeneralForm,
} from "@/features/agents/agent-definition-model"
import { useServerBackedForm } from "@/features/agents/use-server-backed-form"
import { humanizeTechnicalId } from "@/lib/presentation"

function profileLabel(profile: ModelConfiguration["profiles"][number]): string {
  const depth = profile.reasoning_effort === "high"
    ? "raciocínio profundo"
    : profile.reasoning_effort === "low"
      ? "mais rápido"
      : "equilibrado"
  return `${humanizeTechnicalId(profile.id)} · ${depth}`
}

export function AgentGeneralSection({
  agent,
  models,
  disabled,
  pending,
  onDirtyChange,
  onSave,
}: {
  agent: AgentDefinitionView
  models?: ModelConfiguration
  disabled: boolean
  pending: boolean
  onDirtyChange: (dirty: boolean) => void
  onSave: (operations: readonly YamlSourceOperation[]) => void
}) {
  const serverForm = useMemo<AgentGeneralForm>(() => ({
    description: agent.description,
    modelProfile: agent.modelProfile,
    mode: agent.modeIsKnown ? agent.mode : "",
  }), [agent.description, agent.mode, agent.modeIsKnown, agent.modelProfile])
  const form = useServerBackedForm(serverForm)
  const operations = agentGeneralOperations(agent, form.value)
  const profileIds = new Set(models?.profiles.map((profile) => profile.id) ?? [])
  const selectedProfileKnown = profileIds.has(form.value.modelProfile)
  const valid =
    form.value.description.trim().length > 0 &&
    selectedProfileKnown &&
    form.value.mode !== ""
  const semanticallyDirty = operations.length > 0

  useEffect(() => onDirtyChange(semanticallyDirty), [onDirtyChange, semanticallyDirty])

  return (
    <div className="space-y-5">
      <details className="rounded-lg border p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground"><LockKeyholeIcon className="mr-2 inline size-4" aria-hidden="true" />Identificação técnica</summary>
        <p className="mt-2">ID: <code>{agent.id || "indisponível"}</code>. Para renomear sem quebrar workflows, crie outro agent e revise os usos.</p>
      </details>
      <div className="grid gap-4 lg:grid-cols-2">
        <Field className="lg:col-span-2">
          <FieldLabel htmlFor="agent-description">Descrição</FieldLabel>
          <Textarea
            id="agent-description"
            value={form.value.description}
            disabled={disabled}
            maxLength={2_000}
            onChange={(event) => form.setValue({ ...form.value, description: event.target.value })}
          />
          <FieldDescription>Explique em uma frase o resultado que este especialista deve produzir.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-model-profile">Modelo</FieldLabel>
          <NativeSelect
            id="agent-model-profile"
            value={form.value.modelProfile}
            disabled={disabled || models === undefined || models.profiles.length === 0}
            onChange={(event) => form.setValue({ ...form.value, modelProfile: event.target.value })}
          >
            {!selectedProfileKnown && form.value.modelProfile.length > 0 && (
              <NativeSelectOption value={form.value.modelProfile}>{form.value.modelProfile} (não carregado)</NativeSelectOption>
            )}
            {(models?.profiles ?? []).map((profile) => (
              <NativeSelectOption key={profile.id} value={profile.id}>
                {profileLabel(profile)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>Escolha entre mais velocidade, profundidade de raciocínio ou equilíbrio.</FieldDescription>
          {(models?.diagnostics.length ?? 0) > 0 && (
            <details className="text-xs text-destructive">
              <summary className="cursor-pointer">Alguns modelos não puderam ser carregados</summary>
              <ul className="mt-1 space-y-1 font-mono">{models?.diagnostics.map((diagnostic) => <li key={diagnostic.code}>{diagnostic.message}</li>)}</ul>
            </details>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-mode">Permissão</FieldLabel>
          <NativeSelect
            id="agent-mode"
            value={form.value.mode}
            disabled={disabled}
            onChange={(event) => form.setValue({
              ...form.value,
              mode: event.target.value === "trusted_local_write"
                ? "trusted_local_write"
                : event.target.value === "read_only"
                  ? "read_only"
                  : "",
            })}
          >
            <NativeSelectOption value="" disabled>Selecione uma permissão</NativeSelectOption>
            <NativeSelectOption value="read_only">Somente leitura</NativeSelectOption>
            <NativeSelectOption value="trusted_local_write">Pode editar arquivos locais</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>Editar arquivos não permite commit, push ou criação de change request.</FieldDescription>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || pending || operations.length === 0 || !valid}
          onClick={() => onSave(operations)}
        >
          <SaveIcon aria-hidden="true" />{pending ? "Salvando…" : "Salvar identidade"}
        </Button>
        {form.dirty && <Button variant="ghost" onClick={form.reset}>Descartar alterações</Button>}
        {!selectedProfileKnown && <Badge variant="destructive">modelo indisponível</Badge>}
        {!agent.modeIsKnown && <Badge variant="destructive">permissão inválida; selecione novamente</Badge>}
        {operations.length === 0 && <Badge variant="outline">sincronizado</Badge>}
      </div>
    </div>
  )
}
