import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import { redactPhysicalPaths } from "./common"

export function ArtifactViewFrame({
  title,
  status,
  children,
}: {
  title: string
  status?: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {status !== undefined && <Badge variant="outline">{status}</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

export function ArtifactMetrics({
  items,
}: {
  items: readonly { label: string; value: string | number }[]
}) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 font-medium">
            {typeof item.value === "string" ? (
              <SafeArtifactText>{item.value}</SafeArtifactText>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function SafeArtifactText({ children }: { children: string }) {
  return <>{redactPhysicalPaths(children)}</>
}

export function ArtifactStringList({
  title,
  items,
  empty = "Nenhum item.",
}: {
  title: string
  items: readonly string[]
  empty?: string
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((item, index) => (
            <li key={`${index}:${item}`} className="rounded-md border px-3 py-2">
              <SafeArtifactText>{item}</SafeArtifactText>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
