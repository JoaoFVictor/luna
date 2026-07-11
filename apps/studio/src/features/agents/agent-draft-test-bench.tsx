import { studioAgentTestBenchApi } from "@/api/agent-test-bench"
import { PageEmpty, PageLoading } from "@/components/page-state"
import { AgentTestBench } from "@/features/agents/agent-test-bench"

export type AgentDraftTestBenchProps = {
  draftId: string
  etag: string
  canMutate: boolean
  hasLocalChanges: boolean
  pending: boolean
}

export function AgentDraftTestBench({
  draftId,
  etag,
  canMutate,
  hasLocalChanges,
  pending,
}: AgentDraftTestBenchProps) {
  if (!canMutate) {
    return (
      <PageEmpty
        title="Test Bench indisponível nesta sessão"
        description="Reinicie o Studio para obter uma sessão local com autoridade antes de planejar uma chamada real ao modelo."
      />
    )
  }
  if (pending) {
    return <PageLoading label="Sincronizando o draft antes do Test Bench" />
  }
  if (hasLocalChanges) {
    return (
      <PageEmpty
        title="Salve o draft antes do Test Bench"
        description="O smoke usa somente a revisão salva e presa pelo ETag. Salve ou descarte todas as alterações locais para continuar."
      />
    )
  }

  return (
    <AgentTestBench
      target={{ kind: "draft", draft_id: draftId, etag }}
      plan={(request, signal) => studioAgentTestBenchApi.plan(request, signal)}
      execute={(planId, request, signal) =>
        studioAgentTestBenchApi.execute(planId, request, signal)}
    />
  )
}
