import { describeStudioError } from "@/api/client"

export function BootstrapScreen() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="text-center" role="status">
        <div className="mx-auto size-8 animate-pulse rounded-xl bg-primary" />
        <p className="mt-4 text-sm font-medium">Abrindo sessão local segura…</p>
        <p className="mt-1 text-xs text-muted-foreground">Isso acontece automaticamente e leva apenas um instante.</p>
      </div>
    </main>
  )
}

export function BootstrapFailure({ error }: { error: unknown }) {
  const described = describeStudioError(error)
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-md text-center" role="alert">
        <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Luna Studio</p>
        <h1 className="mt-2 text-2xl font-semibold">{described.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{described.message}</p>
        <p className="mt-4 rounded-lg border bg-muted p-3 text-xs text-muted-foreground">
          Confirme que o Studio está em execução e recarregue <code>http://127.0.0.1:43110</code>.
        </p>
      </div>
    </main>
  )
}
