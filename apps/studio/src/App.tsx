import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "react-router-dom"
import { Toaster } from "sonner"

import { StudioApiError } from "@/api/client"
import type { BootstrapState } from "@/api/types"
import { AppErrorBoundary } from "@/app/app-error-boundary"
import { studioRouter } from "@/app/router"
import { EditorStateProvider, SessionProvider } from "@/app/session-context"
import { TooltipProvider } from "@/components/ui/tooltip"

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  return !(error instanceof StudioApiError) || error.status === 0 || error.status >= 500
}

export default function App({ bootstrap }: { bootstrap: BootstrapState }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: shouldRetry,
          },
          mutations: { retry: false },
        },
      }),
  )

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SessionProvider bootstrap={bootstrap}>
          <EditorStateProvider>
            <TooltipProvider>
              <RouterProvider router={studioRouter} />
              <Toaster position="bottom-right" richColors closeButton />
            </TooltipProvider>
          </EditorStateProvider>
        </SessionProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  )
}
