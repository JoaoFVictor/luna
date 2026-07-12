import { CheckCircle2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { StudioAgentTestResult } from "../../../../../src/studio/contracts/agent-test-bench.js"

import { AgentTestBenchExactValue } from "./agent-test-bench-values"

export function AgentTestBenchResult({
  result,
}: {
  result: StudioAgentTestResult
}) {
  return (
    <Card aria-live="polite">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle2Icon className="size-5 text-emerald-600" aria-hidden="true" />
          <CardTitle>Resultado validado</CardTitle>
          <Badge variant="secondary">output schema válido</Badge>
        </div>
        <CardDescription>{result.scope.statement}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
          {JSON.stringify(result.output, null, 2)}
        </pre>
        {result.usage !== undefined && (
          <dl className="grid gap-3 sm:grid-cols-3">
            <AgentTestBenchExactValue
              label="Input tokens"
              value={String(result.usage.input_tokens ?? "n/d")}
            />
            <AgentTestBenchExactValue
              label="Output tokens"
              value={String(result.usage.output_tokens ?? "n/d")}
            />
            <AgentTestBenchExactValue
              label="Total tokens"
              value={String(result.usage.total_tokens ?? "n/d")}
            />
            {result.usage.cost?.total !== undefined && (
              <AgentTestBenchExactValue
                label="Custo reportado"
                value={`${result.usage.cost.total} ${result.usage.cost.unit ?? "unidade do provider"}`}
              />
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}
