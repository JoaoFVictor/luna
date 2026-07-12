import { AlertCircleIcon, InboxIcon, RefreshCcwIcon } from "lucide-react"

import { describeStudioError } from "@/api/client"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

export function PageLoading({ label = "Carregando" }: { label?: string }) {
  return (
    <div className="space-y-4" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

export function PageError({
  error,
  retry,
}: {
  error: unknown
  retry?: () => void
}) {
  const described = describeStudioError(error)
  return (
    <Alert variant="destructive" className="max-w-3xl">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>{described.title}</AlertTitle>
      <AlertDescription>
        <p>{described.message}</p>
        {(described.requestId !== undefined || described.code !== undefined || described.technicalMessage !== undefined) && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs">Detalhes técnicos</summary>
            <div className="mt-1 space-y-1 font-mono text-xs">
              {described.code !== undefined && <p>Código: {described.code}</p>}
              {described.requestId !== undefined && <p>Request ID: {described.requestId}</p>}
              {described.technicalMessage !== undefined && <p>{described.technicalMessage}</p>}
            </div>
          </details>
        )}
        {retry !== undefined && (
          <Button className="mt-3" variant="outline" size="sm" onClick={retry}>
            <RefreshCcwIcon aria-hidden="true" />
            Tentar novamente
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function PageEmpty({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="min-h-56 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
