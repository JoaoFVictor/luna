import { studioApi } from "@/api/client"
import { installBrowserErrorPolicy } from "@/app/browser-error-policy"
import "@/index.css"

// Install before the application and third-party graph renderer mount so this
// boundary remains the canonical classifier for browser-generated notices.
installBrowserErrorPolicy()

// Bootstrap restores an existing cookie and transparently creates a
// loopback-only local session when this browser has none.
const bootstrap = studioApi.bootstrap()
// Mark an early network rejection as observed while the UI chunk is loading;
// mountStudio still receives the original promise and renders the real error.
void bootstrap.catch(() => undefined)

void import("@/main")
  .then(({ mountStudio }) => mountStudio(bootstrap))
  .catch(() => {
    const container = document.getElementById("root")
    if (container !== null) {
      container.textContent =
        "O Luna Studio não conseguiu carregar a interface. Reinicie o servidor local e tente novamente."
    }
  })
