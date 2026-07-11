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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Entrada do run</CardTitle>
        <CardDescription>
          O request público aceita somente o union canônico de invocation ou adapter com <code>{`{ kind: "cli", value }`}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset disabled={props.executing} className="space-y-5 disabled:opacity-70">
          <Tabs value={props.mode} onValueChange={props.onModeChange}>
            <TabsList>
              <TabsTrigger value="adapter"><RouteIcon aria-hidden="true" /> Adapter + string</TabsTrigger>
              <TabsTrigger value="invocation"><FileJsonIcon aria-hidden="true" /> Invocation JSON</TabsTrigger>
            </TabsList>

            <TabsContent value="adapter" className="space-y-5 pt-4">
              <Field>
                <FieldLabel htmlFor="launch-adapter">Adapter de origem</FieldLabel>
                <NativeSelect
                  id="launch-adapter"
                  className="w-full"
                  value={props.adapterId}
                  onChange={(event) => props.onAdapterChange(event.target.value)}
                >
                  {props.adapters.map((adapter) => (
                    <NativeSelectOption key={adapter.id} value={adapter.id}>
                      {adapter.id} · {adapter.source}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>{selectedAdapter?.description ?? "Nenhum adapter registrado."}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="launch-input">String opaca / URL</FieldLabel>
                <Input
                  id="launch-input"
                  value={props.opaqueInput}
                  onChange={(event) => props.onOpaqueInputChange(event.target.value)}
                  placeholder="https://github.com/org/repo/pull/123"
                  autoComplete="off"
                />
                <FieldDescription>O Studio não interpreta esse valor; somente o adapter selecionado pode normalizá-lo.</FieldDescription>
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
                  <legend className="px-1 text-sm font-medium">Efeitos ao carregar o adapter</legend>
                  <p className="text-xs text-muted-foreground">Estes aceites autorizam o adapter durante o preview ou a criação do plano. Eles não confirmam nem iniciam o run real.</p>
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
                      <code>{effect}</code>
                    </label>
                  ))}
                </fieldset>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={props.onPreview}
                disabled={
                  !props.canMutate ||
                  selectedAdapter?.preview.enabled !== true ||
                  props.opaqueInput.trim().length === 0 ||
                  !adapterEffectsAcknowledged ||
                  props.previewing
                }
              >
                <RouteIcon aria-hidden="true" />
                {props.previewing ? "Normalizando e roteando…" : "Preview adapter + routing"}
              </Button>
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
                <FieldDescription>O router instalado ainda decide o workflow; um target conflitante é rejeitado pelo backend.</FieldDescription>
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
            {props.planning ? "Capturando plano…" : "Gerar plano autoritativo"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Gerar o plano não inicia o workflow. No modo adapter, ele carrega a origem usando exatamente os efeitos aceitos acima.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
