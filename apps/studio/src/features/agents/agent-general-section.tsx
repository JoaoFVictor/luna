import { useEffect, useMemo } from "react"
import { LockKeyholeIcon, SaveIcon } from "lucide-react"

import type { ModelConfiguration, YamlSourceOperation } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
      <Alert>
        <LockKeyholeIcon aria-hidden="true" />
        <AlertTitle>ID e diretório são imutáveis neste draft</AlertTitle>
        <AlertDescription>
          {agent.id || "ID indisponível"}. Renomear exige um novo agent e revisão explícita dos consumidores; este formulário nunca faz rename implícito.
        </AlertDescription>
      </Alert>
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
          <FieldDescription>Responsabilidade reutilizável do agent. Gates, retries e artifact plans pertencem ao workflow.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-model-profile">Model profile</FieldLabel>
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
                {profile.id} · {profile.reasoning_effort} · {profile.transport}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>Lista projetada de `config/models.yaml`; nenhum secret ou valor de environment é exposto.</FieldDescription>
          {models?.diagnostics.map((diagnostic) => (
            <p key={diagnostic.code} className="text-xs text-destructive">{diagnostic.message}</p>
          ))}
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-mode">Mode</FieldLabel>
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
            <NativeSelectOption value="" disabled>Selecione um mode</NativeSelectOption>
            <NativeSelectOption value="read_only">read_only</NativeSelectOption>
            <NativeSelectOption value="trusted_local_write">trusted_local_write</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>O modo controla quais tools o runtime pode materializar. Trusted write não concede commit, push ou criação de PR.</FieldDescription>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || pending || operations.length === 0 || !valid}
          onClick={() => onSave(operations)}
        >
          <SaveIcon aria-hidden="true" />{pending ? "Salvando…" : "Salvar General"}
        </Button>
        {form.dirty && <Button variant="ghost" onClick={form.reset}>Descartar alterações</Button>}
        {!selectedProfileKnown && <Badge variant="destructive">profile não carregado</Badge>}
        {!agent.modeIsKnown && <Badge variant="destructive">mode inválido no YAML; selecione explicitamente</Badge>}
        {operations.length === 0 && <Badge variant="outline">sincronizado</Badge>}
      </div>
    </div>
  )
}
