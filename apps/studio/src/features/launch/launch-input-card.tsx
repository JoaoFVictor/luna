import { CircleAlertIcon, FileJsonIcon, PlayIcon, RouteIcon } from "lucide-react"

import type { InputAdapterCatalog } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { LaunchInputMode } from "@/features/launch/launch-input"
import { launchAdapterDescription, launchAdapterLabel, launchAdapterPlaceholder, launchEffectLabel } from "@/features/launch/launch-presentation"

type LaunchInputCardProps = {
  adapters: InputAdapterCatalog["adapters"]
  mode: LaunchInputMode
  adapterId: string
  opaqueInput: string
  invocationJson: string
  acknowledgedAdapterEffects: readonly string[]
  canMutate: boolean
  planning: boolean
  previewing: boolean
  executing: boolean
  inputError?: string
  invocationRoutingDescription: string
  onModeChange: (value: string) => void
  onAdapterChange: (value: string) => void
  onOpaqueInputChange: (value: string) => void
  onInvocationJsonChange: (value: string) => void
  onAdapterEffectChange: (effect: string, checked: boolean) => void
  onPreview: () => void
}

export function LaunchInputCard(props: LaunchInputCardProps) {
  const selectedAdapter = props.adapters.find(
    (adapter) => adapter.id === props.adapterId,
  )
  const requiredEffects = selectedAdapter?.preview.enabled
    ? selectedAdapter.preview.effects
    : []
  const adapterEffectsAcknowledged = requiredEffects.every((effect) =>
    props.acknowledgedAdapterEffects.includes(effect),
  )
  const selectedDescription = selectedAdapter === undefined
    ? "Nenhuma entrada registrada."
    : launchAdapterDescription(selectedAdapter.id, selectedAdapter.description)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Escolha uma entrada</CardTitle>
        <CardDescription>
          Use o valor de entrada aceito por uma das fontes configuradas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset disabled={props.executing} className="space-y-5 disabled:opacity-70">
          <Tabs value={props.mode} onValueChange={props.onModeChange}>
            <TabsList>
              <TabsTrigger value="adapter"><RouteIcon aria-hidden="true" /> Entrada comum</TabsTrigger>
              <TabsTrigger value="invocation"><FileJsonIcon aria-hidden="true" /> Avançado</TabsTrigger>
            </TabsList>

            <TabsContent value="adapter" className="space-y-5 pt-4">
              <Field>
                <FieldLabel htmlFor="launch-adapter">Fonte</FieldLabel>
                <NativeSelect
                  id="launch-adapter"
                  className="w-full"
                  value={props.adapterId}
                  onChange={(event) => props.onAdapterChange(event.target.value)}
                >
                  {props.adapters.map((adapter) => (
                    <NativeSelectOption key={adapter.id} value={adapter.id}>
                      {launchAdapterLabel(adapter.id, adapter.source)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>{selectedDescription}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="launch-input">Valor de entrada</FieldLabel>
                <Input
                  id="launch-input"
                  value={props.opaqueInput}
                  onChange={(event) => props.onOpaqueInputChange(event.target.value)}
                  placeholder={launchAdapterPlaceholder()}
                  autoComplete="off"
                />
                <FieldDescription>{selectedDescription}</FieldDescription>
              </Field>

              {selectedAdapter?.preview.enabled === false && (
                <Alert>
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>Carregamento pelo adapter indisponível</AlertTitle>
                  <AlertDescription>
                    Este adapter não declarou os efeitos de carregamento e, por isso, não pode gerar preview nem plano no Studio. Use uma Invocation JSON já normalizada.
                  </AlertDescription>
                </Alert>
              )}

              {requiredEffects.length > 0 && (
                <fieldset className="space-y-2 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">Para carregar esta entrada</legend>
                  <p className="text-xs text-muted-foreground">Nada será executado ainda. Estas permissões servem somente para localizar e preparar os dados.</p>
                  {requiredEffects.map((effect) => (
                    <label key={effect} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={props.acknowledgedAdapterEffects.includes(effect)}
                        onChange={(event) => props.onAdapterEffectChange(
                          effect,
                          event.target.checked,
                        )}
                        className="size-4 accent-primary"
                      />
                      <span>{launchEffectLabel(effect)}</span>
                    </label>
                  ))}
                </fieldset>
              )}

              <details>
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Ver como esta entrada será roteada</summary>
                <Button type="button" variant="outline" className="mt-2" onClick={props.onPreview} disabled={!props.canMutate || selectedAdapter?.preview.enabled !== true || props.opaqueInput.trim().length === 0 || !adapterEffectsAcknowledged || props.previewing}>
                  <RouteIcon aria-hidden="true" /> {props.previewing ? "Verificando rota…" : "Verificar rota"}
                </Button>
              </details>
            </TabsContent>

            <TabsContent value="invocation" className="pt-4">
              <Field>
                <FieldLabel htmlFor="launch-invocation">Invocation JSON</FieldLabel>
                <Textarea
                  id="launch-invocation"
                  className="min-h-72 font-mono text-xs"
                  value={props.invocationJson}
                  onChange={(event) => props.onInvocationJsonChange(event.target.value)}
                  spellCheck={false}
                />
                <FieldDescription>{props.invocationRoutingDescription}</FieldDescription>
              </Field>
            </TabsContent>
          </Tabs>
        </fieldset>

        {props.inputError !== undefined && (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Entrada ou preview inválido</AlertTitle>
            <AlertDescription>{props.inputError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={
              !props.canMutate ||
              props.planning ||
              props.executing ||
              (props.mode === "adapter" &&
                (props.adapterId.length === 0 ||
                  props.opaqueInput.trim().length === 0 ||
                  selectedAdapter?.preview.enabled !== true ||
                  !adapterEffectsAcknowledged))
            }
          >
            <PlayIcon aria-hidden="true" />
            {props.planning ? "Preparando…" : "Continuar"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Você revisará o workflow e os efeitos antes de executar.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
