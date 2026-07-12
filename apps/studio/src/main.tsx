import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@xyflow/react/dist/style.css"

import type { BootstrapState } from "@/api/types"
import App from "@/App"
import { BootstrapFailure, BootstrapScreen } from "@/app/bootstrap-view"

// Start in the Luna theme unless the user explicitly chose the light theme.
// This runs before React mounts so the shell never flashes a second palette.
const storedTheme = window.localStorage.getItem("luna-theme")
document.documentElement.classList.toggle("dark", storedTheme !== "light")

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
