import { AlertTriangleIcon, WrenchIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { StudioAgentTestPlan } from "../../../../../src/studio/contracts/agent-test-bench.js"

import { AgentTestBenchEmptyLine } from "./agent-test-bench-values"

export function AgentTestBenchCapabilities({
  plan,
}: {
  plan: StudioAgentTestPlan
}) {
  const { resolution } = plan
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capabilities declaradas</CardTitle>
        <CardDescription>
          São exibidas para auditoria, mas nenhuma é materializada neste smoke.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section aria-labelledby="agent-test-tools">
          <h3 id="agent-test-tools" className="flex items-center gap-2 text-sm font-semibold">
            <WrenchIcon className="size-4" aria-hidden="true" /> Tools
          </h3>
          {resolution.tools.length === 0 ? (
            <AgentTestBenchEmptyLine>Nenhuma tool declarada.</AgentTestBenchEmptyLine>
          ) : (
            <ul className="mt-2 space-y-2">
              {resolution.tools.map((tool) => (
                <li key={tool.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <code>{tool.id}</code>
                    <Badge variant="outline">{tool.protocol}</Badge>
                    <Badge variant="destructive">não executada</Badge>
                    {tool.safety?.local_writes && <Badge variant="destructive">write local</Badge>}
                    {tool.safety?.network && <Badge variant="destructive">network</Badge>}
                    {tool.safety?.external_side_effects && (
                      <Badge variant="destructive">efeito externo</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">{tool.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Separator />

        <section aria-labelledby="agent-test-mcp">
          <h3 id="agent-test-mcp" className="text-sm font-semibold">MCP servers</h3>
          {resolution.mcp_servers.length === 0 ? (
            <AgentTestBenchEmptyLine>Nenhum MCP declarado.</AgentTestBenchEmptyLine>
          ) : (
            <ul className="mt-2 space-y-2">
              {resolution.mcp_servers.map((server) => (
                <li key={server.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <code>{server.id}</code>
                    <Badge variant={server.runtime_supported ? "secondary" : "destructive"}>
                      {server.runtime_supported ? "runtime suporta" : "runtime não suporta"}
                    </Badge>
                    <Badge variant="destructive">não executado</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{server.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Separator />

        <section aria-labelledby="agent-test-subagents">
          <h3 id="agent-test-subagents" className="text-sm font-semibold">Subagents</h3>
          {resolution.subagents.length === 0 ? (
            <AgentTestBenchEmptyLine>Nenhum subagent declarado.</AgentTestBenchEmptyLine>
          ) : (
            <ul className="mt-2 space-y-2">
              {resolution.subagents.map((subagent) => (
                <li key={subagent.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <code>{subagent.id}</code>
                    <Badge variant="outline">{subagent.declared_mode}</Badge>
                    <Badge variant="destructive">não executado</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{subagent.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {(resolution.declared_skills.length > 0 ||
          resolution.declared_agent_context_files.length > 0) && (
          <Alert>
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>Skills e context files também estão excluídos</AlertTitle>
            <AlertDescription>
              Skills: {resolution.declared_skills.join(", ") || "nenhuma"}. Context files: {resolution.declared_agent_context_files.join(", ") || "nenhum"}.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
