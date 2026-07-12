import { StudioRunPlanInputSchema } from "../../../../../src/studio/contracts/run-plan-input.js"
import type { RunPlanInput } from "@/api/types"

export type LaunchInputMode = "adapter" | "invocation"

export type LaunchInputBuildResult =
  | { success: true; input: RunPlanInput }
  | { success: false; message: string }

export const DEFAULT_INVOCATION_JSON = JSON.stringify(
  {
    version: "2026-06",
    source: "studio",
    event: "manual",
    payload: {},
  },
  null,
  2,
)

export function buildRunPlanInput(options: {
  mode: LaunchInputMode
  definitionSource?: RunPlanInput["definition_source"]
  executionScope?: RunPlanInput["execution_scope"]
  adapterId: string
  opaqueInput: string
  invocationJson: string
  acknowledgedAdapterEffects: readonly string[]
}): LaunchInputBuildResult {
  let candidate: unknown
  if (options.mode === "adapter") {
    candidate = {
      kind: "adapter",
      adapter_id: options.adapterId,
      input: { kind: "cli", value: options.opaqueInput },
      acknowledged_effects: options.acknowledgedAdapterEffects,
      definition_source: options.definitionSource ?? { kind: "installed" },
      execution_scope: options.executionScope ?? { kind: "workflow" },
    }
  } else {
    let invocation: unknown
    try {
      invocation = JSON.parse(options.invocationJson)
    } catch {
      return {
        success: false,
        message: "A invocation precisa ser um documento JSON válido.",
      }
    }
    candidate = {
      kind: "invocation",
      invocation,
      definition_source: options.definitionSource ?? { kind: "installed" },
      execution_scope: options.executionScope ?? { kind: "workflow" },
    }
  }

  const parsed = StudioRunPlanInputSchema.safeParse(candidate)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      success: false,
      message:
        first === undefined
          ? "A entrada não atende ao contrato canônico de launch."
          : `Entrada inválida em ${first.path.join(".") || "raiz"}: ${first.message}`,
    }
  }
  return { success: true, input: parsed.data }
}
