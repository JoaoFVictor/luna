import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangleIcon, BracesIcon, FileJsonIcon, FileTextIcon, Settings2Icon, UsersIcon } from "lucide-react"
import { isNamespacedCapabilityId } from "../../../../../src/core/capabilities/ids.js"

import type {
  AgentCatalog,
  AgentCatalogItem,
  CapabilityCatalog,
  DraftFile,
  ModelConfiguration,
  RuntimeConfiguration,
  WorkflowCatalog,
  WorkflowSummary,
  YamlSourceOperation,
} from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { draftFileKey, type DraftFileContents } from "@/features/drafts/draft-file-session"
import { agentDefinitionView } from "@/features/agents/agent-definition-model"
import { AgentGeneralSection } from "@/features/agents/agent-general-section"
import { AgentInstructionsSection } from "@/features/agents/agent-instructions-section"
import {
  AgentOutputContractSection,
  AgentRegisteredOutputContractSection,
} from "@/features/agents/agent-output-contract-section"
import { AgentResourcesSection } from "@/features/agents/agent-resources-section"
import { AgentUsageSection } from "@/features/agents/agent-usage-section"

type DirtySection = "general" | "instructions" | "output" | "resources"

function agentOwnedPath(agentId: string, reference: string): string | undefined {
  if (
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)
  ) {
    return undefined
  }
  const segments = reference.split("/").filter((segment) => segment !== ".")
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "..")) {
    return undefined
  }
  return `agents/${agentId}/${segments.join("/")}`
}

function findOwnedFile(
  files: readonly DraftFile[],
  agentId: string,
  reference: string,
): DraftFile | undefined {
  const expected = agentOwnedPath(agentId, reference)
  return expected === undefined
    ? undefined
    : files.find((file) =>
        file.state === "present" &&
        file.file.root === "project" &&
        file.file.path === expected
      )
}

function MissingOwnedFile({ kind, reference }: { kind: string; reference: string }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>{kind} indisponível no draft</AlertTitle>
      <AlertDescription>A referência `{reference || "(vazia)"}` não aponta para um arquivo agent-owned presente. Corrija no editor raw e valide pelo loader real.</AlertDescription>
    </Alert>
  )
}

function MissingRegisteredSchema({ reference }: { reference: string }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>Output contract não registrado</AlertTitle>
      <AlertDescription>O capability registry carregado não contém o schema `{reference}`. O loader canônico bloqueará este agent até o plugin proprietário estar disponível.</AlertDescription>
    </Alert>
  )
}

export function AgentStructuredEditor({
  agentId,
  source,
  files,
  contents,
  models,
  library,
  agents,
  agentsCatalogStatus,
  runtime,
  workflows,
  workflowsCatalogStatus,
  canMutate,
  rawLocalChanges,
  pending,
  onDirtyChange,
  onSourceSave,
  onFileSave,
}: {
  agentId: string
  source: Parameters<typeof agentDefinitionView>[0]
  files: readonly DraftFile[]
  contents: DraftFileContents
  models?: ModelConfiguration
  library?: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  agentsCatalogStatus: AgentCatalog["status"]
  runtime?: RuntimeConfiguration
  workflows: readonly WorkflowSummary[]
  workflowsCatalogStatus: WorkflowCatalog["status"]
  canMutate: boolean
  rawLocalChanges: boolean
  pending: boolean
  onDirtyChange: (dirty: boolean) => void
  onSourceSave: (operations: readonly YamlSourceOperation[]) => void
  onFileSave: (file: DraftFile, content: string) => void
}) {
  const agent = useMemo(() => agentDefinitionView(source), [source])
  const instructionsFile = findOwnedFile(files, agentId, agent.instructionsFile)
  const outputIsRegistered =
    isNamespacedCapabilityId(agent.outputSchema) &&
    !agent.outputSchema.endsWith(".json")
  const outputFile = outputIsRegistered
    ? undefined
    : findOwnedFile(files, agentId, agent.outputSchema)
  const registeredOutput = outputIsRegistered
    ? library?.registrations.find(
        (registration) => registration.registration_kind === "schema" && registration.id === agent.outputSchema,
      )
    : undefined
  const [dirty, setDirty] = useState<Record<DirtySection, boolean>>({
    general: false,
    instructions: false,
    output: false,
    resources: false,
  })
  const updateDirty = useCallback((section: DirtySection, value: boolean) => {
    setDirty((current) => current[section] === value ? current : { ...current, [section]: value })
  }, [])
  const generalDirty = useCallback((value: boolean) => updateDirty("general", value), [updateDirty])
  const instructionsDirty = useCallback((value: boolean) => updateDirty("instructions", value), [updateDirty])
  const outputDirty = useCallback((value: boolean) => updateDirty("output", value), [updateDirty])
  const resourcesDirty = useCallback((value: boolean) => updateDirty("resources", value), [updateDirty])
  const anyDirty = Object.values(dirty).some(Boolean)
  const disabled = !canMutate || rawLocalChanges || pending || !agent.sourceIsObject

  useEffect(() => onDirtyChange(anyDirty), [anyDirty, onDirtyChange])
  useEffect(() => {
    if (outputFile === undefined) updateDirty("output", false)
  }, [outputFile, updateDirty])
  useEffect(() => {
    if (instructionsFile === undefined) updateDirty("instructions", false)
  }, [instructionsFile, updateDirty])

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {rawLocalChanges && (
        <Alert variant="destructive">
          <BracesIcon aria-hidden="true" />
          <AlertTitle>Edição estruturada pausada</AlertTitle>
          <AlertDescription>Salve ou descarte as alterações do editor raw antes de enviar operações estruturadas. Isso evita aplicar uma mutação sobre um ETag obsoleto.</AlertDescription>
        </Alert>
      )}
      {!agent.sourceIsObject && (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Projeção estruturada indisponível</AlertTitle>
          <AlertDescription>O `agent.yaml` não contém um mapping YAML projetável. O raw fallback permanece disponível e nenhum conteúdo foi descartado.</AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="general">
        <div className="overflow-x-auto">
          <TabsList variant="line" className="h-10">
            <TabsTrigger value="general"><Settings2Icon aria-hidden="true" /> Identidade</TabsTrigger>
            <TabsTrigger value="instructions"><FileTextIcon aria-hidden="true" /> Instruções</TabsTrigger>
            <TabsTrigger value="resources"><BracesIcon aria-hidden="true" /> Recursos e permissões</TabsTrigger>
            <TabsTrigger value="output"><FileJsonIcon aria-hidden="true" /> Formato da resposta</TabsTrigger>
            <TabsTrigger value="usage"><UsersIcon aria-hidden="true" /> Onde é usado</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="general" className="pt-5" keepMounted>
          <AgentGeneralSection agent={agent} models={models} disabled={disabled} pending={pending} onDirtyChange={generalDirty} onSave={onSourceSave} />
        </TabsContent>
        <TabsContent value="instructions" className="pt-5" keepMounted>
          {instructionsFile === undefined
            ? <MissingOwnedFile kind="Instructions" reference={agent.instructionsFile} />
            : <AgentInstructionsSection path={instructionsFile.file.path} content={contents[draftFileKey(instructionsFile)] ?? ""} disabled={disabled} pending={pending} onDirtyChange={instructionsDirty} onSave={(content) => onFileSave(instructionsFile, content)} />}
        </TabsContent>
        <TabsContent value="output" className="pt-5" keepMounted>
          {outputFile !== undefined
            ? <AgentOutputContractSection file={outputFile} content={contents[draftFileKey(outputFile)] ?? ""} disabled={disabled} pending={pending} onDirtyChange={outputDirty} onSave={(content) => onFileSave(outputFile, content)} />
            : registeredOutput?.registration_kind === "schema"
              ? <AgentRegisteredOutputContractSection schemaId={registeredOutput.id} schema={registeredOutput.schema} />
              : outputIsRegistered
                ? <MissingRegisteredSchema reference={agent.outputSchema} />
                : <MissingOwnedFile kind="Output contract" reference={agent.outputSchema} />}
        </TabsContent>
        <TabsContent value="resources" className="pt-5" keepMounted>
          <AgentResourcesSection agent={agent} agentId={agentId} library={library} agents={agents} runtime={runtime} disabled={disabled} pending={pending} onDirtyChange={resourcesDirty} onSave={onSourceSave} />
        </TabsContent>
        <TabsContent value="usage" className="pt-5" keepMounted>
          <AgentUsageSection
            agent={agent}
            workflows={workflows}
            agents={agents}
            agentsCatalogStatus={agentsCatalogStatus}
            workflowsCatalogStatus={workflowsCatalogStatus}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
