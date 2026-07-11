import { Component, type ErrorInfo, type ReactNode } from "react"

type State = { failed: boolean }

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Luna Studio render failure", error, info.componentStack)
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-svh items-center justify-center p-6">
          <div className="max-w-md text-center">
            <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Luna Studio</p>
            <h1 className="mt-2 text-2xl font-semibold">A interface não pôde ser renderizada</h1>
            <p className="mt-2 text-sm text-muted-foreground">Recarregue o Studio. Se o problema persistir, use o request log do servidor local para diagnóstico.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Recarregar</button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
