export function AgentTestBenchEmptyLine({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

export function AgentTestBenchExactValue({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
    </div>
  )
}
