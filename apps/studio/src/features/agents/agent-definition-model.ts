import type { JsonValue, StudioMode, YamlSourceOperation } from "@/api/types"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

type JsonRecord = { [key: string]: JsonValue }

export type AgentDefinitionView = {
  readonly sourceIsObject: boolean
  readonly id: string
  readonly description: string
  readonly modelProfile: string
  readonly mode: StudioMode
  readonly modeIsKnown: boolean
  readonly instructionsFile: string
  readonly outputSchema: string
  readonly contextFiles: readonly string[]
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly mcpServers: readonly string[]
  readonly subagents: readonly JsonValue[]
  readonly runtimeRequirements: readonly string[]
  readonly preferredRuntime: string
  readonly runtimeOrder: readonly string[]
  readonly contextIsObject: boolean
  readonly contextHasUnknownFields: boolean
  readonly runtimePreferencesIsObject: boolean
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(record: JsonRecord, key: string): string {
  return typeof record[key] === "string" ? record[key] : ""
}

function stringList(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export function agentDefinitionView(source: JsonValue | undefined): AgentDefinitionView {
  if (!isRecord(source)) {
    return {
      sourceIsObject: false,
      id: "",
      description: "",
      modelProfile: "",
      mode: "read_only",
      modeIsKnown: false,
      instructionsFile: "",
      outputSchema: "",
      contextFiles: [],
      skills: [],
      tools: [],
      mcpServers: [],
      subagents: [],
      runtimeRequirements: [],
      preferredRuntime: "",
      runtimeOrder: [],
      contextIsObject: false,
      contextHasUnknownFields: false,
      runtimePreferencesIsObject: false,
    }
  }
  const context = isRecord(source.context) ? source.context : undefined
  const preferences = isRecord(source.runtime_preferences)
    ? source.runtime_preferences
    : undefined
  return {
    sourceIsObject: true,
    id: stringValue(source, "id"),
    description: stringValue(source, "description"),
    modelProfile: stringValue(source, "model_profile"),
    mode: source.mode === "trusted_local_write" ? "trusted_local_write" : "read_only",
    modeIsKnown: source.mode === "read_only" || source.mode === "trusted_local_write",
    instructionsFile: stringValue(source, "instructions_file"),
    outputSchema: stringValue(source, "output_schema"),
    contextFiles: stringList(context?.files),
    skills: stringList(source.skills),
    tools: stringList(source.tools),
    mcpServers: stringList(source.mcp_servers),
    subagents: Array.isArray(source.subagents) ? source.subagents : [],
    runtimeRequirements: stringList(source.runtime_requirements),
    preferredRuntime: preferences === undefined
      ? ""
      : stringValue(preferences, "preferred_runtime"),
    runtimeOrder: stringList(preferences?.runtime_order),
    contextIsObject: context !== undefined,
    contextHasUnknownFields:
      context !== undefined && Object.keys(context).some((key) => key !== "files"),
    runtimePreferencesIsObject: preferences !== undefined,
  }
}

export function uniqueTrimmedLines(value: string): readonly string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    unique.push(line)
  }
  return unique
}

export function optionalListOperation(
  path: readonly string[],
  values: readonly string[],
): YamlSourceOperation {
  return values.length === 0
    ? { op: "delete", path: [...path] }
    : { op: "set", path: [...path], value: [...values] }
}

export function optionalStringOperation(
  path: readonly string[],
  value: string,
): YamlSourceOperation {
  const trimmed = value.trim()
  return trimmed.length === 0
    ? { op: "delete", path: [...path] }
    : { op: "set", path: [...path], value: trimmed }
}

export function parseSubagents(value: string):
  | { readonly ok: true; readonly value: readonly JsonValue[] }
  | { readonly ok: false; readonly message: string } {
  try {
    const parsed = StudioJsonValueSchema.parse(JSON.parse(value))
    if (!Array.isArray(parsed)) {
      return { ok: false, message: "Subagents deve ser um array JSON." }
    }
    const valid = parsed.every((item) =>
      typeof item === "string" ||
      (item !== null && typeof item === "object" && !Array.isArray(item))
    )
    if (!valid) {
      return { ok: false, message: "Cada subagent deve ser um id ou objeto de policy." }
    }
    return { ok: true, value: parsed }
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "JSON de subagents inválido.",
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export type AgentGeneralForm = {
  readonly description: string
  readonly modelProfile: string
  readonly mode: StudioMode | ""
}

export function agentGeneralOperations(
  current: AgentDefinitionView,
  form: AgentGeneralForm,
): readonly YamlSourceOperation[] {
  const operations: YamlSourceOperation[] = []
  const description = form.description.trim()
  const modelProfile = form.modelProfile.trim()
  if (description !== current.description) {
    operations.push({ op: "set", path: ["description"], value: description })
  }
  if (modelProfile !== current.modelProfile) {
    operations.push({ op: "set", path: ["model_profile"], value: modelProfile })
  }
  if (form.mode !== "" && (!current.modeIsKnown || form.mode !== current.mode)) {
    operations.push({ op: "set", path: ["mode"], value: form.mode })
  }
  return operations
}

export type AgentResourcesForm = {
  readonly contextFiles: readonly string[]
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly mcpServers: readonly string[]
  readonly subagents: readonly JsonValue[]
  readonly runtimeRequirements: readonly string[]
  readonly preferredRuntime: string
  readonly runtimeOrder: readonly string[]
}

function sameJsonValues(left: readonly JsonValue[], right: readonly JsonValue[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function contextFilesOperation(
  current: AgentDefinitionView,
  values: readonly string[],
): YamlSourceOperation | undefined {
  if (sameStrings(values, current.contextFiles)) return undefined
  if (values.length > 0) {
    return current.contextIsObject
      ? { op: "set", path: ["context", "files"], value: [...values] }
      : { op: "set", path: ["context"], value: { files: [...values] } }
  }
  return current.contextHasUnknownFields
    ? { op: "delete", path: ["context", "files"] }
    : { op: "delete", path: ["context"] }
}

function runtimePreferenceOperations(
  current: AgentDefinitionView,
  preferredRuntime: string,
  runtimeOrder: readonly string[],
): readonly YamlSourceOperation[] {
  const preferred = preferredRuntime.trim()
  if (!current.runtimePreferencesIsObject) {
    if (preferred.length === 0 && runtimeOrder.length === 0) return []
    return [{
      op: "set",
      path: ["runtime_preferences"],
      value: {
        ...(preferred.length === 0 ? {} : { preferred_runtime: preferred }),
        ...(runtimeOrder.length === 0 ? {} : { runtime_order: [...runtimeOrder] }),
      },
    }]
  }
  const operations: YamlSourceOperation[] = []
  if (preferred !== current.preferredRuntime) {
    operations.push(optionalStringOperation(
      ["runtime_preferences", "preferred_runtime"],
      preferred,
    ))
  }
  if (!sameStrings(runtimeOrder, current.runtimeOrder)) {
    operations.push(optionalListOperation(
      ["runtime_preferences", "runtime_order"],
      runtimeOrder,
    ))
  }
  return operations
}

export function agentResourcesOperations(
  current: AgentDefinitionView,
  form: AgentResourcesForm,
): readonly YamlSourceOperation[] {
  const operations: YamlSourceOperation[] = []
  const contextOperation = contextFilesOperation(current, form.contextFiles)
  if (contextOperation !== undefined) operations.push(contextOperation)
  for (const [path, currentValues, nextValues] of [
    [["skills"], current.skills, form.skills],
    [["tools"], current.tools, form.tools],
    [["mcp_servers"], current.mcpServers, form.mcpServers],
    [["runtime_requirements"], current.runtimeRequirements, form.runtimeRequirements],
  ] as const) {
    if (!sameStrings(nextValues, currentValues)) {
      operations.push(optionalListOperation(path, nextValues))
    }
  }
  if (!sameJsonValues(form.subagents, current.subagents)) {
    operations.push(form.subagents.length === 0
      ? { op: "delete", path: ["subagents"] }
      : { op: "set", path: ["subagents"], value: [...form.subagents] })
  }
  operations.push(...runtimePreferenceOperations(
    current,
    form.preferredRuntime,
    form.runtimeOrder,
  ))
  return operations
}
