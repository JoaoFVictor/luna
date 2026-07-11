import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@xyflow/react/dist/style.css"

import type { BootstrapState } from "@/api/types"
import App from "@/App"
import { BootstrapFailure, BootstrapScreen } from "@/app/bootstrap-view"

export function mountStudio(bootstrap: Promise<BootstrapState>) {
  const container = document.getElementById("root")
  if (container === null) throw new Error("Luna Studio root element is missing")
  const root = createRoot(container)

  root.render(<BootstrapScreen />)

  void bootstrap
    .then((state) => {
      root.render(
        <StrictMode>
          <App bootstrap={state} />
        </StrictMode>,
      )
    })
    .catch((error: unknown) => {
      root.render(<BootstrapFailure error={error} />)
    })
}
