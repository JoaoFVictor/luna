import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom"

import { describeStudioError } from "@/api/client"
import { Button } from "@/components/ui/button"

export function RouteErrorPage() {
  const routeError = useRouteError()
  const navigate = useNavigate()
  const described = isRouteErrorResponse(routeError)
    ? {
        title: `Erro ${routeError.status}`,
        message: routeError.statusText || "A rota não pôde ser carregada.",
      }
    : describeStudioError(routeError)
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="max-w-md text-center">
        <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Luna Studio</p>
        <h1 className="mt-2 text-2xl font-semibold">{described.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{described.message}</p>
        <Button className="mt-5" onClick={() => void navigate("/")}>Voltar ao início</Button>
      </div>
    </main>
  )
}
